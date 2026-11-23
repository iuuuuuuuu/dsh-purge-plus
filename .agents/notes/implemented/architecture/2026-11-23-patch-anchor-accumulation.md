# Agent Note: 补丁锚点按宿主版本累加，绝不替换旧锚点

Status: implemented

## Problem

宿主 dsh 每次重构，补丁表里靠字面量锚定的条目就整段失配，`applyPatches` 把它们记成 `skipped`，
而 `skipped` 在面板上是灰色无害的样子。实测两次：

- `0.2.2-rc.5` 把 escalation 改用 `SandboxEscalationError(msg, code)` 并加了 `approver`/`agent` 守卫，
  ask 逻辑从 `dsh-tools/lib/index.js` 搬到 `lib/pipeline.js`，`editIntent`/`deleteIntent` 改走 `requirePresent()`；
  12 条补丁静默跳过，其中 5 条是破甲关键项（escalation 授予、ask 失败放行、fs 先读后写）。
- `0.2.3-alpha.2` 删掉 `inHistory` 字段与 `renderPrompt(assembly)` 路径，又有 5 条失配。

后果不是报错，而是「看起来已应用、实际没放开」：模型一撞 sandbox 升级或审批就被拒，破甲提示词写了也没用。
更糟的是每轮修新版若用新锚点**替换**旧锚点，老版本客户端会失去覆盖，等于用新版换掉旧版的正确性。

## Decision

补丁表对同一语义保留**多条锚点**，按宿主版本累加，不删除历史形态：

1. 旧字面量锚点一律保留。它们在新宿主上失配即不生效，不产生副作用。
2. 新形态优先写成**正则锚点**，只认结构不认死文本，并用 `$1` 继承原缩进（`applyReplacementsToText` 的 replace 支持 `$1..$9`）。
   例：`/^(\t+)const claimed = this\.inbox\.claim\(target, position\.turn\);$/m`。
3. 上游把代码**搬到别的包**时，把新路径并入同一逻辑组件映射，而不是新增补丁号：
   `dsh-tools` 追加 `lib/pipeline.js`；新增 `tool-executor-ptc`；`deliverables-prompt` 并入 `dsh-deliverable-file-references`。
4. 纯删除型补丁（身份剥离、撤回自己写过的行）用 `appliedWhenForbid`：要删的东西都不在了就算达成，
   不再依赖单一 marker，避免「产物形态不同 → 误报未应用」。
5. 只有上游**彻底删除该实现**（如 `renderPrompt(assembly)`）才允许 `obsoleteSince: <version>`，
   判 `na` 而不是永远 `skipped`；旧锚点仍然保留，老宿主照旧生效。

判定顺序由 `patchAppliesHere(patch, surface, hostVersion)` 承担，宿主版本来自 `hostVersionFrom(aiBase)`
（读 `<aiBase>/dsh/package.json`），`versionAtLeast` 只比 `major.minor.patch`，忽略 `-rc/-alpha` 后缀。

## 跳过信号必须能报警：破甲关键项标红

`skipped` 之所以长期误导，是因为面板把它当无害终态。现在把「执行期放行」这一类补丁标为破甲关键项
（`CRITICAL_PATCH_IDS` = #6 #8 #9 #10 #13 #14 #15 #16 #17 #35 #51 #60 #62），并规定：

- `criticalSkippedOf(patchStatus)` 只把 `skipped` / `unmatched` 计入告警；
  `missing_file`（组件未装）与 `na`（上游已删实现）不计，`pending`（还没点应用）也不计——那是正常待办。
- `gatherState` 输出 `critical_skipped` / `critical_alert`，`/dsh-purge/status` 与「应用」响应都带同一字段。
- 面板在计数下方渲染红色 `.dshp-critical` 告警条（中英双语），不是灰色 pill。
- `bin/dsh-purge.js --status` 与 `--verify` 打印 `!! 破甲关键项被跳过` 并把 `--verify` 判为失败（exit 非 0）。

## Alternatives considered

- **按宿主版本维护多张补丁表** — 语义最干净，但状态面板、回滚、备份、报告都要按表分裂，
  而且跨版本同时在线（同一台机器两个客户端）时无法给出统一状态；否决。
- **每轮修新版直接替换旧锚点** — 维护成本最低，但会静默丢掉老版本覆盖，
  正是这次踩到的「修一个坏一个」；否决。
- **放弃文件补丁，全部用运行时注入** — 注入层不受锚点影响，但只能改提示词与装配结果，
  sandbox/审批这些执行期分支必须在源码里放开；否决。

## Consequences

- **收益**：一次修复同时保住新旧宿主；`skipped` 重新变成有意义的异常信号（当前 0.2.3 上为 0）。
- **代价与已知上限**：锚点条目会持续增长（#13 已 4 条、#62 已 5 条），需要定期看清哪些是真失效；
  正则锚点跨版本命中时，语义是否仍然成立仍需人工确认。
- **重访信号**：宿主再次重构导致 `skipped > 0`；或某补丁锚点数超过 6 条仍无法覆盖新版本。

## Verification

- `node bin/dsh-purge.js --status` → 0.2.3-alpha.2 上 `applied 65 / skipped 0 / na 14`。
- `git diff <旧 tag>..HEAD -- lib/core.js | grep '^-\s*pattern:'` 为空 → 没有删过锚点。
- `node test/gate.mjs`（71 项）、`node test/yaml-patches.mjs`（52 项）全绿。
- 每个补丁目标 JS 过 `node --check`：`verifyHostTreeSyntax()` 报 `{ok:true, errors:[]}`。
