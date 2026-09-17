# dsh-workspace-hide

在 DSH 侧边栏**隐藏指定工作区**，连同它名下的会话一起收进「归档」，并在
「设置 → 隐藏的工作区」里随时恢复。

纯本地、可逆、不删数据：工作区文件夹和会话记录始终留在磁盘上。

---

## 介绍

### 它解决什么

DSH 内置的「删除工作区」其实也不删数据，但它的心智负担是"移出列表"，恢复要重新添加文件夹。
更麻烦的是：**任何只把工作区从列表里摘掉的做法，都会让它的会话掉进侧边栏的「未分组」**，
变成一堆无主的条目（根因见 [`DESIGN.md` §1.1](./DESIGN.md#11-两层配合)）。

本插件同时处理这两件事：

- 侧边栏不再出现该工作区；
- 它名下的会话**不会**变成一堆无主的「未分组」条目，而是被归档收起来；
- 撤销隐藏时，只有"因为这次隐藏才被归档"的会话会回来。

**隐藏之前就已经归档的会话，永远不会被这次隐藏/恢复碰到。**

### 使用

1. 安装后重启 DSH Desktop；
2. 打开 **设置**，左侧栏出现「隐藏的工作区」（排在「归档会话」之后）；
3. 每个工作区右侧一个开关：关掉 = 从侧边栏隐藏并归档其会话，打开 = 恢复显示并撤销这批归档；
4. 顶部「全部恢复」一键清空清单并批量恢复。

被隐藏的工作区**不会**从设置页消失——设置页读的是未过滤列表，否则就没法撤销了。
隐藏行上会显示「已归档 N 个会话」，让你知道恢复时会回来多少。

> 卸载或清空清单之前，请先点一次「全部恢复」，否则被归档的会话会留在「归档」页里。

---

## 安装

### 从 npm 安装

```powershell
dsh plugin add dsh-workspace-hide@0.1.2
```

### 从 GitHub 安装

```powershell
dsh plugin add https://codeload.github.com/SUZUNAMI/dsh-workspace-hide/tar.gz/refs/tags/v0.1.2
```

`dsh plugin add` 本质就是在 profile 目录（`~/.dsh/profiles/web`）里跑一次 `pnpm add`，
并**同时**把包名写进 `dependencies` 与 `dsh.profile.bundles` 两处；`dsh plugin remove`
会把两处一起清掉。

各种目标形式的实测结果：

| 形式 | 命令 | 说明 |
|---|---|---|
| **npm** | `dsh plugin add dsh-workspace-hide@0.1.2` | 最短；只依赖 `registry.npmjs.org` |
| **tarball（推荐）** | `dsh plugin add https://codeload.github.com/SUZUNAMI/dsh-workspace-hide/tar.gz/refs/tags/v0.1.2` | 不经过 git，不需要 SSH 密钥，走 `codeload.github.com`；实测 1.6s |
| `git+https` | `dsh plugin add git+https://github.com/SUZUNAMI/dsh-workspace-hide.git#v0.1.2` | 走 https git；需要能连上 `github.com:443` |
| `github:` | `dsh plugin add github:SUZUNAMI/dsh-workspace-hide#v0.1.2` | ⚠️ **pnpm 会把它解析成 `git+ssh://`**（见下），需要本机已配好 GitHub SSH 密钥与 `known_hosts` |
| 跟随 `main` | `dsh plugin add https://codeload.github.com/SUZUNAMI/dsh-workspace-hide/tar.gz/refs/heads/main` | 上游随时会变，不建议 |
| 本地目录（改代码时） | `dsh plugin add file:C:/path/to/dsh-workspace-hide` | 直接软链/硬链到工作副本 |

> **关于 `github:` 形式**：pnpm 对它的解析目标是
> `git+ssh://git@github.com/<owner>/<repo>.git`，所以一台没配过 GitHub SSH 的机器
> 会直接 `Host key verification failed`。tarball 形式没有这个问题。

装完**重启 DSH Desktop**，再打开「设置」，左侧应出现「隐藏的工作区」。

第三方插件建议钉 tag 或 commit，不要跟随 `main`。

### 手动安装

在 `~/.dsh/profiles/web/package.json` 里加两处，然后在该目录执行 `pnpm install`：

```jsonc
{
  "dependencies": {
    "dsh-workspace-hide": "0.1.2"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-workspace-hide"]
    }
  }
}
```

### 关于依赖：本插件是零依赖的

**没有 npm 依赖，也没有构建步骤。** `lib/client.js` 是手写的
`window.__ModuleLoader__` 工厂，它 `require` 的 `react` 与
`@deepseek-ai/dsh-client-ui-primitives` 都由 DSH 运行时**注入**（后者还有 `try/catch`
兜底，取不到就退化成内置控件）。所以这两个包**不是** dependencies，也不该被写进
dependencies —— 那反而可能装进第二份 react 实例。

---

## 版本更新

### 0.1.2 — 首个公开发布版本

- 侧边栏隐藏工作区，其会话并入 `archivedSessionIds`，不再溢出到「未分组」。
- 检测到 `@michengai/dsh-archive-manager` 时启用宿主层：真归档、可撤销；
  未安装时退化为纯显示层，绝不真归档（内核没有反向操作，见 `DESIGN.md`）。
- 设置页「隐藏的工作区」：逐项开关、`canRestore` 提示、失效项「移除记录」、
  取消归档失败后的「重试恢复」、「全部恢复」。
- 清单持久化到 `localStorage` 的 `dsh-workspace-hide.hidden.v2`（含 v1 自动迁移）。
- 安装说明修正：`github:` 会被 pnpm 解析成 `git+ssh://`，改用 codeload tarball。

---

## 更多文档

原理、接缝、已知边界、离线验证方法与真机源码证据：[`DESIGN.md`](./DESIGN.md)。

## 许可

MIT
