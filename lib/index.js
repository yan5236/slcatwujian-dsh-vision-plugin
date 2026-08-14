/**
 * @dsh-local/vision-bridge — 图片理解桥
 * 让不支持图片输入的主模型通过已配置的视觉模型理解图片。
 * Host half: llm/stream 自动桥接 + 发送放行补丁 + vision_ask 工具 +
 * 配置存储（storage hub KV）+ webServer RPC 路由。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const mediaTypeForPath = (path) => {
  const p = String(path).toLowerCase()
  if (p.endsWith('.png')) return 'image/png'
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg'
  if (p.endsWith('.webp')) return 'image/webp'
  if (p.endsWith('.gif')) return 'image/gif'
  return undefined
}

export const name = 'vision-bridge'
// webServer/settings 必须为硬依赖:loader 并行挂载所有条目,ctx.get() 在服务
// 晚挂载的竞态下会拿到 undefined 并静默跳过 RPC 路由注册(此前
// /vision-bridge/rpc 一直落空)。inject 让 fiber 停靠等待服务就绪后再执行 apply。
export const inject = ['llm', 'webServer', 'settings']

export function apply(ctx) {
  const llm = ctx.llm
  const systemPrompt = ctx.get('systemPrompt')
  const attachments = ctx.get('attachments')
  const fs = ctx.get('fs')
  const settings = ctx.get('settings')
  const storage = ctx.get('storage')
  const timer = ctx.get('timer')
  const webServer = ctx.get('webServer')

  const BRIDGE_MARK = Symbol('visionBridge.bridged')
  const config = { provider: '', model: '', maxTokens: 1200, autoBridge: true }
  const refsById = new Map()
  const descCache = new Map()
  const capCache = new Map()
  let unit = null
  let storageError = null
  let lastPersisted = false
  let modelInfoOriginal = null
  let modelInfoHadOwn = false
  let modelInfoPatched = false

  const rawResolveModelInfo = (provider, model, signal) => modelInfoOriginal === null
    ? llm.resolveModelInfo(provider, model, signal)
    : modelInfoOriginal.call(llm, provider, model, signal)

  const CONFIG_UNIT = { name: 'vision_bridge', version: 1, tables: ['config'], hasGlobal: false }

  async function openConfigUnit() {
    if (storage === undefined) return null
    let backend
    try {
      backend = storage.backend.get('json')
    } catch (e) {
      storageError = e && e.message ? e.message : String(e)
      return null
    }
    if (backend === undefined || backend.kv === undefined) {
      storageError = 'json 后端未提供 kv 能力'
      return null
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await backend.kv.open(CONFIG_UNIT)
      } catch (e) {
        const msg = e && e.message ? e.message : String(e)
        if (msg.indexOf('already open') >= 0 && attempt < 3 && timer !== undefined) {
          await timer.timeout(300 * (attempt + 1))
          continue
        }
        storageError = msg
        return null
      }
    }
    return null
  }

  async function loadPersistedConfig() {
    unit = await openConfigUnit()
    if (unit === null) return false
    try {
      const snap = await unit.loadAll()
      const rec = snap && snap.tables && snap.tables.config ? snap.tables.config.main : undefined
      if (rec && typeof rec === 'object') {
        if (typeof rec.provider === 'string') config.provider = rec.provider
        if (typeof rec.model === 'string') config.model = rec.model
        if (Number.isFinite(rec.maxTokens)) config.maxTokens = Math.max(200, Math.min(8000, Math.floor(rec.maxTokens)))
        if (typeof rec.autoBridge === 'boolean') config.autoBridge = rec.autoBridge
        return true
      }
      return false
    } catch (e) {
      storageError = e && e.message ? e.message : String(e)
      return false
    }
  }

  async function persistConfig() {
    if (unit === null) return false
    try {
      await unit.putRecord('config', 'main', {
        provider: config.provider,
        model: config.model,
        maxTokens: config.maxTokens,
        autoBridge: config.autoBridge
      })
      lastPersisted = true
      return true
    } catch (e) {
      lastPersisted = false
      storageError = e && e.message ? e.message : String(e)
      return false
    }
  }

  const persistedReady = (async () => {
    try {
      return await loadPersistedConfig()
    } catch (e) {
      return false
    }
  })()

  // ---- 发送放行补丁：让 api-proxy 的 prompt 门认为当前模型支持图片输入，
  // 图片进入会话后由本插件的 llm/stream 桥接接管（自身判断使用原始能力数据）。 ----
  function installAdmissionPatch() {
    if (modelInfoPatched) return
    try {
      modelInfoOriginal = llm.resolveModelInfo
      modelInfoHadOwn = Object.prototype.hasOwnProperty.call(llm, 'resolveModelInfo')
      llm.resolveModelInfo = async function (provider, model, signal) {
        const info = await modelInfoOriginal.call(llm, provider, model, signal)
        if (info && Array.isArray(info.inputModalities) && info.inputModalities.indexOf('image') < 0) {
          return Object.assign({}, info, { inputModalities: info.inputModalities.concat(['image']) })
        }
        return info
      }
      modelInfoPatched = true
    } catch (e) {
      console.error('[vision-bridge] 无法安装发送放行补丁', e && e.message ? e.message : e)
    }
  }

  ctx.effect(() => {
    installAdmissionPatch()
    return () => {
      if (!modelInfoPatched) return
      try {
        if (modelInfoHadOwn) llm.resolveModelInfo = modelInfoOriginal
        else delete llm.resolveModelInfo
      } catch (e) {}
      modelInfoPatched = false
    }
  })

  ctx.effect(() => () => {
    if (unit !== null) {
      const u = unit
      unit = null
      u.close().catch(() => {})
    }
  })

  const COORD_SYSTEM = '你是专业的图片分析助手。你收到的每张图片都附带其真实像素尺寸（宽×高）。位置必须用像素坐标描述：原点在图片左上角 (0,0)，x 轴向右增大，y 轴向下增大。禁止使用「左上角」「右下角」「中间」「顶部」「底部」等模糊方位词，任何位置都必须给出具体像素坐标。元素定位格式：中心点 (cx, cy) 与边界框 [x1, y1, x2, y2]，其中 (x1, y1) 为左上角，(x2, y2) 为右下角。'

  const autoQuestion = (ref) => '请详细分析这张图片（真实尺寸 ' + ref.width + '×' + ref.height + ' 像素）。要求：1) 概括图片整体内容（类型、场景、风格）；2) 逐一列出画面中的主要物体、文字、UI 元素，每个都给出中心点 (cx, cy) 与边界框 [x1, y1, x2, y2] 像素坐标（原点为图片左上角 0,0）；3) 逐字转录所有可见文字并给出所在区域边界框；4) 描述与位置相关的状态细节（颜色、高亮、选中态等）。只输出描述正文。'

  const UNCONFIGURED_TEXT = '收到图片。当前主模型不支持图片输入，而「图片理解」插件尚未配置视觉模型。\n请打开 设置 → 图片理解：先在 设置 → 模型 中确认已添加支持图片输入的模型提供方，再选择它作为视觉模型并保存，然后重新发送图片。'

  const FAILED_TEXT = '图片分析失败：'

  function collectImages(messages) {
    const out = []
    const seen = new Set()
    function walk(blocks) {
      for (const b of Array.isArray(blocks) ? blocks : []) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'image' && b.attachment && typeof b.attachment.attachmentId === 'string') {
          const id = b.attachment.attachmentId
          if (!seen.has(id)) { seen.add(id); out.push(b.attachment) }
        }
        if (Array.isArray(b.content)) walk(b.content)
      }
    }
    for (const m of Array.isArray(messages) ? messages : []) walk(m.content)
    return out
  }

  async function routeSupportsImage(provider, model, signal) {
    const key = provider + '\u0000' + model
    if (capCache.has(key)) return capCache.get(key)
    let result = false
    try {
      const info = await rawResolveModelInfo(provider, model, signal)
      result = Array.isArray(info.inputModalities) ? info.inputModalities.indexOf('image') >= 0 : false
    } catch (e) {
      if (signal && signal.aborted) throw e
      result = false
    }
    capCache.set(key, result)
    return result
  }

  async function streamText(stream) {
    const acc = new Map()
    let finishKind = null
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        const kind = chunk.type === 'text-delta' ? 'text' : 'reasoning'
        const entry = acc.get(chunk.index)
        if (entry === undefined) acc.set(chunk.index, { type: kind, text: chunk.text, closed: false })
        else if (entry.closed !== true) {
          entry.type = kind
          entry.text += chunk.text
        }
      } else if (chunk.type === 'block-end') {
        const b = chunk.block
        if (b && (b.type === 'text' || b.type === 'reasoning') && typeof b.text === 'string') {
          acc.set(chunk.index, { type: b.type, text: b.text, closed: true })
        }
      } else if (chunk.type === 'finish') {
        finishKind = chunk.reason ? chunk.reason.kind : null
        if (chunk.reason && chunk.reason.kind === 'error') throw new Error(chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : '视觉模型调用失败')
        if (chunk.reason && chunk.reason.kind === 'aborted') { const e = new Error('调用已中止'); e.aborted = true; throw e }
      }
    }
    const indexes = Array.from(acc.keys()).sort((a, b) => a - b)
    let text = ''
    let reasoning = ''
    for (const i of indexes) {
      const entry = acc.get(i)
      if (entry.type === 'text') text += entry.text
      else reasoning += entry.text
    }
    const result = (text || '').trim() || (reasoning || '').trim()
    if (!result) throw new Error('视觉模型返回了空内容（finish=' + String(finishKind) + '；该模型可能不支持图片输入，或没有输出任何可见文本与思考内容）')
    return result
  }

  async function describeImage(ref, question, signal) {
    const request = {
      provider: config.provider,
      model: config.model,
      system: COORD_SYSTEM,
      maxTokens: config.maxTokens,
      signal: signal,
      messages: [{
        id: 'vision-bridge-user',
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'image', attachment: ref },
          { type: 'text', text: question }
        ]
      }]
    }
    Object.defineProperty(request, BRIDGE_MARK, { value: true, enumerable: false })
    const text = await streamText(llm.stream(request))
    if (!text || text.trim() === '') throw new Error('视觉模型返回了空内容（该模型可能不支持图片输入）')
    return text.trim()
  }

  const NOTICE_MARK = '【图片描述·vision-bridge·attachmentId='

  const labelOf = (a) => NOTICE_MARK + a.attachmentId + '】图片' +
    (a.name ? ' ' + a.name : '') + '，' + a.width + '×' + a.height + 'px，已由视觉模型分析；坐标原点为图片左上角 (0,0)，单位像素'

  function rebuildMessages(messages, descriptions) {
    const covered = new Set()
    const hasMark = (id) => {
      const mark = NOTICE_MARK + id + '】'
      let found = false
      const scan = (blocks) => {
        for (const b of Array.isArray(blocks) ? blocks : []) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'text' && typeof b.text === 'string' && b.text.indexOf(mark) >= 0) { found = true; return }
          if (Array.isArray(b.content)) { scan(b.content); if (found) return }
        }
      }
      for (const m of messages) { scan(m.content); if (found) break }
      return found
    }
    for (const id of descriptions.keys()) if (hasMark(id)) covered.add(id)
    function mapBlocks(blocks) {
      const out = []
      for (const b of blocks) {
        if (!b || typeof b !== 'object') { out.push(b); continue }
        if (b.type === 'image' && b.attachment) {
          const a = b.attachment
          if (covered.has(a.attachmentId)) {
            out.push({ type: 'text', text: '【图片 attachmentId=' + a.attachmentId + ' 的视觉描述见上文 CONTEXT 消息】' })
            continue
          }
          const desc = descriptions.get(a.attachmentId)
          out.push({ type: 'text', text: labelOf(a) + '\n' + (desc !== undefined ? desc : '[分析失败]') })
          continue
        }
        if (b.type === 'tool-result' && Array.isArray(b.content)) {
          out.push(Object.assign({}, b, { content: mapBlocks(b.content) }))
          continue
        }
        out.push(b)
      }
      return out
    }
    return messages.map((m) => {
      let hit = false
      function scan(blocks) {
        for (const b of Array.isArray(blocks) ? blocks : []) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'image') { hit = true; return }
          if (Array.isArray(b.content)) { scan(b.content); if (hit) return }
        }
      }
      scan(m.content)
      if (!hit) return m
      return Object.assign({}, m, { content: mapBlocks(m.content) })
    })
  }

  async function* synthReply(text) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  ctx.on('llm/stream', function (options, next) {
    if (options[BRIDGE_MARK] === true) return next()
    if (attachments === undefined) return next()
    const refs = collectImages(options.messages)
    if (refs.length === 0) return next()
    const signal = options.signal
    return (async function* () {
      await persistedReady
      for (const ref of refs) if (!refsById.has(ref.attachmentId)) refsById.set(ref.attachmentId, ref)
      let supports = false
      try {
        supports = await routeSupportsImage(options.provider, options.model, signal)
      } catch (e) {
        if (signal && signal.aborted) throw e
        supports = false
      }
      if (supports) { yield* next(); return }
      if (config.autoBridge !== true) {
        const ids = refs.map((r) => r.attachmentId).join(', ')
        yield* synthReply('图片已收到（attachmentId=' + ids + '），但「图片理解」插件的自动分析已关闭，当前主模型无法直接处理图片。可打开 设置 → 图片理解 重新开启自动分析，或让助手调用 vision_ask 工具（传入上面的 attachmentId）来分析。')
        return
      }
      if (!config.provider || !config.model) {
        yield* synthReply(UNCONFIGURED_TEXT)
        return
      }
      try {
        const descriptions = new Map()
        const agents = ctx.get('agents')
        const sessionId = options.sessionId
        const noticeAgent = agents !== undefined && typeof sessionId === 'string' ? agents.get(sessionId) : undefined
        for (const ref of refs) {
          const id = ref.attachmentId
          if (descCache.has(id)) { descriptions.set(id, descCache.get(id)); continue }
          try {
            const text = await describeImage(ref, autoQuestion(ref), signal)
            descCache.set(id, text)
            descriptions.set(id, text)
            if (noticeAgent !== undefined && typeof noticeAgent.inject === 'function') {
              const label = labelOf(ref)
              const summary = '图片已由视觉模型分析：' + (ref.name || ref.attachmentId)
              noticeAgent.inject(createUserMessage({
                content: [{ type: 'text', text: label + '\n' + text }],
                source: { kind: 'plugin', plugin: 'vision-bridge', form: 'notice', summary: summary.length > 120 ? summary.slice(0, 117) + '…' : summary }
              }))
            }
          } catch (e) {
            if (signal && signal.aborted) throw e
            console.error('[vision-bridge] 描述图片失败', id, e && e.message ? e.message : e)
            descriptions.set(id, '[图片分析失败：' + (e && e.message ? e.message : String(e)) + ']')
          }
        }
        const rebuilt = Object.assign({}, options, { messages: rebuildMessages(options.messages, descriptions) })
        Object.defineProperty(rebuilt, BRIDGE_MARK, { value: true, enumerable: false })
        yield* llm.stream(rebuilt)
      } catch (e) {
        if (signal && signal.aborted) throw e
        console.error('[vision-bridge] 流处理失败', e && e.message ? e.message : e)
        yield* synthReply(FAILED_TEXT + (e && e.message ? e.message : String(e)) + '。请检查 设置 → 图片理解 的视觉模型配置后重试。')
      }
    })()
  })

  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'vision-bridge:guide',
      order: 199,
      text: '【图片理解（vision-bridge 插件）】\n用户消息中上传的图片会被自动交给已配置的视觉模型分析，并以文字形式注入消息（图片块替换为描述）。坐标约定：原点在图片左上角 (0,0)，x 轴向右、y 轴向下，单位为像素；描述中会给出元素中心点 (cx, cy) 与边界框 [x1, y1, x2, y2]。\n- 每条注入描述的开头标签包含该图片的 attachmentId 与真实像素尺寸。\n- 当用户的问题需要更多细节（特定区域、未覆盖的元素、文字校对等）时，调用 vision_ask 工具：attachmentId 从描述标签中获取；也可以用 path 直接分析本地图片文件。\n- 若消息中没有注入图片描述，说明视觉模型未配置或分析失败，请引导用户到 设置 → 图片理解 检查配置。'
    }))
  }

  const visionTool = defineTool({
    name: 'vision_ask',
    description: '向配置的视觉模型询问图片内容，返回带像素坐标的详细描述（坐标原点为图片左上角 0,0，x 向右、y 向下，单位像素）。当用户追问图片细节、特定区域内容、图中文字或物体位置，而自动注入的图片描述不足时调用。attachmentId 从消息中注入的图片描述标签（attachmentId=...）获取；也可用 path 指定本地图片文件（png/jpeg/webp/gif）。',
    parameters: {
      attachmentId: { type: 'string', description: '图片附件 ID（可选；从消息中注入的图片描述标签 attachmentId=... 获取）' },
      path: { type: 'string', description: '本地图片文件的绝对路径（可选；与 attachmentId 二选一）' },
      question: { type: 'string', required: true, description: '要询问视觉模型的问题（涉及位置时会自动要求像素坐标）' }
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: String(value) }]
    },
    async execute(args, exec) {
      if (!config.provider || !config.model) throw new Error('图片理解插件尚未配置视觉模型：请先在 设置 → 图片理解 中选择支持图片输入的模型')
      let ref
      if (args.attachmentId) {
        ref = refsById.get(args.attachmentId)
        if (ref === undefined) throw new Error('找不到图片附件 ' + args.attachmentId + '（插件重启后记录会丢失）。请重新发送图片，或改用 path 参数指定本地文件')
      } else if (args.path) {
        if (fs === undefined) throw new Error('文件服务不可用，无法读取本地图片')
        if (attachments === undefined) throw new Error('附件服务不可用，无法读取本地图片')
        const mediaType = mediaTypeForPath(args.path)
        if (mediaType === undefined) throw new Error('无法识别的图片格式（支持 png/jpeg/webp/gif）')
        const target = await fs.resolve(args.path, { signal: exec.signal })
        const bytes = await fs.readBytes(target, exec.signal, 20 * 1024 * 1024)
        const name = String(args.path).split(/[\\/]/).pop()
        ref = await attachments.saveImage({ data: bytes, mediaType: mediaType, name: name })
      } else {
        throw new Error('必须提供 attachmentId 或 path 之一')
      }
      return describeImage(ref, args.question, exec.signal)
    }
  })
  const tools = ctx.get('tools')
  if (tools !== undefined) tools.register(visionTool)

  async function modelsOf(provider) {
    let models = []
    if (typeof provider === 'string' && provider !== '') {
      try {
        const list = await llm.listModels(provider)
        models = list.map((m) => ({
          id: m.id,
          name: m.name,
          inputModalities: Array.isArray(m.inputModalities) ? m.inputModalities : null
        }))
      } catch (e) {
        models = []
      }
    }
    return models
  }

  async function statePayload() {
    await persistedReady
    const providers = []
    try {
      for (const p of llm.listProviders()) providers.push({ id: p.id, name: p.name })
    } catch (e) {}
    return {
      config: { provider: config.provider, model: config.model, maxTokens: config.maxTokens, autoBridge: config.autoBridge },
      providers: providers,
      models: await modelsOf(config.provider),
      configured: Boolean(config.provider && config.model),
      attachmentIndex: refsById.size,
      storage: unit !== null ? 'ok' : 'unavailable',
      storageError: storageError,
      persisted: lastPersisted,
      admissionPatched: modelInfoPatched
    }
  }

  function declarableEntry(provider) {
    try {
      const list = llm.listConfigurableProviders()
      const entry = list.find((e) => e.provider === provider)
      if (entry !== undefined && entry.settingsNs === 'llm-pi-ai') return entry
    } catch (e) {}
    return null
  }

  async function testVision() {
    await persistedReady
    if (!config.provider || !config.model) return { ok: false, message: '尚未选择视觉模型' }
    try {
      const info = await rawResolveModelInfo(config.provider, config.model)
      const modalities = Array.isArray(info.inputModalities) ? info.inputModalities : null
      return {
        ok: true,
        provider: config.provider,
        model: config.model,
        supportsImage: modalities !== null ? modalities.indexOf('image') >= 0 : null,
        modalities: modalities,
        canDeclareImage: declarableEntry(config.provider) !== null,
        contextWindow: info.context ? info.context.contextWindow : null,
        defaultMaxTokens: typeof info.defaultMaxTokens === 'number' ? info.defaultMaxTokens : null
      }
    } catch (e) {
      return { ok: false, message: e && e.message ? e.message : String(e) }
    }
  }

  async function enableImage() {
    const provider = config.provider
    if (!provider) return { ok: false, message: '尚未选择模型提供方' }
    if (settings === undefined) return { ok: false, message: 'settings 服务不可用' }
    if (settings.writable !== true) return { ok: false, message: '当前 settings 不可写' }
    const entry = declarableEntry(provider)
    if (entry === null) return { ok: false, message: '该提供方不支持此操作（仅 pi-ai 系提供方可声明输入模态）' }
    try {
      const section = settings.get(entry.settingsNs)
      const path = Array.isArray(entry.settingsPath) && entry.settingsPath.length > 0 ? entry.settingsPath : ['providers', provider]
      let node = section
      for (const key of path) node = node && typeof node === 'object' ? node[key] : undefined
      const current = node && Array.isArray(node.defaultInput) ? node.defaultInput.filter((x) => typeof x === 'string') : []
      const next = Array.from(new Set(current.concat(['image'])))
      await settings.mutate(entry.settingsNs, [{ op: 'set', path: path.concat(['defaultInput']), value: next }])
      capCache.clear()
      let nowSupports = false
      try {
        const info = await rawResolveModelInfo(config.provider, config.model)
        const mods = Array.isArray(info.inputModalities) ? info.inputModalities : []
        nowSupports = mods.indexOf('image') >= 0
      } catch (e) {}
      return {
        ok: true,
        message: nowSupports ? '已写入：该提供方现在声明支持图片输入（defaultInput=' + JSON.stringify(next) + '），请再次点击「测试模型」验证。' : '已将 image 写入提供方的 defaultInput（' + JSON.stringify(next) + '），但所选模型条目自身显式声明了输入模态且未包含 image，可能需要直接编辑该模型的 input 字段。',
        nowSupports: nowSupports,
        defaultInput: next
      }
    } catch (e) {
      return { ok: false, message: e && e.message ? e.message : String(e) }
    }
  }

  // ---- Client RPC（网页端 fetch 调用） ----
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/vision-bridge/rpc',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, message: 'method not allowed' }))
            return
          }
          let body = ''
          for await (const chunk of req) body += chunk
          let payload = {}
          try {
            payload = JSON.parse(body || '{}')
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, message: 'invalid json body' }))
            return
          }
          const method = payload.method
          const args = payload.args || {}
          let result
          if (method === 'get-state') {
            result = await statePayload()
          } else if (method === 'list-models') {
            result = { models: await modelsOf(args.provider) }
          } else if (method === 'set-config') {
            const a = args
            if (typeof a.provider === 'string') config.provider = a.provider
            if (typeof a.model === 'string') config.model = a.model
            if (Number.isFinite(a.maxTokens)) config.maxTokens = Math.max(200, Math.min(8000, Math.floor(a.maxTokens)))
            if (typeof a.autoBridge === 'boolean') config.autoBridge = a.autoBridge
            lastPersisted = await persistConfig()
            result = await statePayload()
          } else if (method === 'test') {
            result = await testVision()
          } else if (method === 'enable-image') {
            result = await enableImage()
          } else {
            res.writeHead(404, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, message: 'unknown method: ' + String(method) }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, message: e && e.message ? e.message : String(e) }))
        }
      }
    }))
  }
}
