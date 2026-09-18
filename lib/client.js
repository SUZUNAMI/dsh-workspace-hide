// dsh-workspace-hide -- client bundle.
// Hand-written __ModuleLoader__ factory (no build step). The only requires are
// react / react/jsx-runtime-free `h`, plus the UI primitives module (guarded:
// if it is unavailable the section falls back to plain themed controls).
//
// WHAT IT DOES
//   Hides selected workspaces from the sidebar workspace list and offers a
//   "Settings -> Hidden workspaces" page to restore them.
//
//   Hiding a workspace must not spill its conversations into the sidebar's
//   "ungrouped" bucket. The sidebar groups sessions by *visible* workspace
//   (ui-workspace/lib/client.js:389-406): once the workspace is filtered out,
//   every session it accounted for goes "stray" and is rendered under
//   `group.ungrouped`. We prevent that on two layers:
//
//     1. DISPLAY (always on, zero dependencies). The snapshot we hand the
//        sidebar carries `archivedSessionIds` = the Host's own archive set
//        UNION every session id this plugin archived for a hidden workspace.
//        The sidebar already excludes archived sessions everywhere, so the
//        group simply becomes empty instead of leaking into "ungrouped".
//        This layer is synchronous, so nothing ever flashes.
//     2. HOST (only when a restore path exists). We really archive those
//        sessions through the Host, so the archive is consistent everywhere
//        (30-day search, the archive page, other clients) and survives a
//        cleared localStorage. On unhide we unarchive *exactly* the ids we
//        archived; sessions that were already archived before the hide are
//        never touched, so they stay archived.
//
//   Why layer 2 is conditional: stock DSH has NO unarchive command at all.
//   `@deepseek-ai/dsh-workspace` only ever appends to `archivedSessionIds`
//   (lib/index.js:446-456); the only unarchive implementation in existence is
//   @michengai/dsh-archive-manager's `unarchiveSession` / `unarchiveSessions`
//   published on the `workspaceRegistry` remote. Archiving without a way back
//   would leave conversations permanently archived if this plugin's local list
//   were ever lost, so we refuse to touch the Host archive unless the restore
//   half is present -- and the display layer alone is already enough to fix the
//   "ungrouped" spill.
//
//   DETECTING THAT RESTORE PATH: `workspaceRegistry` is a *remote namespace*,
//   not a service someone provides at load time. api-gateway's client mounts a
//   namespace by starting a nested plugin named `remote.<namespace>`
//   (api-gateway/lib/client.js:1564-1591, `remoteServiceKey` at 1794), and
//   archive-manager performs that mount from inside its OWN async apply --
//   `await remote.$mount(ARCHIVE_MANAGER_REMOTE)` (archive-manager
//   lib/client.js:3926-3930). So `ctx.get("remote.workspaceRegistry")` is
//   still undefined while a *sibling* plugin's synchronous apply runs, and
//   resolving the bridge once in our apply() would report "display only"
//   forever on a machine where archive-manager is installed.
//
//   The fix has two independent halves, so neither load order nor an early
//   settings visit can be wrong:
//     * `ctx.inject(["remote.workspaceRegistry"], ...)` -- a nested fiber that
//       cordis starts the moment the namespace service appears (and disposes if
//       it goes away). Nothing depends on it, so it can never block our start;
//       it only refreshes `canRestore` in the settings snapshot.
//     * Every Host operation re-derives the bridge at call time (`apiNow()`),
//       so even a registry that mounts later is used without any polling.
//
// HOW IT HOOKS IN
//   The `workspaces` service exposes `list` -- a ClientWorkspaceModel with
//   `getSnapshot()` / `subscribe()`. The official sidebar reads it *lazily*
//   (`this.workspaces.list.getSnapshot()` at call time, see
//   ui-workspace/lib/client.js:45,82,144,2730), so replacing the two own
//   properties on the model instance works regardless of plugin load order --
//   no cordis.patch.yml service takeover is required.
//
//   getSnapshot() must stay referentially stable: React runs
//   useSyncExternalStore on it, and returning a fresh object each call loops
//   forever. The model already rebuilds its snapshot per version (buildSnapshot
//   returns a new object, `items` is replaced wholesale, never mutated in
//   place), so we memoize our filtered wrapper on {raw identity, hidden
//   version} and hand back the *same* object until either actually changes.
window.__ModuleLoader__.load({
	id: "dsh-workspace-hide",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;

		// ---------------------------------------------------------------- UI kit
		// The primitives bundle injects its CSS modules when it initialises, and
		// the app shell already loads it, so reusing it gives us native-looking
		// controls for free. Guarded because a future refactor could move things.
		let primitives = {};
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives") ?? {};
		} catch (error) {
			console.warn("[workspace-hide] UI 基元库不可用，改用内置控件：", error);
		}

		function FallbackButton({ icon, children, ...rest }) {
			return h("button", {
				type: "button",
				...rest,
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 6,
					padding: "4px 10px",
					fontSize: 12,
					fontFamily: "inherit",
					borderRadius: 6,
					border: "1px solid rgba(128,128,128,0.35)",
					background: "transparent",
					color: "inherit",
					cursor: rest.disabled === true ? "default" : "pointer",
					opacity: rest.disabled === true ? 0.5 : 1,
					...(rest.style ?? {})
				}
			}, icon ?? null, children);
		}

		function FallbackSwitch({ checked, onChange, label, disabled = false, title }) {
			return h("button", {
				type: "button",
				role: "switch",
				"aria-checked": checked === true,
				"aria-label": label,
				title,
				disabled,
				onClick: () => onChange(!checked),
				style: {
					position: "relative",
					width: 34,
					height: 20,
					flex: "0 0 auto",
					padding: 0,
					borderRadius: 10,
					border: "1px solid rgba(128,128,128,0.4)",
					background: checked === true ? "rgba(64,140,255,0.9)" : "rgba(128,128,128,0.28)",
					cursor: disabled ? "default" : "pointer",
					opacity: disabled ? 0.5 : 1
				}
			}, h("span", {
				style: {
					position: "absolute",
					top: 2,
					left: checked === true ? 16 : 2,
					width: 14,
					height: 14,
					borderRadius: "50%",
					background: "#fff",
					transition: "left 120ms ease"
				}
			}));
		}

		function FallbackTag({ children }) {
			return h("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					padding: "1px 6px",
					fontSize: 11,
					borderRadius: 4,
					border: "1px solid rgba(128,128,128,0.35)",
					opacity: 0.85
				}
			}, children);
		}

		const Button = primitives.Button ?? FallbackButton;
		const Switch = primitives.Switch ?? FallbackSwitch;
		const Tag = primitives.Tag ?? FallbackTag;
		const IconFolderOpen16 = primitives.IconFolderOpen16 ?? null;

		// ------------------------------------------------------------- metadata
		const name = "dsh-workspace-hide";
		const inject = ["slots", "workspaces", "locale"];
		const NS = "workspace-hide";
		const STORAGE_KEY = "dsh-workspace-hide.hidden.v2";
		const LEGACY_KEY = "dsh-workspace-hide.hidden.v1";
		const MARK = "__dshWorkspaceHide";

		// ---------------------------------------------------------------- state
		const state = {
			/**
			 * Map<workspaceId, string[]> of hidden workspaces. The value is the
			 * list of session ids this plugin archived on the workspace's behalf
			 * (empty when there was nothing to archive, or when no restore path
			 * was available so the Host archive was left alone).
			 */
			hidden: new Map(),
			/** Set<sessionId> we tried to unarchive but which are still archived. */
			pending: new Set(),
			/** Listeners registered through our wrapped subscribe(). */
			listeners: new Set(),
			/** Bumped whenever `hidden`/`pending` change, invalidating both views. */
			version: 0,
			/** () => raw snapshot straight from the untouched model method. */
			read: null,
			/** The plugin ctx, kept so the bridge can be re-derived at call time. */
			ctx: null,
			/**
			 * Live `remote.workspaceRegistry` namespace service, set by the
			 * ctx.inject(["remote.workspaceRegistry"]) fiber -- or null when no
			 * plugin (archive-manager) has mounted that namespace. Read by
			 * resolveApi(); never awaited by anything on the critical path.
			 */
			registry: null,
			/**
			 * Live `sessions` client service, set by the ctx.inject(["sessions"])
			 * fiber -- or null while no sessions service is available. Only used
			 * for the optional `refresh()` hook, so a missing service degrades to
			 * `refresh: null` instead of breaking the whole plugin.
			 */
			sessions: null,
			/** Host archive bridge resolved from the live services. */
			api: null,
			viewCache: null,
			viewRaw: null,
			viewVersion: -1,
			manageCache: null,
			manageRaw: null,
			manageVersion: -1
		};

		function isId(value) {
			return typeof value === "string" && value !== "";
		}

		function applyStored(parsed) {
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
			const hidden = parsed.hidden;
			if (hidden !== null && typeof hidden === "object" && !Array.isArray(hidden)) {
				for (const workspaceId of Object.keys(hidden)) {
					if (!isId(workspaceId)) continue;
					const ids = hidden[workspaceId];
					state.hidden.set(workspaceId, Array.isArray(ids) ? ids.filter(isId) : []);
				}
			}
			if (Array.isArray(parsed.pending)) {
				for (const id of parsed.pending) if (isId(id)) state.pending.add(id);
			}
		}

		function loadHidden() {
			try {
				const text = window.localStorage.getItem(STORAGE_KEY);
				if (text !== null && text !== "") {
					applyStored(JSON.parse(text));
					return;
				}
				// v1: a bare array of workspaceIds, with no record of what (if
				// anything) was archived on their behalf. Migrate, then forget it.
				const legacy = window.localStorage.getItem(LEGACY_KEY);
				if (legacy === null || legacy === "") return;
				const parsed = JSON.parse(legacy);
				if (!Array.isArray(parsed)) return;
				for (const id of parsed) if (isId(id)) state.hidden.set(id, []);
				saveHidden();
				try {
					window.localStorage.removeItem(LEGACY_KEY);
				} catch (error) {
					console.warn("[workspace-hide] 清除 v1 清单键失败（不影响使用）：", error);
				}
			} catch (error) {
				console.warn("[workspace-hide] 读取本地隐藏清单失败，按未隐藏处理：", error);
			}
		}

		function saveHidden() {
			try {
				const hidden = {};
				for (const [workspaceId, ids] of state.hidden) hidden[workspaceId] = [...ids];
				window.localStorage.setItem(
					STORAGE_KEY,
					JSON.stringify({ hidden, pending: [...state.pending] })
				);
			} catch (error) {
				// Private mode / quota: the toggle still works for this page load.
				console.warn("[workspace-hide] 保存本地隐藏清单失败（本次会话内仍然生效）：", error);
			}
		}

		function notify() {
			state.version += 1;
			state.viewCache = null;
			state.viewRaw = null;
			state.viewVersion = -1;
			state.manageCache = null;
			state.manageRaw = null;
			state.manageVersion = -1;
			for (const listener of [...state.listeners]) {
				try {
					listener();
				} catch (error) {
					console.warn("[workspace-hide] 监听者抛错：", error);
				}
			}
		}

		function readRaw() {
			if (state.read === null) return { items: [] };
			try {
				return state.read() ?? { items: [] };
			} catch (error) {
				console.warn("[workspace-hide] 读取工作区快照失败：", error);
				return { items: [] };
			}
		}

		function hostArchivedSet() {
			const raw = readRaw();
			return new Set(Array.isArray(raw.archivedSessionIds) ? raw.archivedSessionIds : []);
		}

		function sessionIdsOf(item) {
			return Array.isArray(item?.sessionIds) ? item.sessionIds.filter(isId) : [];
		}

		/**
		 * The archive set the *sidebar* must use: the Host's own set plus every
		 * session this plugin archived for a hidden workspace. The union is what
		 * keeps a hidden workspace's conversations out of the "未分组" bucket,
		 * and it covers the window between hiding and the Host confirming the
		 * archive, so nothing flashes into the sidebar.
		 *
		 * Returns `base` itself when nothing is added, so the untouched snapshot
		 * can be handed back verbatim for users who hid nothing.
		 */
		function withHiddenSessions(base) {
			if (state.hidden.size === 0) return base;
			const set = new Set(base);
			let changed = false;
			for (const ids of state.hidden.values()) {
				for (const id of ids) {
					if (set.has(id)) continue;
					set.add(id);
					changed = true;
				}
			}
			return changed ? [...set] : base;
		}

		/**
		 * Sidebar view: the real snapshot minus hidden workspaces, with the hidden
		 * workspaces' sessions marked archived so they cannot leak into the
		 * ungrouped bucket. Returns the untouched snapshot object when nothing is
		 * hidden, so we never change behaviour for users who hid nothing.
		 */
		function getViewSnapshot() {
			const raw = readRaw();
			if (state.viewCache !== null && state.viewRaw === raw && state.viewVersion === state.version) {
				return state.viewCache;
			}
			state.viewRaw = raw;
			state.viewVersion = state.version;
			const items = Array.isArray(raw.items) ? raw.items : [];
			const base = Array.isArray(raw.archivedSessionIds) ? raw.archivedSessionIds : [];
			const visible = items.filter((item) => !state.hidden.has(item.workspaceId));
			const archived = withHiddenSessions(base);
			state.viewCache = visible.length === items.length && archived === base
				? raw
				: { ...raw, items: visible, archivedSessionIds: archived };
			return state.viewCache;
		}

		/**
		 * Management view: the *unfiltered* list plus the hidden records, so the
		 * Settings page can show hidden rows too. Also memoized on
		 * {raw identity, version} to stay referentially stable.
		 */
		function getManageSnapshot() {
			const raw = readRaw();
			if (state.manageCache !== null && state.manageRaw === raw && state.manageVersion === state.version) {
				return state.manageCache;
			}
			state.manageRaw = raw;
			state.manageVersion = state.version;
			state.manageCache = {
				items: Array.isArray(raw.items) ? raw.items : [],
				hidden: new Set(state.hidden.keys()),
				records: new Map(state.hidden),
				pending: new Set(state.pending),
				canRestore: state.api !== null && state.api.canRestore === true,
				state: raw.state,
				phase: raw.phase,
				error: raw.error
			};
			return state.manageCache;
		}

		function subscribe(listener) {
			state.listeners.add(listener);
			return () => {
				state.listeners.delete(listener);
			};
		}

		// ------------------------------------------------------- host archive API
		/**
		 * Resolve the Host-side archive bridge.
		 *
		 * Archiving is the easy half: the `workspaces` client service always has
		 * `archiveSession(sessionId)` (api-workspace-controller/lib/client.js:114),
		 * and archive-manager publishes a batch `archiveSessions(ids)` alongside
		 * its unarchive commands. Restoring is the scarce half -- see the header
		 * for why we refuse to archive anything without it.
		 */
		/**
		 * `ctx.get(name)` is the *only* safe service lookup.
		 *
		 * The property form (`ctx.sessions`, `ctx.workspaces`) goes through the
		 * cordis reflect proxy, which walks the fiber chain and throws
		 * `cannot get property "X" without inject` (reflect.ts:144) as soon as
		 * the service is provided by a sibling fiber instead of by our own
		 * inject list. `ctx.get(name)` never throws for that reason, but it
		 * still returns undefined while the providing fiber is inactive -- which
		 * is a normal state during boot, so the result must degrade, not throw.
		 */
		function tryGet(ctx, name) {
			try {
				return ctx.get(name) ?? null;
			} catch {
				return null;
			}
		}

		function resolveApi(ctx) {
			const workspaces = tryGet(ctx, "workspaces");
			const registry = state.registry ?? tryGet(ctx, "remote.workspaceRegistry");
			const sessions = tryGet(ctx, "sessions") ?? state.sessions;
			const archiveOne = typeof workspaces?.archiveSession === "function"
				? (sessionId) => workspaces.archiveSession(sessionId)
				: null;
			const archiveMany = typeof registry?.archiveSessions === "function"
				? (sessionIds) => registry.archiveSessions(sessionIds)
				: null;
			const unarchiveOne = typeof registry?.unarchiveSession === "function"
				? (sessionId) => registry.unarchiveSession(sessionId)
				: null;
			const unarchiveMany = typeof registry?.unarchiveSessions === "function"
				? (target) => registry.unarchiveSessions(target)
				: null;
			return {
				archiveOne,
				archiveMany,
				unarchiveOne,
				unarchiveMany,
				refresh: typeof sessions?.refresh === "function" ? () => sessions.refresh() : null,
				canArchive: archiveOne !== null || archiveMany !== null,
				canRestore: unarchiveOne !== null || unarchiveMany !== null
			};
		}

		/**
		 * The Host bridge, re-derived right now.
		 *
		 * Plugin load order is not ours to choose: archive-manager mounts the
		 * `workspaceRegistry` namespace from inside its own async apply, so the
		 * service may well appear *after* we resolved ours. Every operation goes
		 * through here instead of trusting the copy captured in apply(), which
		 * makes a late-mounting archive-manager work with no poll, no timer and
		 * no dependency we could be blocked on.
		 * @returns the current bridge (never null once apply() has run).
		 */
		function apiNow() {
			if (state.ctx === null) return state.api;
			state.api = resolveApi(state.ctx);
			return state.api;
		}

		/**
		 * Adopt (or drop) the `remote.workspaceRegistry` namespace service and
		 * repaint, so the settings page's `canRestore` follows the live world
		 * instead of the world as it looked during apply().
		 */
		function setRegistry(registry) {
			const next = registry ?? null;
			if (state.registry === next) return;
			state.registry = next;
			state.api = state.ctx === null ? state.api : resolveApi(state.ctx);
			// notify() bumps state.version, which invalidates both memoized views,
			// so the settings page re-reads canRestore.
			notify();
		}

		function setSessions(sessions) {
			const next = sessions ?? null;
			if (state.sessions === next) return;
			state.sessions = next;
			state.api = state.ctx === null ? state.api : resolveApi(state.ctx);
			notify();
		}

		/** Remote calls resolve to `{ok:true,value}` / `{ok:false,error}`. */
		function failureOf(result) {
			if (result !== null && typeof result === "object" && result.ok === false) {
				return result.error?.message ?? "remote call failed";
			}
			return null;
		}

		async function refreshSessions() {
			const api = apiNow();
			if (api === null || api.refresh === null) return;
			try {
				await api.refresh();
			} catch (error) {
				console.warn("[workspace-hide] 刷新会话列表失败（不影响隐藏状态）：", error);
			}
		}

		/**
		 * Really archive `sessionIds` on the Host. Best effort: a failure is
		 * logged and swallowed, because the display layer already hides them.
		 * @returns the ids that are NOT archived on the Host afterwards.
		 */
		async function archiveOnHost(sessionIds) {
			const api = apiNow();
			const ids = (Array.isArray(sessionIds) ? sessionIds : []).filter(isId);
			if (api === null || api.canRestore !== true || ids.length === 0) return ids;
			// Prefer the batch remote, but fall back to the always-available
			// per-session client command if the batch either is missing or fails.
			let remaining = ids;
			if (api.archiveMany !== null) {
				try {
					const reason = failureOf(await api.archiveMany(ids));
					if (reason !== null) throw new Error(reason);
					remaining = [];
				} catch (error) {
					console.warn("[workspace-hide] 批量归档失败，改用逐个归档：", error);
				}
			}
			if (remaining.length > 0 && api.archiveOne !== null) {
				for (const sessionId of remaining) {
					try {
						const reason = failureOf(await api.archiveOne(sessionId));
						if (reason !== null) throw new Error(reason);
					} catch (error) {
						console.warn(`[workspace-hide] 归档会话 ${sessionId} 失败：`, error);
					}
				}
			}
			const archived = hostArchivedSet();
			return ids.filter((id) => !archived.has(id));
		}

		/**
		 * Unarchive exactly the ids this plugin archived. Ids the Host no longer
		 * holds as archived (already restored by hand, or never archived at all
		 * because no restore path existed at hide time) are dropped from
		 * `pending`; the rest are parked there so the settings page can retry.
		 */
		async function restoreOnHost(sessionIds) {
			const ids = (Array.isArray(sessionIds) ? sessionIds : []).filter(isId);
			const api = apiNow();
			if (ids.length > 0 && api !== null && api.canRestore === true) {
				try {
					if (api.unarchiveMany !== null) {
						const reason = failureOf(await api.unarchiveMany({
							scope: "sessions",
							sessionIds: [...new Set(ids)]
						}));
						if (reason !== null) throw new Error(reason);
					} else {
						for (const sessionId of ids) {
							const reason = failureOf(await api.unarchiveOne(sessionId));
							if (reason !== null) console.warn(`[workspace-hide] 取消归档会话 ${sessionId} 失败：${reason}`);
						}
					}
				} catch (error) {
					console.warn("[workspace-hide] 自动取消归档失败：", error);
				}
			}
			const archived = hostArchivedSet();
			let changed = false;
			for (const id of ids) {
				if (archived.has(id)) {
					if (!state.pending.has(id)) {
						state.pending.add(id);
						changed = true;
					}
				} else if (state.pending.delete(id)) {
					changed = true;
				}
			}
			// Nothing was asked for and nothing changed: do not wake subscribers.
			if (ids.length === 0 && !changed) return;
			saveHidden();
			await refreshSessions();
			notify();
		}

		// ------------------------------------------------------------- mutations
		/**
		 * Hide one workspace and archive the sessions it owns.
		 *
		 * `toArchive` is every session of the workspace that is NOT already
		 * archived -- so sessions the user archived before hiding are neither
		 * recorded nor touched, and stay archived after a later unhide.
		 */
		async function hideWorkspace(workspaceId) {
			if (!isId(workspaceId)) return;
			if (state.hidden.has(workspaceId)) return;
			const raw = readRaw();
			const item = (Array.isArray(raw.items) ? raw.items : [])
				.find((entry) => entry.workspaceId === workspaceId);
			const alreadyArchived = new Set(Array.isArray(raw.archivedSessionIds) ? raw.archivedSessionIds : []);
			const toArchive = sessionIdsOf(item).filter((id) => !alreadyArchived.has(id));
			state.hidden.set(workspaceId, toArchive);
			saveHidden();
			// Paint first: the workspace leaves the sidebar and the union above
			// marks its sessions archived immediately, so "未分组" never appears.
			notify();
			if (toArchive.length > 0) {
				const api = apiNow();
				if (api === null || api.canRestore !== true) {
					console.warn(
						"[workspace-hide] 未检测到「取消归档」能力（需要 @michengai/dsh-archive-manager），" +
						"本次隐藏只作用于侧边栏显示，宿主归档状态未被改动。"
					);
				} else {
					const notArchived = await archiveOnHost(toArchive);
					if (notArchived.length > 0) {
						console.warn(`[workspace-hide] ${notArchived.length} 个会话未能在宿主侧归档，但已在侧边栏隐藏。`);
					}
				}
			}
			await refreshSessions();
		}

		async function showWorkspace(workspaceId) {
			const ids = state.hidden.get(workspaceId);
			if (ids === undefined) return;
			state.hidden.delete(workspaceId);
			saveHidden();
			// Unhide first (the workspace reappears at once); its sessions come
			// back the moment the Host confirms the unarchive.
			notify();
			await restoreOnHost(ids);
		}

		function toggleWorkspace(workspaceId, hidden) {
			if (hidden === true) return hideWorkspace(workspaceId);
			return showWorkspace(workspaceId);
		}

		async function restoreAll() {
			if (state.hidden.size === 0 && state.pending.size === 0) return;
			const ids = [];
			for (const list of state.hidden.values()) ids.push(...list);
			for (const id of state.pending) ids.push(id);
			state.hidden.clear();
			state.pending.clear();
			saveHidden();
			notify();
			await restoreOnHost(ids);
		}

		async function retryRestore() {
			if (state.pending.size === 0) return;
			await restoreOnHost([...state.pending]);
		}

		function dismissPending() {
			if (state.pending.size === 0) return;
			state.pending.clear();
			saveHidden();
			notify();
		}

		function hiddenSessionCount(workspaceId) {
			const ids = state.hidden.get(workspaceId);
			return Array.isArray(ids) ? ids.length : 0;
		}

		function isHidden(workspaceId) {
			return state.hidden.has(workspaceId);
		}

		// ----------------------------------------------------------- model patch
		/**
		 * Replace getSnapshot/subscribe on the workspaces list model.
		 * Returns a disposer that restores the original own-property shape
		 * (deleting our own property when the original lived on the prototype).
		 */
		function install(model) {
			if (model === null || model === undefined || model[MARK] === true) return null;
			const originalGetSnapshot = model.getSnapshot;
			const originalSubscribe = model.subscribe;
			if (typeof originalGetSnapshot !== "function" || typeof originalSubscribe !== "function") {
				console.warn("[workspace-hide] workspaces.list 缺少 getSnapshot/subscribe，跳过适配");
				return null;
			}

			const wrappedGetSnapshot = function () {
				return getViewSnapshot();
			};
			const wrappedSubscribe = function (listener) {
				const off = originalSubscribe.call(model, listener);
				state.listeners.add(listener);
				return () => {
					state.listeners.delete(listener);
					if (typeof off === "function") off();
				};
			};

			const ownGetSnapshot = Object.getOwnPropertyDescriptor(model, "getSnapshot");
			const ownSubscribe = Object.getOwnPropertyDescriptor(model, "subscribe");

			try {
				model.getSnapshot = wrappedGetSnapshot;
				model.subscribe = wrappedSubscribe;
			} catch (error) {
				console.warn("[workspace-hide] 包装 workspaces.list 失败：", error);
				return null;
			}
			if (model.getSnapshot !== wrappedGetSnapshot || model.subscribe !== wrappedSubscribe) {
				console.warn("[workspace-hide] workspaces.list 属性只读，隐藏功能未启用");
				return null;
			}
			try {
				Object.defineProperty(model, MARK, { value: true, configurable: true });
			} catch {
				// Non-essential marker (only guards double-installation).
			}

			return function dispose() {
				try {
					if (model.getSnapshot === wrappedGetSnapshot) {
						if (ownGetSnapshot !== undefined) Object.defineProperty(model, "getSnapshot", ownGetSnapshot);
						else delete model.getSnapshot;
					}
					if (model.subscribe === wrappedSubscribe) {
						if (ownSubscribe !== undefined) Object.defineProperty(model, "subscribe", ownSubscribe);
						else delete model.subscribe;
					}
					if (model[MARK] === true) delete model[MARK];
				} catch (error) {
					console.warn("[workspace-hide] 还原 workspaces.list 失败：", error);
				}
				state.listeners.clear();
				state.viewCache = null;
				state.viewRaw = null;
				state.manageCache = null;
				state.manageRaw = null;
				state.read = null;
			};
		}

		// -------------------------------------------------------------- locales
		const zh = {
			// 设置页左侧导航栏放不下长标签，这里必须短；完整说法放在 section.title。
			"section.label": "工作区显示",
			"section.title": "侧边栏显示的工作区",
			"section.desc": "每行后面的开关控制这个工作区是否出现在侧边栏：打开＝显示，关掉＝隐藏。隐藏一个工作区时，它名下尚未归档的会话会被自动归档，所以它们不会掉进侧边栏的「未分组」。重新打开开关时，只恢复这些由隐藏动作归档的会话；隐藏之前就已经归档的会话保持归档不动。文件夹和会话记录始终留在磁盘上。",
			"section.empty": "当前没有任何工作区。",
			"section.count": "共 {total} 个 · 显示 {shown} 个 · 隐藏 {n} 个",
			"section.countZero": "共 {total} 个工作区，全部在显示中",
			"action.restoreAll": "全部显示",
			"action.remove": "移除记录",
			"action.retryRestore": "重试恢复",
			"action.dismissPending": "忽略",
			"badge.hidden": "已隐藏",
			"badge.stale": "已失效",
			"badge.archived": "已归档 {n} 个会话",
			"switch.show": "在侧边栏显示「{name}」",
			"switch.toHide": "关掉开关后，将从侧边栏隐藏「{name}」",
			"switch.toShow": "打开开关后，将在侧边栏显示「{name}」",
			"hint.stale": "下面这些工作区已经不在列表里（可能已被删除），可以清掉它们的隐藏记录。",
			"hint.hiddenRow": "已从侧边栏隐藏",
			"hint.pending": "有 {n} 个会话未能自动取消归档，它们目前仍是归档状态。可以重试，或到「归档」页手动恢复。",
			"hint.displayOnly": "未检测到「取消归档」能力（需要 @michengai/dsh-archive-manager），因此隐藏只作用于侧边栏显示：会话不会被真正归档，取消隐藏时立即全部回来，归档状态保持原样。"
		};

		const en = {
			// The settings rail is narrow; keep the nav label short and put the full wording in section.title.
			"section.label": "Workspace visibility",
			"section.title": "Workspaces shown in the sidebar",
			"section.desc": "The switch on each row controls whether that workspace appears in the sidebar: on means shown, off means hidden. Hiding a workspace archives any session in it that is not archived yet, so nothing spills into the sidebar's \"Ungrouped\" bucket. Switching it back on restores exactly the sessions the hide archived; sessions that were already archived before are left archived. Folders and session logs always stay on disk.",
			"section.empty": "There are no workspaces yet.",
			"section.count": "{total} total · {shown} shown · {n} hidden",
			"section.countZero": "{total} workspace(s), all shown",
			"action.restoreAll": "Show all",
			"action.remove": "Forget entry",
			"action.retryRestore": "Retry restore",
			"action.dismissPending": "Dismiss",
			"badge.hidden": "Hidden",
			"badge.stale": "Missing",
			"badge.archived": "{n} session(s) archived",
			"switch.show": "Show \"{name}\" in the sidebar",
			"switch.toHide": "Turn off to hide \"{name}\" from the sidebar",
			"switch.toShow": "Turn on to show \"{name}\" in the sidebar",
			"hint.stale": "These workspaces are no longer in the list (they may have been deleted). You can clear their hidden entries.",
			"hint.hiddenRow": "Hidden from the sidebar",
			"hint.pending": "{n} session(s) could not be unarchived automatically and are still archived. You can retry, or restore them by hand on the Archive page.",
			"hint.displayOnly": "No unarchive capability was found (this needs @michengai/dsh-archive-manager), so hiding only affects the sidebar: sessions are not really archived, they all come back the moment you unhide, and the archive state is left untouched."
		};

		// ------------------------------------------------------------------ view
		const useSyncExternalStoreImpl =
			typeof react.useSyncExternalStore === "function" ? react.useSyncExternalStore : null;

		/**
		 * Read one of our memoized snapshots. The conditional hook is safe: the
		 * branch is fixed at module init, so the hook order never changes.
		 */
		function useObservable(getSnapshot) {
			if (useSyncExternalStoreImpl !== null) {
				return useSyncExternalStoreImpl(subscribe, getSnapshot, getSnapshot);
			}
			const [value, setValue] = react.useState(getSnapshot);
			react.useEffect(() => subscribe(() => setValue(getSnapshot())), [getSnapshot]);
			return value;
		}

		const styles = {
			root: { display: "flex", flexDirection: "column", gap: 14, padding: "2px 0 24px", maxWidth: 760 },
			head: { display: "flex", flexDirection: "column", gap: 5 },
			title: { fontSize: 15, fontWeight: 600 },
			desc: { fontSize: 12, lineHeight: 1.7, opacity: 0.62 },
			toolbar: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
			count: { fontSize: 12, opacity: 0.75, flex: "1 1 auto" },
			list: { display: "flex", flexDirection: "column" },
			row: {
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "10px 2px",
				borderTop: "1px solid rgba(128,128,128,0.22)"
			},
			icon: { flex: "0 0 auto", opacity: 0.55, display: "flex" },
			meta: { minWidth: 0, flex: "1 1 auto", display: "flex", flexDirection: "column", gap: 2 },
			name: { fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			path: { fontSize: 11, opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			badges: { display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" },
			hint: { fontSize: 12, lineHeight: 1.7, opacity: 0.62 },
			notice: {
				display: "flex",
				flexDirection: "column",
				gap: 10,
				padding: "10px 12px",
				borderRadius: 8,
				border: "1px solid rgba(235,160,50,0.45)",
				background: "rgba(235,160,50,0.09)",
				fontSize: 12,
				lineHeight: 1.7
			},
			empty: { fontSize: 13, opacity: 0.6, padding: "12px 2px" }
		};

		function workspaceName(item) {
			const title = typeof item?.title === "string" ? item.title.trim() : "";
			if (title !== "") return title;
			const path = typeof item?.path === "string" ? item.path.trim() : "";
			if (path !== "") return path;
			return String(item?.workspaceId ?? "");
		}

		function WorkspaceRow({ item, hidden, archivedCount, t, onToggle }) {
			const id = item.workspaceId;
			const label = workspaceName(item);
			// The switch reads "is this workspace shown in the sidebar?", so ON
			// is the un-hidden state. `hidden` is still what we render badges
			// from and what the store keeps, so the two are derived from one
			// another in exactly one place -- here.
			const shown = hidden !== true;
			return h("div", { style: styles.row, key: id },
				IconFolderOpen16 === null ? null : h("span", { style: styles.icon }, h(IconFolderOpen16, null)),
				h("div", { style: styles.meta },
					h("div", { style: styles.name, title: label }, label),
					typeof item.path === "string" && item.path !== ""
						? h("div", { style: styles.path, title: item.path }, item.path)
						: null
				),
				h("div", { style: styles.badges },
					hidden ? h(Tag, { tone: "outline" }, t("badge.hidden")) : null,
					hidden && archivedCount > 0
						? h(Tag, { tone: "outline" }, t("badge.archived", { n: archivedCount }))
						: null
				),
				h(Switch, {
					checked: shown,
					// Accessible name = the setting; `title` = what flipping does.
					label: t("switch.show", { name: label }),
					title: shown ? t("switch.toHide", { name: label }) : t("switch.toShow", { name: label }),
					onChange: (next) => onToggle(id, next !== true)
				})
			);
		}

		function StaleRow({ workspaceId, t, onRemove }) {
			return h("div", { style: styles.row, key: workspaceId },
				IconFolderOpen16 === null ? null : h("span", { style: styles.icon }, h(IconFolderOpen16, null)),
				h("div", { style: styles.meta },
					h("div", { style: styles.name, title: workspaceId }, workspaceId),
					h("div", { style: styles.path }, t("hint.hiddenRow"))
				),
				h("div", { style: styles.badges }, h(Tag, { tone: "outline" }, t("badge.stale"))),
				h(Button, { size: "sm", onClick: () => onRemove(workspaceId) }, t("action.remove"))
			);
		}

		function WorkspaceHideSection(props) {
			const manage = useObservable(getManageSnapshot);
			const t = typeof props?.t === "function" ? props.t : (key) => key;
			const items = Array.isArray(manage?.items) ? manage.items : [];
			const hidden = manage?.hidden instanceof Set ? manage.hidden : new Set();
			const records = manage?.records instanceof Map ? manage.records : new Map();
			const pending = manage?.pending instanceof Set ? manage.pending : new Set();
			const known = new Set(items.map((item) => item.workspaceId));
			const stale = [...hidden].filter((id) => !known.has(id));
			// `hidden` may still hold ids of deleted workspaces, so count only
			// what is actually on screen: otherwise a stale id would read as a
			// hidden workspace that the list never shows.
			const hiddenCount = items.reduce((n, item) => (hidden.has(item.workspaceId) ? n + 1 : n), 0);
			const shownCount = items.length - hiddenCount;

			// Hidden rows sink to the bottom. Array#sort is stable, so the
			// Host's own ordering is preserved inside each half.
			const ordered = [...items].sort(
				(a, b) => (hidden.has(a.workspaceId) ? 1 : 0) - (hidden.has(b.workspaceId) ? 1 : 0)
			);

			const head = h("div", { style: styles.head, key: "head" },
				h("div", { style: styles.title }, t("section.title")),
				h("div", { style: styles.desc }, t("section.desc"))
			);

			const toolbar = h("div", { style: styles.toolbar, key: "toolbar" },
				h("div", { style: styles.count },
					hiddenCount === 0
						? t("section.countZero", { total: items.length })
						: t("section.count", { total: items.length, shown: shownCount, n: hiddenCount })
				),
				h(Button, { size: "sm", disabled: hiddenCount === 0 && pending.size === 0, onClick: () => restoreAll() }, t("action.restoreAll"))
			);

			const pendingBlock = pending.size === 0 ? null : h("div", { style: styles.notice, key: "pending" },
				h("div", null, t("hint.pending", { n: pending.size })),
				h("div", { style: styles.toolbar },
					h(Button, { size: "sm", onClick: () => retryRestore() }, t("action.retryRestore")),
					h(Button, { size: "sm", onClick: dismissPending }, t("action.dismissPending"))
				)
			);

			const displayOnly = hiddenCount > 0 && manage?.canRestore !== true
				? h("div", { style: styles.notice, key: "display-only" }, h("div", null, t("hint.displayOnly")))
				: null;

			const list = items.length === 0
				? h("div", { style: styles.empty, key: "empty" }, t("section.empty"))
				: h("div", { style: styles.list, key: "list" },
					ordered.map((item) => h(WorkspaceRow, {
						key: item.workspaceId,
						item,
						hidden: hidden.has(item.workspaceId),
						archivedCount: Array.isArray(records.get(item.workspaceId)) ? records.get(item.workspaceId).length : 0,
						t,
						onToggle: toggleWorkspace
					}))
				);

			const staleBlock = stale.length === 0 ? null : h("div", { key: "stale" },
				h("div", { style: styles.hint }, t("hint.stale")),
				h("div", { style: styles.list }, stale.map((id) => h(StaleRow, {
					key: id,
					workspaceId: id,
					t,
					onRemove: showWorkspace
				})))
			);

			return h("div", { style: styles.root }, head, toolbar, pendingBlock, displayOnly, list, staleBlock);
		}

		// ----------------------------------------------------------------- apply
		function resolveModel(ctx) {
			const workspaces = tryGet(ctx, "workspaces");
			return workspaces?.list ?? null;
		}

		function apply(ctx) {
			state.ctx = ctx;
			state.api = resolveApi(ctx);
			loadHidden();

			const model = resolveModel(ctx);
			let disposeModel = null;
			if (model !== null && typeof model.getSnapshot === "function") {
				// Capture the untouched method FIRST: state.read must never see our
				// own wrapper, or it would recurse.
				const originalGetSnapshot = model.getSnapshot;
				state.read = () => originalGetSnapshot.call(model);
				disposeModel = install(model);
			} else {
				console.warn("[workspace-hide] 未找到 workspaces.list，侧边栏隐藏未启用（设置页仍可用）");
			}

			const disposeDictionaries = ctx.effect(
				() => ctx.locale.register(NS, { zh, en }),
				"dsh-workspace-hide: dictionaries"
			);

			const disposeSection = ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "workspace-hide",
				order: 19,
				label: () => ctx.locale.bind(NS)("section.label"),
				locale: NS,
				inject: () => ({ t: ctx.locale.bind(NS) })
			}, WorkspaceHideSection));

			// Optional capability, waited for rather than required. The
			// `workspaceRegistry` namespace only exists if some plugin (in
			// practice @michengai/dsh-archive-manager) mounted it, and that
			// plugin mounts it from inside its own async apply -- so looking it
			// up once, here, is a coin flip. Cordis starts this nested fiber the
			// moment the service is provided and disposes it if it goes away;
			// because nothing declares a hard dependency, a missing
			// archive-manager costs us nothing but the display-only fallback.
			let disposeRegistry = null;
			if (typeof ctx.inject === "function") {
				try {
					const fiber = ctx.inject(["remote.workspaceRegistry"], (scope) => {
						setRegistry(scope.get("remote.workspaceRegistry") ?? scope.remote?.workspaceRegistry);
						return () => setRegistry(null);
					});
					disposeRegistry = () => {
						if (fiber !== null && typeof fiber?.dispose === "function") fiber.dispose();
					};
				} catch (error) {
					console.warn("[workspace-hide] 订阅 remote.workspaceRegistry 失败（将按调用时探测）：", error);
				}
			}

			// Same optional-capability treatment for `sessions`, which we only
			// use for its `refresh()` hook. It must NOT go into our inject list:
			// a hard requirement that is unavailable early in boot would
			// deactivate this whole plugin, losing the sidebar feature over an
			// optional nicety. Wait for it in a nested fiber instead.
			let disposeSessions = null;
			if (typeof ctx.inject === "function") {
				try {
					const fiber = ctx.inject(["sessions"], (scope) => {
						setSessions(scope.get("sessions"));
						return () => setSessions(null);
					});
					disposeSessions = () => {
						if (fiber !== null && typeof fiber?.dispose === "function") fiber.dispose();
					};
				} catch (error) {
					console.warn("[workspace-hide] 订阅 sessions 失败（刷新将不可用）：", error);
				}
			}

			return () => {
				if (disposeSessions !== null) disposeSessions();
				if (disposeRegistry !== null) disposeRegistry();
				if (typeof disposeSection === "function") disposeSection();
				if (typeof disposeDictionaries === "function") disposeDictionaries();
				if (typeof disposeModel === "function") disposeModel();
				state.registry = null;
				state.sessions = null;
				state.api = null;
				state.ctx = null;
			};
		}

		exports.__test = {
			state,
			getViewSnapshot,
			getManageSnapshot,
			withHiddenSessions,
			subscribe,
			install,
			resolveApi,
			apiNow,
			setRegistry,
			setSessions,
			tryGet,
			archiveOnHost,
			restoreOnHost,
			hideWorkspace,
			showWorkspace,
			restoreAll,
			retryRestore,
			dismissPending,
			hiddenSessionCount,
			isHidden,
			workspaceName,
			WorkspaceHideSection,
			STORAGE_KEY,
			LEGACY_KEY
		};
		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
