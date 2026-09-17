# dsh-workspace-hide — 设计与实现说明

> README 只保留简介、安装方法与版本更新。原理、接缝、边界、验证方法与源码证据全部收在这里。

## 目录

- [1. 工作原理](#1-工作原理)
  - [1.0 前提：「未分组」溢出是怎么来的](#10-前提未分组溢出是怎么来的)
  - [1.1 两层配合](#11-两层配合)
  - [1.2 为什么宿主层是条件启用](#12-为什么宿主层是条件启用)
  - [1.3 怎么判断「恢复能力」在不在（这一步曾经出过 bug）](#13-怎么判断恢复能力在不在这一步曾经出过-bug)
  - [1.4 记录格式与三个接缝](#14-记录格式与三个接缝)
  - [1.5 几个关键约束](#15-几个关键约束)
- [2. 目录结构](#2-目录结构)
- [3. 验证](#3-验证)
- [4. 已知边界](#4-已知边界)
- [5. 卸载](#5-卸载)
- [6. 核对证据（真机源码）](#6-核对证据真机源码)

---

## 1. 工作原理

### 1.0 前提：「未分组」溢出是怎么来的

官方 `ui-workspace` 的 `groupByWorkspace()`
（`@deepseek-ai/dsh-client-ui-workspace/lib/client.js:389-406`）只统计**可见**工作区名下的
会话，其余在 `sessionVisible()` 通过的全部被塞进 `buildGroup("", …, UNGROUPED_LABEL, stray, …)`。
这就是为什么**任何只把工作区从列表里摘掉的做法，都会把它的会话变成一堆无主的
「未分组」条目**——也正是本插件必须连归档一起处理的根本原因。

### 1.1 两层配合

| 层 | 作用 | 依赖 |
|---|---|---|
| 显示层（永远生效） | 侧边栏拿到的快照里，被隐藏工作区的会话 id 被并入 `archivedSessionIds`，于是它们被侧边栏的归档过滤吃掉，不会变成「未分组」 | 无 |
| 宿主层（有「取消归档」能力时才启用） | 真正调用宿主归档这些会话，使「归档」页、搜索、其它客户端也一致，且清掉 `localStorage` 也不会留残留 | `@michengai/dsh-archive-manager` |

显示层是**同步**的，所以隐藏的一瞬间就生效，不会先闪出一屏「未分组」。

### 1.2 为什么宿主层是条件启用

DSH 内核**根本没有取消归档的能力**：`@deepseek-ai/dsh-workspace` 只会往
`archivedSessionIds` 里追加（`lib/index.js:446`），宿主命令面
（`dsh-api-workspace-controller/lib/types/commands.js`）只有
`create / rename / delete / insertBefore / insertSessionBefore / archiveSession`，
全仓库搜 `unarchive` 零命中。全生态里唯一实现取消归档的是
`@michengai/dsh-archive-manager` 的 `unarchiveSession` / `unarchiveSessions`。

所以：**没有恢复能力时绝不真归档**。否则一旦这份本地清单丢失，会话就永久躺在归档里了。
此时插件退化为纯显示层（会话立刻全部回来、归档状态原样不动），并在设置页明确提示一句。

### 1.3 怎么判断「恢复能力」在不在（这一步曾经出过 bug）

`unarchiveSession` / `unarchiveSessions` 不在任何 cordis 服务上，它们是
`@michengai/dsh-archive-manager` **挂载出来的 remote 命名空间** `workspaceRegistry`。

api-gateway 的客户端挂载一个命名空间的方式，是以 `remote.<namespace>` 为名起一个嵌套插件
（`dsh-api-gateway/lib/client.js:1564-1591`，`remoteServiceKey()` 在 1794），而
archive-manager 是在**它自己的 async apply 里**做这件事的：

```js
// @michengai/dsh-archive-manager/lib/client.js:3926-3930
async function apply(ctx) {
  const remote = ctx.get("remote");
  if (remote !== void 0) disposeRemote = await remote.$mount(ARCHIVE_MANAGER_REMOTE);
  ...
```

也就是说，在**兄弟插件同步执行的 apply 里**，`ctx.get("remote.workspaceRegistry")`
大概率还是 `undefined` —— 即使 archive-manager 明明装着。早期版本只在 apply 时解析一次
并缓存，于是永远报「未检测到」，退化成纯显示层。

现在改成两条独立的路，任何加载顺序都不会错：

| 路子 | 机制 | 作用 |
|---|---|---|
| `ctx.inject(["remote.workspaceRegistry"], …)` | cordis 在服务出现的瞬间启动这个嵌套 fiber，服务消失时销毁它 | 只负责刷新设置页的 `canRestore`（能力翻转会 `notify()` 重绘） |
| `apiNow()` | 每次真操作（隐藏/取消隐藏/刷新会话）**重新解析**一次桥 | 保证晚挂载的 registry 立刻可用，不靠轮询、不靠定时器 |

`inject` 是**可选**依赖：它被写在插件体内部，不在 `exports.inject` 里，
所以没装 archive-manager 时插件照常启动，只是退回纯显示层。
运行时不提供 `ctx.inject` 时也不会抛错（try/catch 兜住，退化为纯 `apiNow()` 路径）。

### 1.4 记录格式与三个接缝

| 接缝 | 做法 |
|---|---|
| 数据 | 包装 `workspaces` 服务的 `list` 模型的 `getSnapshot()` / `subscribe()` |
| 持久化 | `localStorage["dsh-workspace-hide.hidden.v2"]` = `{"hidden":{"<workspaceId>":["<sid>",...]},"pending":["<sid>",...]}` |
| 界面 | 往 `settings.section`（`list` 槽）注册一个 `id: "workspace-hide"` 的条目 |

`hidden` 的 value 是**这次隐藏实际归档掉的会话 id**（没归档就是空数组）；
`pending` 是"取消归档失败、目前仍是归档状态"的 id，用来在设置页提供「重试恢复」。

v1（一个裸的 workspaceId 数组，没有归档记录）会在加载时自动迁移成 v2：这些工作区保持隐藏，
但不会追溯归档任何会话（无法知道当年归档了什么），迁移后删掉旧键。

### 1.5 几个关键约束

以下都已在真机源码里核对过，证据见 [§6](#6-核对证据真机源码)。

- **官方侧边栏是惰性取数**：`ui-workspace/lib/client.js` 里一律写成
  `this.workspaces.list.getSnapshot()`（第 45/82/144/2730 行），是调用时的属性查找，
  不是 apply 时抓走的函数引用。所以包装**不受插件加载顺序影响**。
- **`getSnapshot()` 必须引用稳定**：React 用 `useSyncExternalStore` 订阅它，
  每次返回新对象会无限重渲染。真模型的 `buildSnapshot()` 每个版本重建一个新对象、
  `items` 整体替换（不原地改），因此按 `{快照对象身份, 隐藏清单版本}` 记忆化即可，
  两种变化都精确命中。没隐藏任何东西时直接返回**原对象本身**，不改变任何行为。
- **`sidebar.workspaces` 是 `single` 槽**，不是 `list`。想在那里加一个"已隐藏 N"入口，
  只能连官方整个工作区浏览器一起接管——代价远大于收益，所以**不做**。
- 隐藏项被删掉后 id 会留在清单里，设置页把它标为「已失效」并给一个「移除记录」按钮，
  不做自动清理——自动清理会在列表瞬时为空时误删清单。
- 批量归档（`archiveSessions`）失败时会**逐个**退回 `workspaces.archiveSession`；
  两个都没有才算失败。归档失败只 `console.warn`，不影响侧边栏隐藏。

## 2. 目录结构

```
dsh-workspace-hide/
├── package.json                    # dsh.client.platform = web；dsh.bundle.patch；零 dependencies
├── cordis.patch.yml                # 只 insert 一个空宿主节点，不禁用任何东西
├── LICENSE                         # MIT
├── README.md                       # 简介 / 安装 / 版本更新
├── DESIGN.md                       # 本文件：原理、边界、验证、证据
├── .gitignore
├── .github/
│   └── workflows/
│       └── check.yml               # push / PR 时跑 npm run check + npm test
├── lib/
│   ├── index.js                    # 宿主半边：apply() 故意为空
│   └── client.js                   # 浏览器半边：__ModuleLoader__ 手写工厂，无构建步骤
└── test/
    └── offline-check.mjs           # 离线验证：桩化 loader/require/ctx/localStorage，跑真实 apply
```

## 3. 验证

不启动 DSH、不开浏览器即可验证：

```powershell
cd dsh-workspace-hide
npm run check                    # node --check 两个 bundle，确认能解析
npm test                         # node test/offline-check.mjs —— 195 checks
```

CI（`.github/workflows/check.yml`）在每次 push / PR 时用 `ubuntu-latest` + Node 22
跑同样这两条命令。测试数据里的 `C:\work\alpha` 只是普通字符串（插件把路径当不透明
文本处理），所以整个套件与平台无关。

`test/offline-check.mjs` 桩化了 `window.__ModuleLoader__`、`require`、`localStorage`
和 cordis `ctx`（含一个会真改模型的假 archive-manager 注册表，以及一个能模拟
`ctx.inject` 依赖"晚到"的假 fiber），然后**真的跑一遍** `apply()`：
包装模型 → 隐藏/恢复 → 归档/取消归档 → 浅渲染设置页 → `dispose()` 还原。

覆盖：引用稳定性、监听者通知与退订、v2 持久化与重载、v1 迁移、**隐藏前已归档的会话不被恢复**、
无恢复能力时的纯显示降级、**archive-manager 的 remote 在我们的 apply 之后才挂载**、
**运行时没有 `ctx.inject` 也能靠调用时重解析工作**、批量/逐个归档与取消归档的回退路径、
取消归档失败后的 `pending` + 重试 + 忽略、远程抛异常、`localStorage` 抛异常、模型缺失/半残、
UI 基元库不可用时的降级控件、重复安装拒绝、`dispose` 后原型方法是否原样归还。

## 4. 已知边界

- 只影响**侧边栏的工作区列表**。如果某个会话仍处于打开状态，顶栏/会话本身照常工作；
  插件不拦截任何会话行为。
- 隐藏时归档的会话会出现在「归档」页（这是刻意的：它正是让会话"收起来"的机制）。
  取消隐藏会撤销这批归档；若宿主当时不可达，设置页会提示并允许重试。
- 清单是**按机器 + 按浏览器来源**存的（`localStorage`），不随 DSH 配置同步。
  清掉清单不会自动取消归档——但设置页在清空前的每次隐藏都留了记录，正常路径不会丢。
- 这是一个显示层覆盖。DSH 大版本升级后若官方改了 `workspaces` 模型接口，
  包装可能失效——失效时插件会 `console.warn` 并退化为"什么都不隐藏"，
  不会阻断侧边栏（`install()` 的所有分支都返回 null 而不是抛错）。

## 5. 卸载

从 profile 的 `dsh.profile.bundles` 里移除 `dsh-workspace-hide`，并清掉 `localStorage` 里的
`dsh-workspace-hide.hidden.v2`（和可能残留的 `.v1`）。

**卸载前请先在设置页点「全部恢复」**，否则被隐藏时归档的会话会留在归档里，
需要到「归档」页手动恢复。宿主节点是纯 insert，删掉它不需要恢复任何被禁用的服务。

## 6. 核对证据（真机源码）

- `@deepseek-ai/dsh-client-ui-workspace/lib/client.js:389-406` —— `groupByWorkspace()`：
  只统计可见工作区的 `sessionIds`，其余在 `sessionVisible()` 通过的全部塞进
  `buildGroup("", …, UNGROUPED_LABEL, stray, …)`。这就是「未分组」溢出的根因。
- `@deepseek-ai/dsh-client-ui-workspace/lib/client.js:2569` —— `"group.ungrouped": "未分组"`。
- `@deepseek-ai/dsh-workspace/lib/index.js:446` —— `archiveSession()`：已归档则直接返回，
  否则追加，**不存在反向操作**。
- `@deepseek-ai/dsh-api-workspace-controller/lib/client.js:114-118` ——
  客户端 `archiveSession()` → `remote.archiveSession({sessionId})` → 成功后
  `installArchived(result.value.archivedSessionIds)`。
- `@deepseek-ai/dsh-api-gateway/lib/client.js:1564-1591` + `:1794` ——
  `createNamespace()` 以 `remote.<namespace>` 为名 `ownerCtx.plugin({…})`；
  `remoteServiceKey()` 返回 `` `remote.${namespace}` ``。这解释了为什么
  `inject = ["remote", "remote.workspace"]`（同仓库 `dsh-api-workspace-controller`
  的 client 第 336 行）是合法的 cordis 依赖声明。
- `@michengai/dsh-archive-manager/lib/client.js:540-660` —— 7 个 descriptor 全部
  `service/namespace: "workspaceRegistry"`；`:3926-3930` —— `apply()` 是 `async`
  且在其中 `await remote.$mount(ARCHIVE_MANAGER_REMOTE)`。
- `@deepseek-ai/cordis/lib/index.js:1599-1605` —— `inject(inject, callback)`
  就是 `this.plugin({inject, apply: callback})`；`:762-771` —— `get(name)` 是
  "without the inject requirement" 的读取器（这也是 `apiNow()` 能安全快速重解析的原因）。
- `@michengai/dsh-archive-manager/lib/workspace.js` —— `archiveSessions` / `archiveWorkspaceSessions`
  / `unarchiveSession` / `unarchiveSessions`；`archivedSessionIdsForTarget()`（L674-696）
  的每个分支都与宿主归档集求交，所以没归档过的 id 永远不会被误碰。
- `@deepseek-ai/dsh-client-ui-slots/lib/index.js:72-99` —— `single`/`keyed`/`list`/`chain`
  的注册约束；`list` 槽要求 `id`，且同 `id`+同 `priority` 才冲突。
- `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js:391-392` ——
  `"sidebar.workspaces": { kind: "single" }`。
- `@deepseek-ai/dsh-client-ui-settings-general` —— 声明 `settings.section` 为
  `{ kind: "list", scope: "root" }`；导航行只读 `id` / `order` / `label`。
- `@deepseek-ai/dsh-api-workspace-controller/lib/client.js:183-194` ——
  `getSnapshot()` 返回缓存的 `snapshotCache`；`buildSnapshot()` 重建新对象。
- `WorkspaceView` 字段：`workspaceId` / `path` / `title` / `sessionIds`。
