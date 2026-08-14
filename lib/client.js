window.__ModuleLoader__.load({
	id: "@dsh-local/vision-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		const CSS = [
			".vb-section{box-sizing:border-box;max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}",
			".vb-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}",
			".vb-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}",
			".vb-dimmed{color:var(--dsw-alias-label-dimmed);margin:0;font-size:12px;line-height:18px}",
			".vb-notice{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}",
			".vb-error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}",
			".vb-saved{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}",
			".vb-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:12px;padding:12px 14px;display:flex}",
			".vb-rowHead{align-items:center;gap:10px;display:flex}",
			".vb-rowName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}",
			".vb-rowTag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px}",
			".vb-dot{box-sizing:border-box;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block}",
			".vb-dot.ok{background:var(--dsw-alias-state-success-primary)}",
			".vb-dot.warn{background:var(--dsw-alias-state-warn-primary)}",
			".vb-dot.err{background:var(--dsw-alias-state-error-primary)}",
			".vb-field{flex-direction:column;gap:6px;display:flex}",
			".vb-label{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}",
			".vb-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:14px;line-height:22px}",
			"select.vb-input{cursor:pointer;max-width:240px;appearance:none;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px;padding-right:32px}",
			".vb-input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}",
			".vb-input:disabled{opacity:.6;cursor:default}",
			".vb-checkRow{align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;display:flex;cursor:pointer}",
			".vb-checkRow input{accent-color:var(--dsw-alias-brand-primary);margin:0}",
			".vb-btnRow{align-items:center;gap:8px;display:flex;flex-wrap:wrap}",
			".vb-btn{box-sizing:border-box;height:36px;font:inherit;cursor:pointer;border:none;border-radius:18px;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}",
			".vb-btn.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}",
			".vb-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill-hover)}",
			".vb-btn.secondary{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:transparent}",
			".vb-btn.secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".vb-btn:disabled{opacity:.5;cursor:default}"
		].join("");

		const rpc = async (method, args) => {
			const res = await fetch("/vision-bridge/rpc", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ method, args: args ?? {} })
			});
			return res.json();
		};

		function VisionSettings() {
			const el = React.createElement;
			const [state, setState] = React.useState(null);
			const [form, setForm] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const [test, setTest] = React.useState(null);

			React.useEffect(() => {
				let alive = true;
				rpc("get-state", {}).then((s) => {
					if (!alive) return;
					setState(s);
					setForm({ provider: s.config.provider, model: s.config.model, maxTokens: s.config.maxTokens, autoBridge: s.config.autoBridge });
				}).catch((e) => {
					if (!alive) return;
					setNotice({ kind: "err", text: "读取配置失败：" + (e && e.message ? e.message : String(e)) });
				});
				return () => { alive = false; };
			}, []);

			if (form === null || state === null) {
				return el("div", { className: "vb-section" }, el("p", { className: "vb-intro" }, notice ? notice.text : "加载中…"));
			}

			const providers = Array.isArray(state.providers) ? state.providers : [];
			const models = Array.isArray(state.models) ? state.models : [];
			const configured = state.configured === true;

			const pickProvider = (id) => {
				setForm(Object.assign({}, form, { provider: id, model: "" }));
				setTest(null);
				setNotice(null);
				rpc("list-models", { provider: id }).then((r) => {
					setState((s) => Object.assign({}, s, { models: Array.isArray(r.models) ? r.models : [] }));
				}).catch(() => {});
			};

			const save = () => {
				setBusy(true);
				setNotice(null);
				rpc("set-config", form).then((s) => {
					setState(s);
					setNotice({ kind: "ok", text: s.persisted === true ? "已保存，并已持久化到 DSH 存储（DSH 重启后自动恢复）。" : "已保存。注意：本次持久化未生效" + (s.storageError ? "（" + s.storageError + "）" : "") + "，配置仅在插件本次运行期间有效。" });
				}).catch((e) => {
					setNotice({ kind: "err", text: "保存失败：" + (e && e.message ? e.message : String(e)) });
				}).finally(() => setBusy(false));
			};

			const runTest = () => {
				setBusy(true);
				setTest(null);
				rpc("test", {}).then((r) => setTest(r)).catch((e) => setTest({ ok: false, message: e && e.message ? e.message : String(e) })).finally(() => setBusy(false));
			};

			const enableImage = () => {
				setBusy(true);
				setNotice(null);
				rpc("enable-image", {}).then((r) => {
					if (r.ok === true) {
						setNotice({ kind: "ok", text: r.message });
					} else {
						setNotice({ kind: "err", text: r.message || "操作失败" });
					}
					return rpc("get-state", {});
				}).then((s) => {
					setState(s);
				}).catch((e) => {
					setNotice({ kind: "err", text: "操作失败：" + (e && e.message ? e.message : String(e)) });
				}).finally(() => setBusy(false));
			};

			const field = (label, control, hint) => el("div", { className: "vb-field" },
				el("div", { className: "vb-label" }, label),
				control,
				hint ? el("p", { className: "vb-dimmed" }, hint) : null);

			const modelOptions = models.map((m) => {
				const declared = Array.isArray(m.inputModalities);
				const capable = declared && m.inputModalities.indexOf("image") >= 0;
				return el("option", { key: m.id, value: m.id }, (m.name || m.id) + (declared && !capable ? "（未声明图片输入）" : ""));
			});

			const modelControl = models.length > 0
				? el("select", { className: "vb-input", value: form.model, disabled: busy || form.provider === "", onChange: (e) => setForm(Object.assign({}, form, { model: e.target.value })) },
						el("option", { value: "" }, "— 请选择 —"),
						modelOptions)
				: el("input", { className: "vb-input", value: form.model, disabled: busy, placeholder: "该提供方未返回模型列表，请手动输入模型 ID", onChange: (e) => setForm(Object.assign({}, form, { model: e.target.value })) });

			const statusTag = configured
				? el("span", { className: "vb-rowTag" }, el("span", { className: "vb-dot ok", style: { marginRight: 5, verticalAlign: "middle" } }), "已配置")
				: el("span", { className: "vb-rowTag" }, el("span", { className: "vb-dot warn", style: { marginRight: 5, verticalAlign: "middle" } }), "未配置");

			let testBlock = null;
			if (test !== null) {
				if (test.ok === true) {
					const cap = test.supportsImage;
					testBlock = el("div", null,
						el("p", { className: cap === true ? "vb-saved" : cap === false ? "vb-error" : "vb-notice" },
							cap === true ? "✓ 模型 " + test.model + " 声明支持图片输入，可以直接使用。" :
							cap === false ? "✗ 模型 " + test.model + " 未声明图片输入，视觉调用会被拒绝。" :
							"模型 " + test.model + " 未声明输入模态，无法确认是否支持图片输入。"),
						test.contextWindow ? el("p", { className: "vb-dimmed" }, "上下文窗口：" + test.contextWindow) : null,
						typeof test.defaultMaxTokens === "number" ? el("p", { className: "vb-dimmed" }, "默认最大输出：" + test.defaultMaxTokens) : null,
						cap === false && test.canDeclareImage === true
							? el("div", null,
									el("p", { className: "vb-dimmed" }, "说明：DSH 的「模型」设置页目前没有修改输入模态的入口，模型未声明图片输入时视觉调用会被拒绝。点下方按钮会把 image 加入该提供方的输入模态声明（写入 DSH 设置，持久有效）。"),
									el("button", { className: "vb-btn secondary", disabled: busy, onClick: enableImage }, "为该提供方声明图片输入"),
									el("p", { className: "vb-dimmed" }, "完成后请再次点击「测试模型」验证。"))
							: null,
						cap === false && test.canDeclareImage !== true
							? el("p", { className: "vb-dimmed" }, "该提供方无法在插件中修改输入模态（非 pi-ai 适配器），请在提供方配置处确认。")
							: null);
				} else {
					testBlock = el("p", { className: "vb-error" }, "测试失败：" + (test.message || ""));
				}
			}

			const storageLine = state.storage === "ok"
				? "配置已持久化到 DSH 存储（storage: json），DSH 重启后自动恢复。"
				: "配置持久化不可用" + (state.storageError ? "（" + state.storageError + "）" : "") + "：重启后需重新设置。";

			return el("div", { className: "vb-section" },
				el("p", { className: "vb-title" }, "图片理解"),
				el("p", { className: "vb-intro" },
					"主模型不支持图片输入时，本插件把消息中的图片交给下方选定的视觉模型分析，生成带像素坐标的文字描述（坐标原点为图片左上角 0,0，x 向右、y 向下），主模型基于描述理解图片。"),
				el("p", { className: "vb-notice" },
					"本插件会同时放行网页端的图片发送拦截（默认对不支持图片的模型会提示「当前模型不支持图片输入」并拒绝发送）：消息可以正常发出，图片由插件接管分析。"),
				providers.length === 0 ? el("p", { className: "vb-notice" }, "当前没有已注册的模型提供方。请先在 设置 → 模型 中添加支持图片输入的提供方。") : null,
				el("div", { className: "vb-card" },
					el("div", { className: "vb-rowHead" },
						el("span", { className: "vb-rowName" }, "视觉模型配置"),
						statusTag),
					field("模型提供方", el("select", { className: "vb-input", value: form.provider, disabled: busy, onChange: (e) => pickProvider(e.target.value) },
						el("option", { value: "" }, "— 请选择 —"),
						providers.map((p) => el("option", { key: p.id, value: p.id }, p.name || p.id))),
						"需在 设置 → 模型 中已配置好支持图片输入的提供方"),
					field("视觉模型", modelControl, models.length === 0 ? "模型列表为空时可直接输入模型 ID，保存后点「测试模型」验证" : "列表来自提供方注册的模型；若模型实际支持视觉却显示（未声明图片输入），保存后点「测试模型」，在结果处可一键声明"),
					field("描述最大 token 数（200–8000）", el("input", { className: "vb-input", type: "number", min: 200, max: 8000, style: { maxWidth: 160 }, value: String(form.maxTokens), disabled: busy, onChange: (e) => setForm(Object.assign({}, form, { maxTokens: parseInt(e.target.value, 10) || 1200 })) })),
					el("label", { className: "vb-checkRow" },
						el("input", { type: "checkbox", checked: form.autoBridge === true, disabled: busy, onChange: (e) => setForm(Object.assign({}, form, { autoBridge: e.target.checked })) }),
						"自动分析消息中的图片（关闭后图片虽可发送，但主模型无法直接处理，助手会提示用 vision_ask 分析）"),
					el("div", { className: "vb-btnRow" },
						el("button", { className: "vb-btn primary", disabled: busy, onClick: save }, "保存"),
						el("button", { className: "vb-btn secondary", disabled: busy || !configured, onClick: runTest }, "测试模型"),
						el("span", { className: "vb-dimmed" }, state.attachmentIndex > 0 ? "已索引图片附件：" + state.attachmentIndex : ""))),
				notice ? el("p", { className: notice.kind === "ok" ? "vb-saved" : "vb-error" }, notice.text) : null,
				testBlock,
				el("p", { className: "vb-dimmed" }, storageLine),
				el("p", { className: "vb-dimmed" },
					"追问图片细节：助手可调用 vision_ask 工具，传入消息中图片描述标签里的 attachmentId（或本地图片路径）向视觉模型提问。")
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			if (typeof document === "undefined") return;
			const style = document.createElement("style");
			style.dataset.plugin = "@dsh-local/vision-bridge";
			style.dataset.pluginCss = "@dsh-local/vision-bridge/VisionSettings.css";
			style.textContent = CSS;
			document.head.appendChild(style);
			slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "vision-bridge", order: 25, label: "图片理解" },
				(props) => React.createElement(VisionSettings, props)
			));
			return () => {
				style.remove();
			};
		}

		exports.apply = apply;
		return module.exports;
	}
});
