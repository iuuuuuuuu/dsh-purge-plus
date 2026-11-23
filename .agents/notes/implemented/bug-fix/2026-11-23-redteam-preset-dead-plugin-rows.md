# Agent Note: 红队预设自愈时禁用失效插件行，而不是删行或整份覆盖

Status: implemented

## Problem

红队模式在模式下拉里显示「加载失败」，报错 `tool-subagent-list-agents (@deepseek-ai/dsh-tool-subagent-control/list-agents); never started`。
两层原因叠加：

1. 0.2.2 起 `list_agents` 并入主包，不再有 `/list-agents` 子路径，但运行时预设
   `$DSH_HOME/.agent-presets/redteam/agent.cordis.yml` 仍带着这一行（本机停在旧版本）。
2. `repairDelegation()` 的「强制启用」清单里包含这个 id，每次自愈都把 `disabled: true` 刷回 `false`，
   于是无论怎么更新插件包，预设都会在下一次启动再次 broken。

## Decision

1. 新增 `DEAD_PLUGIN_ROWS`（`dsh-tool-subagent-control/list-agents`、`dsh-workflow-worker-thread`）与 `disableDeadRows()`：
   自愈时把命中行的 `disabled` 强制为 `true`，需要时补一行注释说明原因。
2. 不删行：老宿主上这些包可能仍然存在，删掉会丢功能。
3. 把 `tool-subagent-list-agents` 从「强制启用」清单移除，杜绝自愈把死行刷活。
4. 整份覆盖只保留 `REDTEAM_PRESET_REFRESH=1` 显式路径，避免抹掉用户对预设的改动。

## Alternatives considered

- **整份覆盖运行时预设** — 一行代码解决，但用户对预设的自定义（模型、工具开关）会被抹掉；否决。
- **直接删除死行** — 干净，但在仍带旧包的宿主上会无谓丢功能；禁用更保守。

## Consequences

- **收益**：预设能重新注册（`preset-declare.json` 报 `phase=registered`、`broken=null`），
  且下一次宿主升级带来的新死行可以按同一张表追加。
- **代价与已知上限**：死行表需要跟着上游包变动维护；面板里这些行显示为 disabled 而不是消失。
- **重访信号**：预设再次 `never started`，且错误里出现不在 `DEAD_PLUGIN_ROWS` 的包名。

## Verification

- 全量解析运行时预设：无法解析的行只剩 2 条且均为 `disabled: true`，启用态致命项 0。
- `D:\DSHHome\redteam\preset-declare.json`：`phase=registered`、`broken=null`、`plugins=19`。
