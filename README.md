# slcatwujian 的 DSH 图片理解插件（vision-bridge）

让不支持图片输入的主模型也能"看懂"图片 —— 插件会自动把消息中的图片交给已配置的视觉模型分析，生成**带像素坐标系**的文字描述注入会话，主模型基于描述理解图片，无需更换主模型。

> 包名：`@dsh-local/vision-bridge` ｜ 版本：1.0.0 ｜ 许可证：MIT

## 功能特性

- 🖼️ **自动图片桥接**：用户上传图片后，插件调用配置的视觉模型生成详细描述（内容概括、元素定位、文字转录、状态细节），并把消息中的图片块替换为文字描述，主模型照常回复。
- 🎯 **像素坐标体系**：所有元素位置都以像素坐标给出 —— 原点在图片左上角 `(0,0)`，x 轴向右、y 轴向下；元素定位格式为中心点 `(cx, cy)` 与边界框 `[x1, y1, x2, y2]`。
- 🔍 **`vision_ask` 追问工具**：助手在回答中需要更多图片细节时，可调用 `vision_ask` 工具向视觉模型追问（支持 `attachmentId` 或本地图片路径 `path` 两种入参）。
- 📤 **发送放行补丁**：自动解除网页端对"不支持图片输入模型"的图片发送拦截，消息可正常发出，由插件接管图片分析。
- ⚙️ **内置设置页**：在 设置 → 图片理解 中配置视觉模型提供方/模型、描述最大 token 数、自动分析开关，支持一键「测试模型」验证与「声明图片输入」。
- 💾 **配置持久化**：配置写入 DSH 存储（storage: json），DSH 重启后自动恢复。
- 🔁 **去重缓存**：同一图片在同一会话内只分析一次，描述结果缓存复用。

## 工作原理

```
用户发送图片 ──► DSH llm/stream ──► 插件拦截
                                      │
                    ┌─ 主模型支持图片？ ─┐
                    │ (读取原始能力数据) │
                  否 │                  │ 是
                    ▼                  ▼
        调用视觉模型生成描述 ◄─  直接透传，不干预
              │
              ▼
   图片块替换为文字描述（含 attachmentId 标签）
              │
              ▼
        注入主模型上下文，正常回复
```

插件通过 `llm/stream` 事件钩子实现桥接；同时为网页端 RPC（`/vision-bridge/rpc`）提供 `get-state` / `list-models` / `set-config` / `test` / `enable-image` 接口供设置页调用。

## 安装

1. 将本插件目录放入 DSH web profile 的本地包目录：

   ```text
   <profile>/packages/vision-bridge/
   ```

2. 在 profile 的 `cordis.patch.yml` 中注册插件（追加到 `insert` 列表）：

   ```yaml
   - insert:
       - id: vision-bridge
         name: '@dsh-local/vision-bridge'
   ```

3. 重新加载 DSH web 服务（或重启 DSH）。

### 依赖

- DSH（含 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`）
- 已配置至少一个**支持图片输入**的模型提供方（如 pi-ai 系适配器），用于充当视觉模型

## 配置

打开 **设置 → 图片理解**：

| 配置项 | 说明 |
| --- | --- |
| 模型提供方 | 选择已注册的模型提供方（需在 设置 → 模型 中提前配置） |
| 视觉模型 | 选择或手动输入支持图片输入的模型 ID |
| 描述最大 token 数 | 200–8000，默认 1200 |
| 自动分析消息中的图片 | 开启后图片自动交给视觉模型；关闭后助手会提示改用 `vision_ask` |

- **测试模型**：验证所选模型是否声明支持图片输入，并展示上下文窗口等信息。
- **声明图片输入**：当模型未声明 `image` 输入模态时（仅 pi-ai 系提供方支持），点击按钮将 `image` 写入提供方的 `defaultInput`，持久生效。

## 使用

- 直接发送图片，插件自动分析并注入描述；消息中的注入标签形如：

  > 【图片描述·vision-bridge·attachmentId=xxx】图片 name.png，1280×720px，已由视觉模型分析；坐标原点为图片左上角 (0,0)，单位像素

- 助手可调用 `vision_ask` 工具追问细节：

  ```text
  vision_ask(attachmentId="xxx", question="描述右上角区域的内容")
  vision_ask(path="C:/path/to/image.png", question="图片中有什么文字？")
  ```

## 目录结构

```text
slcatwujian-dsh-vision-plugin/
├── package.json        # 包定义（@dsh-local/vision-bridge）
├── lib/
│   ├── index.js        # Host 端：桥接、vision_ask 工具、RPC、配置持久化
│   └── client.js       # Web 客户端：设置页 UI（React）
└── README.md
```

## 许可证

[MIT](./LICENSE)
