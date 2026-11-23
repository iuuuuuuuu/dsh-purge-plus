# Agent Note: 换走 asar 之前必须验成品树（不可逆操作的前置闸门）

Status: implemented

## Problem

官方 Electron 客户端只支持「解包成 `resources/app` 目录」这条路；一旦把 `app.asar` 挪走就是不可逆动作，
宿主下次启动直接读目录版本。补丁表按另一版本写的时候，硬切换来的是半残宿主：
0.2.1 首切就是 `presets/cordis.patch.yml` 被打坏 → bundle 全跳过 → 前端卡 loading。
而 `apply` 的返回报告此刻是绿的，光看它无法发现问题。

## Decision

1. `/restart` 在调用「换包」之前跑 `verifyHostTreeSyntax(ai_base)`：
   每个补丁目标 JS 过 `node --check`，YAML 过 js-yaml（放行宿主自定义 `!!js` tag）。
2. 任一文件不通过 → 不换包，返回具体失败文件，宿主继续跑原 asar。
3. 宿主版本与补丁表不同线时，同样必须过这道校验；通过才允许切换，并在响应里带 `version_mismatch: true`。
4. 预演函数 `verifyPatchedTree()` 保留，但不再作为换包判据——它对「已打补丁的树」重算结果为 0 改动，等于没验。

## Alternatives considered

- **只信 `applyPatches` 的返回报告** — 最省事，但报告只说明「替换写进去了」，不说明产物还能被解析；
  这次的 loading 卡死正是报告全绿而文件已坏。
- **用 `verifyPatchedTree` 预演代替验成品** — 名字像，实际验的是「再打一次会改什么」，
  补丁已落地时恒为 0；否决。
- **换包后启动失败再自动回滚** — 回滚窗口里用户已经看到启动失败，且崩溃原因可能不在日志里；
  前置校验成本更低。

## Consequences

- **收益**：不可逆动作有了可复现的前置条件；0.2.1 实测 40 个 JS + 10 个 YAML 零错误后才切，切完启动无 bundle 跳过。
- **代价与已知上限**：校验只覆盖语法与 YAML 结构，语义正确性仍需人工确认；
  全量 `node --check` 在大树上有秒级开销。
- **重访信号**：宿主换核心格式（目录 ↔ asar）或新增文件类型（如 `.mjs` 之外的产物）。

## Verification

- `verifyHostTreeSyntax('<aiBase>')` 在 0.2.3 目录核心上报 `{ok:true, js:45, errors:[]}`。
- 官方 0.2.1 切换前：`{ok:true, js:40, yaml:10}`；切换后宿主启动正常、`preset-declare.json` 无 broken。
