# Agent Note: 身份剥离补丁保留 YAML 折叠块头，并改用「该删的都删了」判据

Status: implemented

## Problem

`#4` / `#43` / `#76` 的职责是删掉官方预设里的身份句（`You are a coding agent powered by ...`）。
旧实现遇到折叠块时把块头 `prefix: >-` 换成 `prefix: ""`，而块内后续正文行留在原缩进，
YAML 立刻非法；宿主随后跳过整个 bundle，界面卡在 loading。
线上表现是「应用成功后客户端起不来」，`prompt-inject` 之类完全无关的模块也被牵连。

## Decision

1. 折叠块只删**内容行**，块头保留：替换成 `# [dsh-purge] identity stripped` + `prefix: >-`。
   注释行与键同缩进，YAML 合法，且成为唯一可靠的「已处理」标记。
2. `markersAny` 同时接受旧形态 `prefix: ""` 与新注释，兼容历史产物。
3. 追加正则锚点，匹配任意缩进的折叠块（2~16 空格实测），兼容不同宿主版本的排版。
4. 判据加 `appliedWhenForbid`：两种身份句都不在即 `applied`，不再依赖单一 marker
   （早前被 repair 兜底改过的文件正是因此被误报成 `unmatched`）。
5. `repairFoldedYamlScalars()` 退化为安全网，正常路径不需要它兜底。

## Alternatives considered

- **继续靠 `repairFoldedYamlScalars` 兜底** — 管线里已经能自动修，改一行就绿；
  但补丁产物本身仍是非法的，任何绕过管线的路径（重打包、手工 apply）都会再炸一次；否决。
- **整块删除折叠块** — 能保证合法，但连带删掉工作区说明等正文，语义损失不可接受；否决。

## Consequences

- **收益**：YAML 在补丁落盘那一刻就合法，重打包与官方客户端目录核心两条路径都不再依赖兜底。
- **代价与已知上限**：文件里留下 `# [dsh-purge] identity stripped` 注释；
  若上游把身份句改成第三种措辞，正则不命中会退回 `skipped`。
- **重访信号**：`#43` 在任一宿主版本上回到 `skipped`/`unmatched`。

## Verification

- `node test/yaml-patches.mjs` → 52 项全过，含 7 种缩进矩阵与故障注入（换回旧写法必须被判红）。
- 官方 0.2.1 原始归档四份预设：`standard/ptc/cordis` 身份句全部删除、YAML 解析通过。
