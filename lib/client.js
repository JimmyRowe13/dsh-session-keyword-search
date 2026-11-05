window.__ModuleLoader__.load({
	id: "dsh-session-keyword-search",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;
		/** Channel registered by the host half. */
		const CHANNEL = "/dsh-session-keyword-search";
		/** Locale namespace owned by this panel. */
		const NS = "settings.sessionKeywordSearch";
		/** Copy for the optional in-panel strings when locale registration is unavailable. */		const en = {
			nav: "Session keyword search",
			title: "Session keyword search",
			description:
				"Substring search across every session, Chinese included. It replaces the sidebar search box; anything that fails falls back to the harness's own search.",
			indexPath: "Index file",
			sessions: "Sessions",
			messages: "Messages",
			size: "Indexed text",
			lastSync: "Last sync",
			takeover: "Search box",
			takeoverOn: "taken over",
			takeoverOff: "untouched",
			takenOverYes: "Active",
			takenOverNo: "Not active (the harness keeps its own search)",
			rebuild: "Rebuild index",
			rebuilding: "Rebuilding...",
			drop: "Delete index",
			dropping: "Deleting...",
			refresh: "Refresh",
			loading: "Loading...",
			lastError: "Last error",
			noError: "None",
			unreadable: "Unreadable sessions skipped",
			indexError: "Index error",
			lastQuery: "Last search",
			emptyHint: "Index",
			emptyHintValue: "Empty: nothing searched yet, use Rebuild to build it now.",
			failed: "Could not reach the host plugin",
			readOnly: "This deployment exposes no host connection, so the index cannot be inspected here."
		};
		const zh = {
			nav: "会话关键词检索",
			title: "会话关键词检索",
			description:
				"跨全部会话的子串检索，中文可用。它接管侧边栏搜索框；自身出问题时逐级回退到 DSH 原有搜索。",
			indexPath: "索引文件",
			sessions: "会话数",
			messages: "消息数",
			size: "索引文本",
			lastSync: "上次同步",
			takeover: "搜索框",
			takeoverOn: "已接管",
			takeoverOff: "未接管",
			takenOverYes: "生效中",
			takenOverNo: "未生效（仍使用 DSH 原有搜索）",
			rebuild: "重建索引",
			rebuilding: "重建中…",
			drop: "删除索引",
			dropping: "删除中…",
			refresh: "刷新",
			loading: "加载中…",
			lastError: "最近错误",
			noError: "无",
			unreadable: "无法读取、已跳过的会话",
			indexError: "索引错误",
			lastQuery: "上次搜索耗时",
			emptyHint: "索引",
			emptyHintValue: "为空：还没搜索过，点「重建索引」可立即建立。",
			failed: "无法连接主机侧插件",
			readOnly: "当前部署没有主机连接，无法在此查看索引状态。"
		};
		const styles = {
			section: { display: "flex", flexDirection: "column", gap: "14px", padding: "4px 0 24px" },
			title: { fontSize: "15px", fontWeight: 600, lineHeight: "22px" },
			description: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px", marginTop: "2px" },
			grid: { display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: "18px", rowGap: "6px", fontSize: "12px" },
			key: { color: "var(--dsw-alias-label-secondary)" },
			value: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", wordBreak: "break-all" },
			row: { display: "flex", gap: "8px", flexWrap: "wrap" },
			button: {
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "6px",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				fontSize: "12px",
				lineHeight: "18px",
				padding: "4px 12px"
			},
			danger: { color: "var(--dsw-alias-label-error, #d33)" },
			error: { color: "var(--dsw-alias-label-error, #d33)", fontSize: "12px", wordBreak: "break-all" }
		};

		function bytes(value) {
			const size = Number(value) || 0;
			if (size < 1024) return `${size} B`;
			if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
			return `${(size / 1024 / 1024).toFixed(2)} MB`;
		}

		/**
		 * Settings section for the keyword index.
		 *
		 * @param props - slot props: the browser connection and the translate seat.
		 * @returns the maintenance panel.
		 */
		function Section({ connection, t }) {
			const translate = typeof t === "function" ? t : (key) => en[key] ?? key;
			const [state, setState] = react.useState({ status: connection === undefined ? "unavailable" : "loading", data: undefined, error: undefined, busy: undefined });

			const load = react.useCallback(async () => {
				if (connection === undefined || connection?.rpc?.call === undefined) {
					setState({ status: "unavailable", data: undefined, error: undefined, busy: undefined });
					return;
				}
				setState((current) => ({ ...current, status: current.data === undefined ? "loading" : "ready", error: undefined }));
				try {
					const reply = await connection.rpc.call(CHANNEL, "status", {});
					if (reply !== undefined && reply !== null && reply.ok === false) {
						throw new Error(String(reply.error?.message ?? "status failed"));
					}
					const value = reply?.value ?? reply;
					setState({ status: "ready", data: value, error: undefined, busy: undefined });
				} catch (error) {
					setState({ status: "error", data: undefined, error: String(error?.message ?? error), busy: undefined });
				}
			}, [connection]);

			react.useEffect(() => {
				void load();
			}, [load]);

			const run = async (endpoint) => {
				if (connection === undefined) return;
				setState((current) => ({ ...current, busy: endpoint, error: undefined }));
				try {
					const reply = await connection.rpc.call(CHANNEL, endpoint, {});
					if (reply !== undefined && reply !== null && reply.ok === false) {
						throw new Error(String(reply.error?.message ?? `${endpoint} failed`));
					}
					await load();
				} catch (error) {
					setState((current) => ({ ...current, busy: undefined, error: String(error?.message ?? error) }));
				}
			};

			const data = state.data;
			const index = data?.index ?? {};
			const sync = data?.lastSync;
			const rows = [];
			if (data !== undefined) {
				rows.push([translate("takeover"), translate(data.patched === true ? "takenOverYes" : "takenOverNo")]);
				rows.push([translate("indexPath"), String(data.indexPath ?? index.path ?? "")]);
				rows.push([translate("sessions"), String(index.sessions ?? 0)]);
				rows.push([translate("messages"), String(index.messages ?? 0)]);
				rows.push([translate("size"), bytes(index.chars)]);
				if (sync !== undefined && sync !== null) {
					rows.push([translate("lastSync"), `${String(sync.at ?? "")} 路 read=${String(sync.read ?? 0)} 路 skipped=${String(sync.skipped ?? 0)}`]);
				}
				if (sync !== undefined && sync !== null && Number(sync.failed ?? 0) > 0) {
					rows.push([translate("unreadable"), String(sync.failed)]);
				}
				if (typeof index.error === "string") {
					rows.push([translate("indexError"), index.error]);
				} else if (Number(index.sessions ?? 0) === 0) {
					rows.push([translate("emptyHint"), translate("emptyHintValue")]);
				}
				rows.push([translate("lastError"), data.lastError === undefined || data.lastError === null ? translate("noError") : `${String(data.lastError.stage ?? "")}: ${String(data.lastError.message ?? "")}`]);
			}

			return jsxs("div", {
				style: styles.section,
				children: [
					jsxs("div", {
						children: [
							jsx("div", { style: styles.title, children: translate("title") }),
							jsx("div", { style: styles.description, children: translate("description") })
						]
					}),
					state.status === "unavailable" ? jsx("div", { style: styles.description, children: translate("readOnly") }) : null,
					state.status === "loading" ? jsx("div", { style: styles.description, children: translate("loading") }) : null,
					state.status === "error" ? jsx("div", { style: styles.error, children: `${translate("failed")}: ${String(state.error ?? "")}` }) : null,
					data !== undefined
						? jsx("div", {
								style: styles.grid,
								children: rows.flatMap(([key, value]) => [
									jsx("div", { style: styles.key, children: key }, `k-${key}`),
									jsx("div", { style: styles.value, children: value }, `v-${key}`)
								])
							})
						: null,
					jsxs("div", {
						style: styles.row,
						children: [
							jsx(
								"button",
								{
									type: "button",
									style: styles.button,
									disabled: state.busy !== undefined || state.status === "unavailable",
									onClick: () => void run("rebuild"),
									children: translate(state.busy === "rebuild" ? "rebuilding" : "rebuild")
								},
								"rebuild"
							),
							jsx(
								"button",
								{
									type: "button",
									style: { ...styles.button, ...styles.danger },
									disabled: state.busy !== undefined || state.status === "unavailable",
									onClick: () => void run("drop"),
									children: translate(state.busy === "drop" ? "dropping" : "drop")
								},
								"drop"
							),
							jsx(
								"button",
								{
									type: "button",
									style: styles.button,
									disabled: state.busy !== undefined || state.status === "unavailable",
									onClick: () => void load(),
									children: translate("refresh")
								},
								"refresh"
							)
						]
					})
				]
			});
		}

		/** Browser services this panel needs. */
		const inject = ["slots", "locale", "connection"];
		/**
		 * DOM enhancement: mark the query inside result rows and reveal the
		 * matched message after a result is opened.
		 *
		 * Both halves are heuristics over stable-enough DOM contracts
		 * (`[role="treeitem"]` result rows, `[data-chat-node-key]` message
		 * wrappers, `[data-conversation-scroll]` transcript scroller) and every
		 * failure is swallowed: a harness that changes its markup simply loses
		 * the enhancement, never the search.
		 */
		function createEnhancer(connection) {
			const MARK = "data-skw-mark";
			const FLASH = "data-skw-flash";
			const state = { cache: undefined, at: 0, pending: undefined, timer: undefined, busy: false };

			const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

			const fetchLast = async (force) => {
				// Short TTL: the host updates `last-search` on every keystroke, so a
				// long cache would paint the previous query first and repaint later.
				const fresh = Date.now() - state.at < 350;
				if (!force && fresh && state.cache !== undefined) return state.cache;
				try {
					const reply = await connection.rpc.call(CHANNEL, "last-search", {});
					const value = reply?.value ?? reply;
					state.cache = value ?? undefined;
					state.at = Date.now();
				} catch {
					state.cache = undefined;
				}
				return state.cache;
			};

			/**
			 * Comparison key that survives markdown rendering.
			 *
			 * Message text is stored with markdown (`**bold**`, `| a | b |`, fenced
			 * code) while the rendered DOM shows only the words, so an exact prefix
			 * match fails for most real messages. The loose key keeps letters,
			 * digits and CJK only.
			 */
			const loosen = (value) => String(value ?? "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();

			const tokensOf = (query) => {
				const text = String(query ?? "");
				const tokens = [];
				let buffer = "";
				const flush = () => {
					const value = buffer.trim();
					buffer = "";
					if (value.length > 0) tokens.push(value);
				};
				for (let i = 0; i < text.length; i += 1) {
					const ch = text[i];
					if (ch === '"') {
						flush();
						const end = text.indexOf('"', i + 1);
						const body = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
						if (body.trim().length > 0) tokens.push(body.trim());
						i = end === -1 ? text.length : end;
						continue;
					}
					if (/\s/.test(ch)) {
						flush();
						continue;
					}
					buffer += ch;
				}
				flush();
				return [...new Set(tokens.filter((token) => token.length > 0))].slice(0, 8);
			};

			const unwrapMarks = () => {
				for (const mark of Array.from(document.querySelectorAll(`mark[${MARK}]`))) {
					const parent = mark.parentNode;
					if (parent === null) continue;
					parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
					parent.normalize?.();
				}
			};

			const wrapIn = (root, token, needle) => {
				if (typeof document.createTreeWalker !== "function") return false;
				const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
					acceptNode: (node) => {
						const parent = node.parentNode;
						if (parent === null || parent === undefined) return NodeFilter.FILTER_REJECT;
						// `closest()` per text node walks ancestors every time; the tag
						// check is enough here and keeps a pass sub-millisecond.
						const tag = parent.tagName;
						if (tag === "MARK" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SCRIPT" || tag === "STYLE") {
							return NodeFilter.FILTER_REJECT;
						}
						const value = node.nodeValue;
						if (value === null || value.length < needle.length) return NodeFilter.FILTER_REJECT;
						return value.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
					}
				});
				const targets = [];
				while (walker.nextNode() !== null) targets.push(walker.currentNode);
				if (targets.length === 0) return false;
				for (const node of targets) {
					const text = node.nodeValue ?? "";
					const lower = text.toLowerCase();
					let at = lower.indexOf(needle);
					if (at < 0) continue;
					const fragment = document.createDocumentFragment();
					let cursor = 0;
					while (at >= 0) {
						if (at > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, at)));
						const mark = document.createElement("mark");
						mark.setAttribute(MARK, "");
						// `--dsw-alias-bg-warning` does not exist in any shipped client
						// bundle, so the old rule always fell back to a flat yellow.
						mark.style.background = "rgba(255, 190, 61, 0.30)";
						mark.style.color = "inherit";
						mark.style.borderRadius = "2px";
						mark.style.boxShadow = "inset 0 -1px 0 rgba(255, 170, 0, 0.85)";
						mark.textContent = text.slice(at, at + token.length);
						fragment.appendChild(mark);
						cursor = at + token.length;
						at = lower.indexOf(needle, cursor);
					}
					if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
					node.parentNode?.replaceChild?.(fragment, node);
				}
				return true;
			};

						/** True when the sidebar search box exists and holds no query. */
			const searchBoxEmpty = () => {
				const input = document.querySelector('input[class*="searchInput"]');
				return input === null || String(input.value ?? "").trim().length === 0;
			};

			const resultRows = () =>
				Array.from(document.querySelectorAll('[class*="searchResultRow"]')).filter(
					(row) => row.closest?.('[data-slot="conversation.chat.node"]') === null,
				);

			const highlight = async () => {
				if (state.busy) return;
				state.busy = true;
				try {
					// Only result rows carry the query; the session tree shares
					// `role="treeitem"` and would keep stale marks after the box closes.
					const rows = resultRows();
					if (rows.length === 0 && searchBoxEmpty()) {
						unwrapMarks();
						state.applied = undefined;
						return;
					}
					const last = await fetchLast(false);
					const ui = last?.ui ?? {};
					if (ui.highlight === false) return;
					const tokens = tokensOf(last?.query);
					if (tokens.length === 0) return;
					const age = Date.now() - Date.parse(last?.at ?? 0);
					if (!Number.isFinite(age) || age > 10 * 60 * 1000) return;
					if (rows.length === 0) return;
					if (state.applied !== last.query) {
						unwrapMarks();
						state.applied = last.query;
					}
					for (const row of rows) {
						// Never trust a memo over the DOM: wrapping in <mark> does not
						// change textContent length, so a React re-render that drops the
						// marks would look "already done" forever. The row's own marks
						// are the only evidence that it is still highlighted.
						if (row.querySelector(`mark[${MARK}]`) !== null) continue;
						const length = row.textContent?.length ?? 0;
						if (row.__skwTried === last.query && row.__skwLen === length) continue;
						let touched = false;
						for (const token of tokens) {
							if (wrapIn(row, token, token.toLowerCase()) === true) touched = true;
						}
						row.__skwTried = last.query;
						// Only a row we left untouched keeps a reliable length: our own
						// marks change the DOM, so the next pass must re-check it.
						row.__skwLen = touched ? -1 : length;
					}
				} catch {
					/* markup changed: skip this pass */
				} finally {
					state.busy = false;
				}
			};

