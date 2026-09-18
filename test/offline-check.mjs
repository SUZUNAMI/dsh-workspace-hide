// Offline verification harness for dsh-workspace-hide.
//
// It stubs window.__ModuleLoader__, require(), localStorage and the cordis ctx,
// then actually runs the client bundle: apply() -> model wrapping -> archive
// bridge -> settings section shallow render -> dispose(). No DSH process, no
// browser.
//
// Run:  node test/offline-check.mjs
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let failures = 0;
let checks = 0;
function ok(condition, label, detail) {
	checks += 1;
	if (condition) {
		console.log(`  PASS  ${label}`);
	} else {
		failures += 1;
		console.log(`  FAIL  ${label}${detail === undefined ? "" : `  -> ${detail}`}`);
	}
}
function eq(actual, expected, label) {
	ok(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function deepEq(actual, expected, label) {
	eq(JSON.stringify(actual), JSON.stringify(expected), label);
}
function section(title) {
	console.log(`\n=== ${title} ===`);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// --------------------------------------------------------------- react stub
const reactStub = {
	createElement(type, props, ...children) {
		const merged = { ...(props ?? {}) };
		if (children.length === 1) merged.children = children[0];
		else if (children.length > 1) merged.children = children;
		return { type, props: merged };
	},
	useSyncExternalStore(subscribe, getSnapshot) {
		return getSnapshot();
	},
	useState(initial) {
		return [typeof initial === "function" ? initial() : initial, () => {}];
	},
	useEffect() {}
};

// Naive renderer: calls function components, concatenates strings. Enough to
// prove the section mounts, reads data and wires labels without a DOM.
function render(node) {
	if (node === null || node === undefined || node === false || node === true) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(render).join("");
	const { type, props } = node;
	if (typeof type === "function") return render(type({ ...(props ?? {}) }));
	return render(props?.children);
}

// Every Switch the naive renderer walks past, in render order. The renderer
// drops props, so this is the only way to reach `onChange` and prove the
// polarity wiring (on = shown) rather than just its rendered label.
const switchProps = [];

const primitivesStub = {
	Button: ({ children, ...rest }) => reactStub.createElement("button", rest, children),
	Switch: ({ label, checked, onChange }) => {
		switchProps.push({ label, checked, onChange });
		return reactStub.createElement("span", null, `[switch:${checked ? "on" : "off"}:${label ?? ""}]`);
	},
	Tag: ({ children }) => reactStub.createElement("span", null, `[tag:${children ?? ""}]`),
	IconFolderOpen16: () => reactStub.createElement("svg", null)
};

// ----------------------------------------------------------- localStorage stub
function makeStorage() {
	const map = new Map();
	return {
		map,
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, String(value)),
		removeItem: (key) => map.delete(key)
	};
}

// ------------------------------------------------- model stub (mirrors the real
// ClientWorkspaceModel: methods live on the CLASS PROTOTYPE, and every version
// rebuilds a NEW snapshot object with `items` replaced wholesale). Getting this
// shape right matters: it is exactly what makes `delete model.getSnapshot` the
// correct restore path on dispose.
class FakeModel {
	constructor(views, archived = []) {
		this.items = views.slice();
		this.archived = archived.slice();
		this.snapshot = null;
		this.snapshotVersion = -1;
		this.listeners = new Set();
		this.version = 0;
	}
	getSnapshot() {
		if (this.snapshot !== null && this.snapshotVersion === this.version) return this.snapshot;
		this.snapshotVersion = this.version;
		this.snapshot = {
			items: this.items,
			archivedSessionIds: this.archived,
			state: "ready",
			phase: "idle",
			error: null
		};
		return this.snapshot;
	}
	/** The untouched, unwrapped snapshot -- what the Host really holds. */
	peek() {
		return { items: this.items, archivedSessionIds: this.archived };
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	invalidate() {
		this.version += 1;
		this.snapshot = null;
		for (const listener of [...this.listeners]) listener();
	}
	setItems(next) {
		this.items = next.slice();
		this.invalidate();
	}
	setArchived(next) {
		this.archived = [...new Set(next)];
		this.invalidate();
	}
}

function makeModel(views, archived) {
	return new FakeModel(views, archived);
}

const views = [
	{ workspaceId: "ws-alpha", path: "C:\\work\\alpha", title: "Alpha", sessionIds: ["s1"] },
	{ workspaceId: "ws-beta", path: "C:\\work\\beta", title: "Beta", sessionIds: ["s2", "s2b"] },
	{ workspaceId: "ws-gamma", path: "C:\\work\\gamma", title: "", sessionIds: ["s3"] }
];

// ------------------------------------------------------- fake host registry
// Mirrors @michengai/dsh-archive-manager's workspaceRegistry remote: batch
// archive/unarchive plus single-session unarchive, each resolving to
// {ok:true,value} or {ok:false,error}. It mutates the Model so the plugin's
// post-call verification reads a realistic archived set.
function makeRegistry(model, options = {}) {
	const calls = [];
	const failUnarchive = { value: false };
	const registry = {
		calls,
		failUnarchive,
		async archiveSessions(sessionIds) {
			calls.push({ op: "archiveMany", sessionIds: [...sessionIds] });
			if (options.noArchiveSessions === true) return { ok: false, error: { message: "not implemented" } };
			model.setArchived([...model.peek().archivedSessionIds, ...sessionIds]);
			return { ok: true, value: { archivedSessionIds: model.peek().archivedSessionIds, archivedSessionIdsAdded: [...sessionIds] } };
		},
		async unarchiveSessions(target) {
			calls.push({ op: "unarchiveMany", target });
			if (failUnarchive.value) return { ok: false, error: { message: "boom" } };
			const remove = new Set(target.sessionIds ?? []);
			model.setArchived(model.peek().archivedSessionIds.filter((id) => !remove.has(id)));
			return { ok: true, value: { archivedSessionIds: model.peek().archivedSessionIds, unarchivedSessionIds: [...remove] } };
		}
	};
	if (options.singleUnarchive === true) {
		registry.unarchiveSession = async (sessionId) => {
			calls.push({ op: "unarchiveOne", sessionId });
			if (failUnarchive.value) return { ok: false, error: { message: "boom" } };
			model.setArchived(model.peek().archivedSessionIds.filter((id) => id !== sessionId));
			return { ok: true, value: { archivedSessionIds: model.peek().archivedSessionIds } };
		};
	}
	if (options.noUnarchiveSessions === true) delete registry.unarchiveSessions;
	return registry;
}

// ------------------------------------------------------------------ ctx stub
function makeCtx(model, options = {}) {
	const registrations = [];
	const dictionaries = [];
	const effects = [];
	const archiveOneCalls = [];
	let refreshCount = 0;
	const workspaces = { list: model };
	if (options.noClientArchive !== true) {
		workspaces.archiveSession = async (sessionId) => {
			archiveOneCalls.push(sessionId);
			model.setArchived([...model.peek().archivedSessionIds, sessionId]);
			return { ok: true, value: { archivedSessionIds: model.peek().archivedSessionIds } };
		};
	}
	const services = { workspaces };
	if (options.registry !== undefined) services["remote.workspaceRegistry"] = options.registry;
	if (options.withSessions !== false) {
		services.sessions = { refresh: async () => { refreshCount += 1; } };
	}

	// --- cordis ctx.inject(["remote.workspaceRegistry"], cb) emulation --------
	// cordis starts the nested fiber the moment every dependency is provided and
	// runs the callback's returned disposer when the fiber is disposed. `provide`
	// / `unprovide` let a scenario deliver the namespace *after* apply(), which
	// is what @michengai/dsh-archive-manager actually does.
	const injected = [];
	const injectedScopes = [];
	function scopeFor(deps) {
		const scope = {
			get: (name) => services[name],
			remote: {}
		};
		for (const name of deps) {
			if (name.startsWith("remote.")) scope.remote[name.slice("remote.".length)] = services[name];
		}
		injectedScopes.push(scope);
		return scope;
	}
	function startReadyFibers() {
		for (const record of injected) {
			if (record.disposed || record.disposers.length > 0) continue;
			if (!record.deps.every((name) => services[name] !== undefined)) continue;
			const out = record.callback(scopeFor(record.deps));
			if (typeof out === "function") record.disposers.push(out);
		}
	}
	function provide(name, value) {
		services[name] = value;
		startReadyFibers();
	}
	/** Put a service in the store WITHOUT telling anyone -- simulates a
	 *  registry we never learned about through cordis. */
	function setService(name, value) {
		services[name] = value;
	}
	function unprovide(name) {
		delete services[name];
		for (const record of injected) {
			for (const dispose of record.disposers.splice(0)) dispose();
		}
	}

	return {
		registrations,
		dictionaries,
		archiveOneCalls,
		injected,
		provide,
		setService,
		unprovide,
		refreshCount: () => refreshCount,
		get: (name) => services[name],
		effect(fn, label) {
			effects.push(label);
			fn();
			return () => {};
		},
		inject(deps, callback) {
			if (options.noCtxInject === true) throw new Error("ctx.inject is unavailable (simulated)");
			const record = { deps: [...deps], callback, disposers: [], disposed: false };
			injected.push(record);
			startReadyFibers();
			return {
				dispose() {
					record.disposed = true;
					for (const dispose of record.disposers.splice(0)) dispose();
				}
			};
		},
		locale: {
			register(ns, dict) {
				dictionaries.push({ ns, dict });
				return () => {};
			},
			bind: (ns) => (key, params) => {
				const dict = dictionaries.find((entry) => entry.ns === ns)?.dict.zh ?? {};
				let text = dict[key] ?? key;
				if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
				return text;
			}
		},
		slots: {
			inject(target, fn) {
				fn();
				return () => {};
			},
			register(regOptions, component) {
				registrations.push({ options: regOptions, component });
				return () => {};
			}
		}
	};
}

// -------------------------------------------------------------- bundle loader
async function loadBundle(primitives, storage = makeStorage()) {
	let captured = null;
	globalThis.window = {
		localStorage: storage,
		__ModuleLoader__: {
			load(spec) {
				captured = spec;
			}
		}
	};
	// Fresh module instance per load so state does not leak between scenarios.
	const url = `${pathToFileURL(join(root, "lib", "client.js")).href}?v=${Math.random()}`;
	await import(url);
	if (captured === null) throw new Error("client bundle never called __ModuleLoader__.load");
	const requireStub = (id) => {
		if (id === "react") return reactStub;
		if (id === "@deepseek-ai/dsh-client-ui-primitives") {
			if (primitives === null) throw new Error("primitives unavailable (simulated)");
			return primitives;
		}
		throw new Error(`unexpected require("${id}")`);
	};
	const exports = captured.factory(requireStub);
	return { exports, storage, id: captured.id };
}

/** Load + apply with a fresh module, returning everything a scenario needs. */
async function boot(model, options = {}) {
	const bundle = await loadBundle(primitivesStub, options.storage ?? makeStorage());
	const ctx = makeCtx(model, options);
	const dispose = bundle.exports.apply(ctx);
	const t = ctx.locale.bind("workspace-hide");
	return { ...bundle, ctx, dispose, t, test: bundle.exports.__test };
}

// =============================================================== scenario 1
section("scenario 1: hide/unhide with a full archive bridge");
{
	const model = makeModel(views);
	const registry = makeRegistry(model);
	const { exports, storage, ctx, dispose, t, test } = await boot(model, { registry });

	eq(exports.name, "dsh-workspace-hide", "exports.name");
	ok(Array.isArray(exports.inject) && exports.inject.includes("workspaces"), "exports.inject declares workspaces");
	eq(typeof exports.apply, "function", "exports.apply is a function");
	ok(ctx.dictionaries.length === 1, "locale dictionary registered");
	ok(ctx.dictionaries[0].dict.zh !== undefined && ctx.dictionaries[0].dict.en !== undefined, "dictionary has zh + en");
	eq(ctx.registrations.length, 1, "exactly one slot registration");
	const reg = ctx.registrations[0];
	eq(reg.options.name, "settings.section", "registers into settings.section");
	eq(reg.options.id, "workspace-hide", "list slot has an id");
	eq(reg.options.order, 19, "order is 19");
	const railLabel = reg.options.label();
	eq(railLabel, "工作区显示", "label resolves through the zh dictionary");
	// 设置页左侧导航栏会把长标签截断成「侧边栏显示的工…」，中文标签必须短。
	ok(railLabel.length <= 6, `rail label stays short enough for the settings nav (${railLabel.length} chars)`);
	eq(ctx.dictionaries[0].dict.en["section.label"], "Workspace visibility", "en rail label mirrors the short zh one");
	ok(
		ctx.dictionaries[0].dict.en["section.title"].length > ctx.dictionaries[0].dict.en["section.label"].length,
		"the full wording lives in section.title, not in the nav label"
	);

	const api = test.resolveApi(ctx);
	ok(api.canArchive === true && api.canRestore === true, "both archive + restore detected");
	ok(api.archiveMany !== null && api.unarchiveMany !== null, "batch registry methods picked up");
	ok(api.refresh !== null, "sessions.refresh picked up");

	// --- baseline: nothing hidden, raw snapshot handed back by identity
	const before = model.getSnapshot();
	const wrapped = model.getSnapshot;
	const pass = model.getSnapshot();
	ok(pass === before, "with nothing hidden, the raw snapshot object is returned unchanged");

	let notified = 0;
	const off = model.subscribe(() => { notified += 1; });

	await test.hideWorkspace("ws-beta");
	await tick();
	ok(notified >= 1, "hide() notifies sidebar subscribers");
	const filtered = model.getSnapshot();
	eq(filtered.items.length, 2, "hidden workspace removed from the snapshot");
	ok(!filtered.items.some((item) => item.workspaceId === "ws-beta"), "ws-beta is gone");
	deepEq(filtered.archivedSessionIds, ["s2", "s2b"], "hidden workspace's sessions injected into archivedSessionIds");
	eq(filtered.state, "ready", "other snapshot fields preserved");
	ok(model.getSnapshot() === filtered, "getSnapshot stays referentially stable across calls");
	ok(filtered !== before, "a filtered snapshot is a distinct object from the raw one");
	eq(model.peek().archivedSessionIds.length, 2, "host really archived both sessions");
	deepEq(registry.calls.map((c) => c.op), ["archiveMany"], "used the batch archive path");
	deepEq(registry.calls[0].sessionIds, ["s2", "s2b"], "batch archive got exactly the workspace's sessions");
	ok(ctx.refreshCount() >= 1, "session list refreshed after archiving");

	// --- hiding twice is a no-op, unhiding an unknown id is a no-op
	const notifiedAfterHide = notified;
	await test.hideWorkspace("ws-beta");
	await test.showWorkspace("never-hidden");
	eq(notified, notifiedAfterHide, "hiding twice / unhiding an unknown id does not notify again");

	// --- persistence: v2 object with the per-workspace session record
	deepEq(
		JSON.parse(storage.map.get("dsh-workspace-hide.hidden.v2")),
		{ hidden: { "ws-beta": ["s2", "s2b"] }, pending: [] },
		"v2 record persisted to localStorage"
	);

	// --- underlying model changes still flow through
	model.setItems([...views, { workspaceId: "ws-delta", path: "C:\\work\\delta", title: "Delta", sessionIds: [] }]);
	const afterAdd = model.getSnapshot();
	eq(afterAdd.items.length, 3, "new workspace appears, ws-beta still hidden");
	ok(afterAdd !== filtered, "a new underlying version yields a new snapshot object");

	// --- management snapshot sees hidden rows too
	const manage = test.getManageSnapshot();
	eq(manage.items.length, 4, "manage view sees every workspace, including hidden ones");
	ok(manage.hidden instanceof Set && manage.hidden.has("ws-beta"), "manage view exposes the hidden set");
	ok(manage.records.get("ws-beta").length === 2, "manage view exposes the archived-session record");
	eq(manage.canRestore, true, "manage view reports restore availability");
	ok(test.getManageSnapshot() === manage, "manage snapshot is referentially stable");

	// --- shallow render
	switchProps.length = 0;
	const rendered = render(reactStub.createElement(reg.component, { t }));
	ok(rendered.includes("侧边栏显示的工作区"), "section renders its title");
	ok(rendered.includes("共 4 个 · 显示 3 个 · 隐藏 1 个"), "section reports shown/hidden counts");
	ok(rendered.includes("Alpha") && rendered.includes("Beta") && rendered.includes("Delta"), "section lists every workspace");
	ok(rendered.includes("C:\\work\\beta"), "section shows the folder path");
	ok(rendered.includes("[tag:已隐藏]"), "hidden row carries a badge");
	ok(rendered.includes("[tag:已归档 2 个会话]"), "hidden row reports how many sessions were archived");
	ok(rendered.includes("Gamma") === false && rendered.includes("C:\\work\\gamma"), "untitled workspace falls back to its path");
	eq((rendered.match(/\[switch:/g) ?? []).length, 4, "one switch per workspace");
	ok(!rendered.includes("未能自动取消归档"), "no pending warning when everything restored cleanly");
	ok(!rendered.includes("未检测到"), "no display-only warning while a restore path exists");

	// --- switch polarity: ON means "shown in the sidebar", not "hidden"
	eq(switchProps.length, 4, "the renderer saw one switch per workspace");
	eq(switchProps.filter((s) => s.checked === true).length, 3, "shown workspaces have their switch ON");
	eq(switchProps.filter((s) => s.checked !== true).length, 1, "the hidden workspace is the only switch OFF");
	ok(switchProps.filter((s) => s.checked !== true)[0].label.includes("Beta"), "the OFF switch belongs to the hidden workspace");
	ok(switchProps.every((s) => s.label.includes("在侧边栏显示")), "switch name states shown-ness, never hidden-ness");
	ok(rendered.indexOf("Beta") > rendered.indexOf("Delta"), "hidden rows sink below shown rows");

	// --- unhide restores exactly the recorded sessions
	await test.showWorkspace("ws-beta");
	await tick();
	eq(model.getSnapshot().items.length, 4, "unhide brings the workspace back");
	deepEq(model.peek().archivedSessionIds, [], "host archive drained again");
	deepEq(registry.calls.filter((c) => c.op === "unarchiveMany").map((c) => c.target),
		[{ scope: "sessions", sessionIds: ["s2", "s2b"] }], "unarchive targeted exactly the recorded ids");
	deepEq(JSON.parse(storage.map.get("dsh-workspace-hide.hidden.v2")), { hidden: {}, pending: [] }, "record cleared on unhide");
	ok(model.getSnapshot().archivedSessionIds.length === 0, "injected ids disappear once nothing is hidden");
	ok(model.getSnapshot() === model.getSnapshot(), "stable after unhide");

	// --- restoreAll from the toolbar
	await test.hideWorkspace("ws-alpha");
	await test.hideWorkspace("ws-gamma");
	eq(model.getSnapshot().items.length, 2, "two workspaces hidden");
	const notifiedBefore = notified;
	await test.restoreAll();
	await tick();
	eq(model.getSnapshot().items.length, 4, "restoreAll brings every workspace back");
	ok(notified > notifiedBefore, "restoreAll notified subscribers");
	deepEq(JSON.parse(storage.map.get("dsh-workspace-hide.hidden.v2")), { hidden: {}, pending: [] }, "restoreAll clears the record");
	deepEq(model.peek().archivedSessionIds, [], "restoreAll unarchived everything it archived");

	// --- switch polarity, live: OFF must hide, ON must show
	switchProps.length = 0;
	render(reactStub.createElement(reg.component, { t }));
	eq(switchProps.length, 4, "all four switches render once nothing is hidden");
	ok(switchProps.every((s) => s.checked === true), "after 全部显示 every switch reads ON");
	const alphaSwitch = switchProps.find((s) => s.label.includes("Alpha"));
	await alphaSwitch.onChange(false);
	await tick();
	ok(test.isHidden("ws-alpha"), "turning a switch OFF hides that workspace");
	eq(model.getSnapshot().items.length, 3, "and it leaves the sidebar");
	await alphaSwitch.onChange(true);
	await tick();
	ok(!test.isHidden("ws-alpha"), "turning it back ON shows the workspace again");
	eq(model.getSnapshot().items.length, 4, "and it comes back");
	deepEq(JSON.parse(storage.map.get("dsh-workspace-hide.hidden.v2")), { hidden: {}, pending: [] },
		"the round trip leaves the record empty");

	// --- stale entries in the manage view
	await test.hideWorkspace("ws-vanished");
	ok(test.getManageSnapshot().hidden.has("ws-vanished"), "stale id kept in the hidden set");
	const renderedStale = render(reactStub.createElement(reg.component, { t }));
	ok(renderedStale.includes("[tag:已失效]"), "stale hidden entry is flagged as missing");
	ok(renderedStale.includes("移除记录"), "stale entry offers a forget button");

	// --- dispose restores the model exactly
	const ownBefore = Object.getOwnPropertyDescriptor(model, "getSnapshot");
	ok(ownBefore !== undefined && ownBefore.value === wrapped, "while applied: our wrapper is an own property");
	off();
	dispose();
	ok(model.getSnapshot !== wrapped, "wrapper removed after dispose");
	eq(model.getSnapshot, FakeModel.prototype.getSnapshot, "prototype method visible again after dispose");
	eq(model.subscribe, FakeModel.prototype.subscribe, "prototype subscribe restored after dispose");
	eq(Object.getOwnPropertyDescriptor(model, "getSnapshot"), undefined, "own property removed on dispose");
	eq(model.getSnapshot().items.length, 4, "unfiltered again after dispose");
}

// =============================================================== scenario 1b
section("scenario 1b: sessions archived BEFORE hiding stay archived");
{
	const model = makeModel(views, ["s2"]);
	const registry = makeRegistry(model);
	const { test } = await boot(model, { registry });

	await test.hideWorkspace("ws-beta");
	await tick();
	deepEq(registry.calls.filter((c) => c.op === "archiveMany")[0].sessionIds, ["s2b"],
		"only the not-yet-archived session is archived");
	deepEq(test.getManageSnapshot().records.get("ws-beta"), ["s2b"], "the pre-archived session is not recorded");
	deepEq(model.getSnapshot().archivedSessionIds, ["s2", "s2b"], "snapshot union still covers both");

	await test.showWorkspace("ws-beta");
	await tick();
	deepEq(model.peek().archivedSessionIds, ["s2"], "the pre-existing archive is left untouched by unhide");
	deepEq([...test.getManageSnapshot().pending], [], "and is not parked as pending");
}

// =============================================================== scenario 1c
section("scenario 1c: no unarchive capability -> display-only, host untouched");
{
	const model = makeModel(views);
	// A workspaces service with archiveSession but NO archive-manager registry.
	const { ctx, t, test } = await boot(model, {});
	const api = test.resolveApi(ctx);
	eq(api.canRestore, false, "canRestore is false without a registry");
	eq(api.canArchive, true, "canArchive is true because the workspaces service exists");
	ok(test.resolveApi({ get: () => undefined }).canArchive === false, "no services at all -> canArchive false");

	let notified = 0;
	model.subscribe(() => { notified += 1; });
	await test.hideWorkspace("ws-beta");
	await tick();
	eq(model.getSnapshot().items.length, 2, "sidebar hiding still works");
	deepEq(model.getSnapshot().archivedSessionIds, ["s2", "s2b"], "the union still keeps sessions out of 未分组");
	eq(notified, 1, "display-only hiding notifies exactly once (the host is not touched)");
	deepEq(ctx.archiveOneCalls, [], "the host archive was deliberately left untouched");
	deepEq(model.peek().archivedSessionIds, [], "host state unchanged");
	const rendered = render(reactStub.createElement(ctx.registrations[0].component, { t }));
	ok(rendered.includes("未检测到"), "settings page explains the display-only fallback");
	ok(rendered.includes("只作用于侧边栏显示"), "and says sessions are not really archived");

	await test.showWorkspace("ws-beta");
	await tick();
	deepEq(model.peek().archivedSessionIds, [], "nothing to restore, host still untouched");
	deepEq([...test.getManageSnapshot().pending], [], "no pending entries in display-only mode");
	eq(model.getSnapshot().items.length, 3, "the workspace comes straight back");
}

// ============================================================== scenario 1c2
section("scenario 1c2: archive-manager mounts workspaceRegistry AFTER our apply()");
{
	// The real archive-manager does `await remote.$mount(ARCHIVE_MANAGER_REMOTE)`
	// inside its own async apply (lib/client.js:3926-3930). Sibling plugins that
	// run earlier therefore cannot see `remote.workspaceRegistry` yet -- the two
	// failure modes this scenario pins down are (a) a settings page opened
	// before the namespace lands must stop saying "display only", and (b) an
	// operation run after it lands must really reach the Host.
	const model = makeModel(views);
	const registry = makeRegistry(model);
	const { ctx, t, test, dispose } = await boot(model, {});
	const depsSeen = ctx.injected.map((record) => record.deps);
	eq(ctx.injected.length, 2, "apply() subscribed to both optional namespaces");
	ok(depsSeen.some((deps) => deps.length === 1 && deps[0] === "remote.workspaceRegistry"),
		"one of them is exactly the registry namespace");
	ok(depsSeen.some((deps) => deps.length === 1 && deps[0] === "sessions"),
		"the other is exactly the sessions service (refresh hook only)");
	eq(test.state.registry, null, "no registry exists at apply time");
	eq(test.getManageSnapshot().canRestore, false, "settings page starts in display-only mode");
	ok(!render(reactStub.createElement(ctx.registrations[0].component, { t })).includes("未检测到"),
		"no warning while nothing is hidden yet (there is no display-only state to explain)");

	let notified = 0;
	model.subscribe(() => { notified += 1; });

	// --- display-only hide while the namespace is still missing
	await test.hideWorkspace("ws-beta");
	await tick();
	ok(render(reactStub.createElement(ctx.registrations[0].component, { t })).includes("未检测到"),
		"and renders the display-only warning once something IS hidden");
	deepEq(model.peek().archivedSessionIds, [], "the Host archive is still left alone");
	deepEq([...test.getManageSnapshot().records.get("ws-beta")], ["s2", "s2b"], "the ids are recorded for later");
	await test.showWorkspace("ws-beta");
	await tick();
	deepEq([...test.getManageSnapshot().pending], [], "nothing to restore, nothing pending");

	// --- the namespace lands late: cordis starts our injected fiber
	const notifiedBefore = notified;
	const manageBefore = test.getManageSnapshot();
	ctx.provide("remote.workspaceRegistry", registry);
	eq(test.state.registry, registry, "the injected fiber adopted the late service");
	ok(notified > notifiedBefore, "the capability flip repaints subscribers");
	ok(test.getManageSnapshot() !== manageBefore, "the manage snapshot is rebuilt, not reused");
	eq(test.getManageSnapshot().canRestore, true, "settings page now offers restore");
	ok(!render(reactStub.createElement(ctx.registrations[0].component, { t })).includes("未检测到"),
		"the display-only warning is gone");
	deepEq(ctx.archiveOneCalls, [], "we prefer the batch remote over the per-session client command");

	// --- and it is really used from then on
	await test.hideWorkspace("ws-beta");
	await tick();
	deepEq(registry.calls.map((c) => c.op), ["archiveMany"], "hide now archives through the registry");
	deepEq(model.peek().archivedSessionIds, ["s2", "s2b"], "Host archive reflects the hide");
	deepEq(model.getSnapshot().archivedSessionIds, ["s2", "s2b"], "sidebar union unchanged");
	await test.showWorkspace("ws-beta");
	await tick();
	deepEq(model.peek().archivedSessionIds, [], "unhide really unarchives through the registry");
	eq(registry.calls.filter((c) => c.op === "unarchiveMany").length, 1, "exactly one batch unarchive");
	deepEq(registry.calls[1].target, { scope: "sessions", sessionIds: ["s2", "s2b"] }, "unarchive targeted the recorded ids");

	// --- the namespace going away drops us back to display-only
	ctx.unprovide("remote.workspaceRegistry");
	eq(test.state.registry, null, "disposal clears the adopted service");
	eq(test.getManageSnapshot().canRestore, false, "and the settings page drops back to display-only");

	// --- belt and braces: a registry nobody told us about is still picked up,
	// because every Host operation re-derives the bridge at call time.
	const latecomer = makeRegistry(model);
	ctx.setService("remote.workspaceRegistry", latecomer);
	eq(test.state.registry, null, "cordis never told us (simulated)");
	await test.hideWorkspace("ws-alpha");
	await tick();
	deepEq(latecomer.calls.map((c) => c.op), ["archiveMany"], "call-time re-resolution still finds it");
	deepEq(model.peek().archivedSessionIds, ["s1"], "and the Host archive is updated");
	await test.showWorkspace("ws-alpha");
	await tick();
	deepEq(model.peek().archivedSessionIds, [], "the same path unarchives it again");

	dispose();
	eq(test.state.ctx, null, "dispose() drops the ctx reference");
	eq(test.state.registry, null, "dispose() drops the registry");
	eq(test.state.sessions, null, "dispose() drops the sessions service");
	eq(test.state.api, null, "dispose() drops the bridge");
}

// =============================================================== scenario 1c3
section("scenario 1c3: a client runtime without ctx.inject still works");
{
	const model = makeModel(views);
	const registry = makeRegistry(model);
	const { ctx, test } = await boot(model, { noCtxInject: true, registry });
	eq(ctx.injected.length, 0, "no fiber was created");
	eq(test.state.registry, null, "no injected adoption happened");
	eq(test.state.sessions, null, "no sessions adoption happened either");
	eq(test.getManageSnapshot().canRestore, true, "the bridge resolved at apply time is still reported");
	await test.hideWorkspace("ws-beta");
	await tick();
	deepEq(registry.calls.map((c) => c.op), ["archiveMany"], "and the Host archive is really used");
}

// =============================================================== scenario 1c4
section("scenario 1c4: a service that is NOT in our inject list may never be read as a property");
{
	// The real cordis ctx is a reflect proxy: reading `ctx.sessions` when
	// `sessions` is not in our inject list throws
	//   cannot get property "sessions" without inject
	// (reflect.ts:144). `ctx.get(name)` does not throw for that reason, but it
	// still yields undefined while the providing fiber is inactive -- a normal
	// state during boot. This scenario pins down that apply(), and every later
	// call, survives that world instead of taking the whole renderer down.
	//
	// Regression: v0.1.1 did `ctx.get("sessions") ?? ctx.sessions` in
	// resolveApi(), reached unconditionally from apply(), and the boot-time
	// race turned into a hard renderer failure.
	const model = makeModel(views);
	const registry = makeRegistry(model);

	/** Wrap the ctx stub so unknown property reads throw like cordis does. */
	function cordisLike(ctx) {
		return new Proxy(ctx, {
			get(target, prop, receiver) {
				if (typeof prop === "symbol" || prop in target) return Reflect.get(target, prop, receiver);
				throw new Error(`cannot get property "${String(prop)}" without inject`);
			}
		});
	}

	// --- A: the sessions service is simply not there yet
	{
		const bundle = await loadBundle(primitivesStub, makeStorage());
		const raw = makeCtx(model, { registry, withSessions: false });
		const ctx = cordisLike(raw);
		let threw = null;
		let dispose = null;
		try {
			dispose = bundle.exports.apply(ctx);
		} catch (error) {
			threw = error;
		}
		eq(threw, null, "apply() does not throw when ctx.sessions is unreadable");
		const test = bundle.exports.__test;
		eq(test.state.ctx !== null, true, "the plugin stayed active");
		eq(raw.injected.length, 2, "both optional fibers were still created");
		eq(test.state.registry, registry, "the registry was adopted as usual");
		eq(test.state.sessions, null, "and sessions degraded to null");
		eq(test.resolveApi(ctx).refresh, null, "refresh is null instead of an exception");
		eq(test.resolveApi(ctx).canArchive, true, "archiving still works through workspaces");
		eq(typeof dispose, "function", "and a disposer was still returned");
	}

	// --- B: nothing optional is available at all -- must still not throw
	{
		const bundle = await loadBundle(primitivesStub, makeStorage());
		const raw = makeCtx(model, { withSessions: false, noCtxInject: true });
		const ctx = cordisLike(raw);
		let threw = null;
		try {
			bundle.exports.apply(ctx);
		} catch (error) {
			threw = error;
		}
		eq(threw, null, "apply() survives a ctx with no optional services at all");
		eq(bundle.exports.__test.state.ctx !== null, true, "the plugin still mounted");
		eq(raw.registrations.length, 1, "and the settings section was still registered");
	}
}

// =============================================================== scenario 1d
section("scenario 1d: single-session fallbacks");
{
	// Registry with archiveSessions + unarchiveSession only (no batch unarchive).
	const model = makeModel(views);
	const registry = makeRegistry(model, { singleUnarchive: true, noUnarchiveSessions: true });
	const { test } = await boot(model, { registry });
	const api = test.resolveApi({ get: (n) => (n === "remote.workspaceRegistry" ? registry : undefined) });
	ok(api.unarchiveMany === null && api.unarchiveOne !== null, "only the per-session unarchive is available");
	ok(api.canRestore === true, "per-session unarchive still counts as a restore path");

	await test.hideWorkspace("ws-beta");
	await tick();
	await test.showWorkspace("ws-beta");
	await tick();
	deepEq(registry.calls.filter((c) => c.op === "unarchiveOne").map((c) => c.sessionId), ["s2", "s2b"],
		"per-session unarchive called once per recorded id");
	deepEq(model.peek().archivedSessionIds, [], "host archive drained");

	// Archive fallback: registry with unarchiveMany but a failing batch archive.
	const model2 = makeModel(views);
	const registry2 = makeRegistry(model2, { noArchiveSessions: true });
	const boot2 = await boot(model2, { registry: registry2 });
	await boot2.test.hideWorkspace("ws-beta");
	await tick();
	deepEq(boot2.ctx.archiveOneCalls, ["s2", "s2b"], "falls back to workspaces.archiveSession one by one");
	deepEq(model2.peek().archivedSessionIds, ["s2", "s2b"], "host archive still ended up consistent");
}

// =============================================================== scenario 1e
section("scenario 1e: failed unarchive -> pending + retry");
{
	const model = makeModel(views);
	const registry = makeRegistry(model);
	const { ctx, t, test } = await boot(model, { registry });
	await test.hideWorkspace("ws-beta");
	await tick();

	registry.failUnarchive.value = true;
	await test.showWorkspace("ws-beta");
	await tick();
	eq(model.getSnapshot().items.length, 3, "the workspace still reappears even when restore fails");
	deepEq(model.peek().archivedSessionIds, ["s2", "s2b"], "sessions stayed archived");
	deepEq([...test.getManageSnapshot().pending].sort(), ["s2", "s2b"], "both ids parked as pending");

	const rendered = render(reactStub.createElement(ctx.registrations[0].component, { t }));
	ok(rendered.includes("未能自动取消归档"), "settings page warns about the pending sessions");
	ok(rendered.includes("重试恢复") && rendered.includes("忽略"), "retry + dismiss buttons rendered");
	ok(rendered.includes("全部显示"), "restore-all is enabled so pending ids are reachable too");

	// retry succeeds once the host recovers
	registry.failUnarchive.value = false;
	await test.retryRestore();
	await tick();
	deepEq([...test.getManageSnapshot().pending], [], "retry clears pending once the host recovers");
	deepEq(model.peek().archivedSessionIds, [], "sessions really restored");
	ok(!render(reactStub.createElement(ctx.registrations[0].component, { t })).includes("未能自动取消归档"),
		"warning disappears after a successful retry");

	// dismiss drops the record without touching the host
	const model2 = makeModel(views);
	const registry2 = makeRegistry(model2);
	const boot2 = await boot(model2, { registry: registry2 });
	await boot2.test.hideWorkspace("ws-beta");
	await tick();
	registry2.failUnarchive.value = true;
	await boot2.test.showWorkspace("ws-beta");
	await tick();
	boot2.test.dismissPending();
	deepEq([...boot2.test.getManageSnapshot().pending], [], "dismiss clears the pending list");

	// restoreAll also retries pending ids
	const model3 = makeModel(views);
	const registry3 = makeRegistry(model3);
	const boot3 = await boot(model3, { registry: registry3 });
	await boot3.test.hideWorkspace("ws-beta");
	await tick();
	registry3.failUnarchive.value = true;
	await boot3.test.showWorkspace("ws-beta");
	await tick();
	registry3.failUnarchive.value = false;
	await boot3.test.restoreAll();
	await tick();
	deepEq(model3.peek().archivedSessionIds, [], "restoreAll retried the pending id and succeeded");
}

// =============================================================== scenario 1f
section("scenario 1f: v1 -> v2 migration");
{
	const storage = makeStorage();
	storage.setItem("dsh-workspace-hide.hidden.v1", JSON.stringify(["ws-gamma"]));
	const model = makeModel(views);
	const { test } = await boot(model, { registry: makeRegistry(model), storage });
	eq(model.getSnapshot().items.length, 2, "v1 entry still hides its workspace");
	ok(!model.getSnapshot().items.some((item) => item.workspaceId === "ws-gamma"), "ws-gamma hidden after migration");
	deepEq(JSON.parse(storage.map.get("dsh-workspace-hide.hidden.v2")), { hidden: { "ws-gamma": [] }, pending: [] },
		"v1 entry rewritten as a v2 record");
	eq(storage.map.has("dsh-workspace-hide.hidden.v1"), false, "the v1 key is removed");
	ok(model.getSnapshot().archivedSessionIds.length === 0, "migrated entries archive nothing retroactively");
	eq(test.getManageSnapshot().records.get("ws-gamma").length, 0, "no phantom archived-session record");

	// A corrupt legacy value must not break startup.
	const storage2 = makeStorage();
	storage2.setItem("dsh-workspace-hide.hidden.v1", "{not json");
	const model2 = makeModel(views);
	await boot(model2, { registry: makeRegistry(model2), storage: storage2 });
	eq(model2.getSnapshot().items.length, 3, "a corrupt v1 value is ignored, nothing hidden");
}

// =============================================================== scenario 2
section("scenario 2: v2 state survives a reload");
{
	const storage = makeStorage();
	const model = makeModel(views);
	const registry = makeRegistry(model);
	const first = await boot(model, { registry, storage });
	await first.test.hideWorkspace("ws-gamma");
	await tick();

	const model2 = makeModel(views, model.peek().archivedSessionIds);
	const second = await boot(model2, { registry: makeRegistry(model2), storage });
	eq(model2.getSnapshot().items.length, 2, "hidden workspace stays hidden after a reload");
	deepEq(second.test.getManageSnapshot().records.get("ws-gamma"), ["s3"], "the archived-session record survived the reload");
	deepEq(model2.getSnapshot().archivedSessionIds, ["s3"], "the union is rebuilt from the record on load");

	// A corrupt v2 value must not break startup either.
	const storage3 = makeStorage();
	storage3.setItem("dsh-workspace-hide.hidden.v2", '{"hidden":"nope"}');
	const model3 = makeModel(views);
	await boot(model3, { storage: storage3 });
	eq(model3.getSnapshot().items.length, 3, "a malformed v2 value degrades to nothing hidden");
}

// =============================================================== scenario 3
section("scenario 3: primitives unavailable (fallback controls)");
{
	const model = makeModel(views);
	const bundle = await loadBundle(null);
	const ctx = makeCtx(model, { registry: makeRegistry(model) });
	const dispose = bundle.exports.apply(ctx);
	await bundle.exports.__test.hideWorkspace("ws-alpha");
	const reg = ctx.registrations[0];
	const rendered = render(reactStub.createElement(reg.component, { t: ctx.locale.bind("workspace-hide") }));
	ok(rendered.includes("侧边栏显示的工作区"), "fallback path still renders the title");
	ok(rendered.includes("共 3 个 · 显示 2 个 · 隐藏 1 个"), "fallback path still reports the count");
	ok(rendered.includes("全部显示"), "fallback path renders the restore button");
	ok(rendered.includes("已隐藏"), "fallback path renders a badge");
	dispose();
}

// =============================================================== scenario 4
section("scenario 4: hostile environments");
{
	// 4a: a model whose getSnapshot/subscribe are missing.
	const broken = { items: views.slice() };
	const bundle = await loadBundle(primitivesStub);
	const ctx = makeCtx(broken, { registry: makeRegistry(makeModel(views)) });
	const dispose = bundle.exports.apply(ctx);
	eq(bundle.exports.__test.getViewSnapshot().items.length, 0, "no crash without a model; empty view");
	ok(ctx.registrations.length === 1, "settings section still registers without a model");
	await bundle.exports.__test.hideWorkspace("ws-alpha");
	ok(true, "hiding without a model is a harmless no-op");
	dispose();

	// 4b: getSnapshot present but subscribe missing -> install refuses.
	const halfBroken = { getSnapshot: () => ({ items: views.slice() }) };
	const originalGet = halfBroken.getSnapshot;
	const bundle2 = await loadBundle(primitivesStub);
	const ctx2 = makeCtx(halfBroken);
	const dispose2 = bundle2.exports.apply(ctx2);
	eq(halfBroken.getSnapshot, originalGet, "no wrapper installed when subscribe is missing");
	eq(bundle2.exports.__test.getManageSnapshot().items.length, 3, "manage view still reads through");
	dispose2();

	// 4c: a throwing unarchive must not break the toggle, and the ids the Host
	// still reports as archived have to be parked for a retry rather than lost.
	const model3 = makeModel(views);
	const hostileRegistry = {
		archiveSessions: async (sessionIds) => {
			model3.setArchived([...model3.peek().archivedSessionIds, ...sessionIds]);
			return { ok: true, value: { archivedSessionIds: model3.peek().archivedSessionIds } };
		},
		unarchiveSessions: async () => { throw new Error("transport died"); }
	};
	const boot3 = await boot(model3, { registry: hostileRegistry });
	await boot3.test.hideWorkspace("ws-beta");
	await tick();
	eq(model3.getSnapshot().items.length, 2, "hiding survives a throwing archive call");
	deepEq(model3.peek().archivedSessionIds, ["s2", "s2b"], "the archive itself went through");
	await boot3.test.showWorkspace("ws-beta");
	await tick();
	eq(model3.getSnapshot().items.length, 3, "unhiding survives a throwing unarchive call");
	deepEq([...boot3.test.getManageSnapshot().pending].sort(), ["s2", "s2b"], "unreachable ids end up pending, not lost");
	deepEq(model3.peek().archivedSessionIds, ["s2", "s2b"], "and are still archived, so the user can retry");

	// A rejected batch archive must fall back to the per-session command.
	const model3b = makeModel(views);
	const registry3b = {
		archiveSessions: async () => ({ ok: false, error: { message: "batch unavailable" } }),
		unarchiveSessions: async () => ({ ok: true, value: {} })
	};
	const boot3b = await boot(model3b, { registry: registry3b });
	await boot3b.test.hideWorkspace("ws-beta");
	await tick();
	deepEq(boot3b.ctx.archiveOneCalls, ["s2", "s2b"], "a rejected batch archive retries per session");
	deepEq(model3b.peek().archivedSessionIds, ["s2", "s2b"], "the host ends up archived anyway");

	// 4d: localStorage that throws on read and write.
	const model4 = makeModel(views);
	let captured = null;
	globalThis.window = {
		localStorage: {
			getItem() { throw new Error("denied"); },
			setItem() { throw new Error("denied"); },
			removeItem() { throw new Error("denied"); }
		},
		__ModuleLoader__: { load(spec) { captured = spec; } }
	};
	const url = `${pathToFileURL(join(root, "lib", "client.js")).href}?v=${Math.random()}`;
	await import(url);
	const exports4 = captured.factory((id) => (id === "react" ? reactStub : primitivesStub));
	const ctx4 = makeCtx(model4, { registry: makeRegistry(model4) });
	const dispose4 = exports4.apply(ctx4);
	await exports4.__test.hideWorkspace("ws-alpha");
	eq(model4.getSnapshot().items.length, 2, "hiding still works when localStorage throws");
	dispose4();

	// 4e: double installation is refused.
	const model5 = makeModel(views);
	const boot5 = await boot(model5, { registry: makeRegistry(model5) });
	eq(boot5.test.install(model5), null, "second install on the same model is refused");
	boot5.dispose();
}

// =============================================================== scenario 5
section("scenario 5: listener lifecycle");
{
	const model = makeModel(views);
	const boot5 = await boot(model, { registry: makeRegistry(model) });
	let hits = 0;
	const unsubscribe = model.subscribe(() => { hits += 1; });
	eq(typeof unsubscribe, "function", "wrapped subscribe returns an unsubscribe function");
	eq(model.listeners.size, 1, "listener registered on the underlying model too");
	await boot5.test.hideWorkspace("ws-alpha");
	// Two wake-ups: our own repaint, then the host archive landing on the model.
	eq(hits, 2, "listener notified on hide (repaint + host archive)");
	unsubscribe();
	await boot5.test.restoreAll();
	eq(hits, 2, "unsubscribed listener is no longer notified");
	eq(model.listeners.size, 0, "model listener set drained on unsubscribe");
	boot5.dispose();
}

// =============================================================== package.json
section("scenario 6: package manifest contract");
{
	const manifest = JSON.parse(
		await (await import("node:fs/promises")).readFile(join(root, "package.json"), "utf8")
	);
	eq(manifest.name, "dsh-workspace-hide", "package name");
	eq(manifest.type, "module", "type module");
	eq(manifest.main, "lib/index.js", "main entry");
	eq(manifest.exports["./client"], "./lib/client.js", "exports['./client'] is a plain string");
	eq(manifest.dsh.client.platform, "web", "dsh.client.platform is web");
	eq(manifest.dsh.bundle.patch, "./cordis.patch.yml", "bundle patch declared");
	ok(!("external" in manifest.dsh.client), "no external module table needed");
	// The loader takes the client inject list from package.json, NOT from the
	// bundle's exported `inject` (dsh-client-modules/lib/index.js:145,660).
	// v0.1.1 shipped `[]` here while the code read ctx.locale / ctx.slots /
	// ctx.sessions, which is exactly how the renderer crash got in.
	deepEq(manifest.dsh.client.inject, ["slots", "workspaces", "locale"],
		"dsh.client.inject declares the services the code actually touches");
	ok(!manifest.dsh.client.inject.includes("sessions"),
		"sessions stays optional so a missing service cannot deactivate the plugin");
}

// ================================================================ host half
section("scenario 7: host half loads cleanly");
{
	const host = await import(pathToFileURL(join(root, "lib", "index.js")).href);
	eq(host.name, "dsh-workspace-hide", "host exports name");
	eq(typeof host.apply, "function", "host exports apply");
	ok(Array.isArray(host.inject) && host.inject.length === 0, "host injects no services");
	host.apply();
	ok(true, "host apply() is a harmless no-op");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}  (${checks} checks)`);
process.exit(failures === 0 ? 0 : 1);