const flash = (node) => {
				node.setAttribute(FLASH, "");
				const previous = node.style.cssText;
				node.style.transition = "background-color .35s ease, box-shadow .35s ease";
				node.style.background = "var(--dsw-alias-bg-warning, rgba(255, 214, 102, 0.35))";
				node.style.boxShadow = "0 0 0 2px var(--dsw-alias-border-warning, rgba(230, 162, 60, .55))";
				window.setTimeout(() => {
					try {
						node.style.cssText = previous;
						node.removeAttribute(FLASH);
					} catch {
						/* node already gone */
					}
				}, 2600);
			};

			const scrollerFor = (node) => {
				const direct = document.querySelector("[data-conversation-scroll]");
				if (direct !== null) return direct;
				let current = node?.parentElement ?? null;
				while (current !== null) {
					if (current.scrollHeight > current.clientHeight + 8) return current;
					current = current.parentElement;
				}
				return null;
			};

			const reveal = async () => {
				try {
					const pending = state.pending;
					if (pending === undefined) return true;
					if (Date.now() - pending.at > 15000) {
						state.pending = undefined;
						return true;
					}
					// Let the conversation switch finish before touching its scroller.
					if (Date.now() - pending.at < 500) return false;
					const exact = normalize(pending.hit.prefix).slice(0, 60).toLowerCase();
					const loose = loosen(pending.hit.prefix).slice(0, 40);
					if (exact.length < 6 && loose.length < 6) {
						state.pending = undefined;
						return true;
					}
					const nodes = Array.from(document.querySelectorAll("[data-chat-node-key]"));
					let best;
					let bestLength = Number.POSITIVE_INFINITY;
					// Pass one: literal prefix. Pass two: markdown-insensitive compare,
					// which is what actually fires for bold/table/code-heavy messages.
					for (const mode of ["exact", "loose"]) {
						if (mode === "loose" && loose.length < 6) break;
						for (const node of nodes) {
							const raw = node.textContent;
							const haystack = mode === "exact" ? normalize(raw).toLowerCase() : loosen(raw);
							const needle = mode === "exact" ? exact : loose;
							if (needle.length === 0 || !haystack.includes(needle)) continue;
							const length = haystack.length;
							if (length < bestLength) {
								best = node;
								bestLength = length;
							}
						}
						if (best !== undefined) break;
					}
					if (best !== undefined) {
						best.scrollIntoView({ block: "center", behavior: "smooth" });
						flash(best);
						state.pending = undefined;
						return true;
					}
					// Not rendered yet: pull older pages until it appears.
					pending.attempts = (pending.attempts ?? 0) + 1;
					const limit = Number(pending.maxAttempts ?? 20);
					if (pending.attempts > limit) {
						state.pending = undefined;
						return true;
					}
					const scroller = scrollerFor(nodes[0]);
					if (scroller !== null) scroller.scrollTop = 0;
					return false;
				} catch {
					state.pending = undefined;
					return true;
				}
			};

			const tick = () => {
				void reveal()
					.catch(() => true)
					.then((done) => {
						if (done || state.pending === undefined) {
							if (state.timer !== undefined) {
								window.clearInterval(state.timer);
								state.timer = undefined;
							}
						}
					});
			};

			const startPending = (hit, maxAttempts) => {
				state.pending = { hit, at: Date.now(), attempts: 0, maxAttempts };
				if (state.timer !== undefined) window.clearInterval(state.timer);
				state.timer = window.setInterval(tick, 260);
				tick();
			};

			const onDocumentClick = async (event) => {
				try {
					const target = event.target;
					if (!(target instanceof Element)) return;
					const row = target.closest('[role="treeitem"]');
					if (row === null) return;
					const text = normalize(row.textContent).toLowerCase();
					const looseText = loosen(row.textContent);
					if (text.length === 0) return;
					const last = await fetchLast(true);
					const ui = last?.ui ?? {};
					if (ui.reveal === false) return;
					const hits = Array.isArray(last?.hits) ? last.hits : [];
					let match;
					let bestLength = 0;
					for (const hit of hits) {
						const exact = normalize(hit.snippet).toLowerCase().slice(0, 40);
						const loose = loosen(hit.snippet).slice(0, 30);
						// Literal first; markdown-stripped comparison covers rows whose
						// rendered text lost `**`, pipes, backticks or link syntax.
						const hitRow =
							(exact.length >= 4 && text.includes(exact)) || (loose.length >= 6 && looseText.includes(loose));
						if (!hitRow) continue;
						const score = Math.max(exact.length, loose.length);
						if (score > bestLength) {
							match = hit;
							bestLength = score;
						}
					}
					if (match === undefined) return;
					startPending(match, Number(ui.maxAttempts ?? 20));
				} catch {
					/* ignore: this is an enhancement */
				}
			};

			const schedule = (() => {
				let last = 0;
				let pending = 0;
				return () => {
					// Streaming turns mutate the DOM constantly; a highlight pass per
					// mutation would burn the main thread for no visible gain.
					const wait = Math.max(0, 60 - (Date.now() - last));
					if (pending !== 0) return;
					pending = window.setTimeout(() => {
						pending = 0;
						last = Date.now();
						if (state.busy) return;
						void highlight();
					}, wait);
				};
			})();

			const observer = new MutationObserver(() => schedule());
			observer.observe(document.body, { childList: true, subtree: true, characterData: false });
			document.addEventListener("click", onDocumentClick, true);
			document.addEventListener(
				"input",
				() => {
					state.at = 0; // a new query is on its way: refetch instead of repainting old terms
					schedule();
				},
				true
			);
			schedule();

			return () => {
				observer.disconnect();
				document.removeEventListener("click", onDocumentClick, true);
				if (state.timer !== undefined) window.clearInterval(state.timer);
				unwrapMarks();
			};
		}

		/**
		 * Register the panel while the settings shell is present.
		 *
		 * @param ctx - browser plugin context.
		 */
		function apply(ctx) {
			let translate = (key) => en[key] ?? key;
			try {
				ctx.effect(() => ctx.locale.register(NS, { en, zh }));
				translate = ctx.locale.bind(NS);
			} catch {
				/* Literal copy stays usable when this harness does not host the namespace. */
			}
			ctx.effect(() =>
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "session-keyword-search",
							order: 120,
							label: () => translate("nav"),
							locale: NS,
							inject: () => ({ connection: ctx.connection })
						},
						Section
					)
				)
			);
			try {
				if (typeof document !== "undefined" && typeof MutationObserver === "function" && ctx.connection !== undefined) {
					const dispose = createEnhancer(ctx.connection);
					ctx.effect(() => dispose);
				}
			} catch {
				/* the enhancement is optional */
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
