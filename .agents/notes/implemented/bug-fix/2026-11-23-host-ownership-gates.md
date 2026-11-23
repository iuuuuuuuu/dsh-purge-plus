# Agent Note: 密封核心的宿主归属门——只有 tauri 托管时才读 tauri 核心

Status: implemented

## Problem

同一台机器同时装着 dsh-tauri 与官方 Electron 客户端。插件在官方客户端里运行时，
`sealedTauriCore()` / `sealedAsarFallback()` 只检查「tauri 依赖目录存在且 `core_asar=true`」，
于是把 **tauri 的核心**当成当前宿主：状态面板显示 `applied=48`（那是 tauri 的 0.2.2 asar），
`ai_base` 指向 `dsh-tauri\dependencies\dsh\...asar`，点「应用」还会被 `宿主是密封 asar 核心，无法打补丁` 直接拦死。

## Decision

1. `sealedTauriCore()` 与 `sealedAsarFallback()` 都以 `tauri.isTauriManaged()` 为前提；
   不是 tauri 托管就返回空，让调用方走官方路径。
2. 新增 `sealedHostArchive()` 统一回答「当前宿主在读哪个归档」：tauri 托管取 tauri 核心，否则取 `resources/app.asar`。
3. 归档内 `@deepseek-ai` 根按两种布局探测：tauri `<asar>/node_modules/@deepseek-ai`、
   官方 `<asar>/dsh/node_modules/@deepseek-ai`（`sealedAiBaseUnder()`）。
4. 宿主版本读取（`hostDshVersion`）复用同一布局探测，官方客户端因此能报出真实版本 `0.2.1-rc.5`。

## Alternatives considered

- **只按 `process.execPath` 判断宿主** — 简单，但插件也会在 CLI/侧进程里跑（无 execPath 信息），判定会漏；
  `isTauriManaged()` 同时看 execPath 与 `DSH_INSTALL_DIR`，覆盖更全。
- **靠 `DSH_INSTALL_DIR` 环境变量判断** — 实测被父进程污染：在 tauri 宿主里 spawn 的官方客户端会继承该变量，
  于是官方进程误判成 tauri；因此它只能作为辅助信号，不能单独定案。

## Consequences

- **收益**：两个客户端各自看到自己的真实状态；官方客户端不再被 tauri 的密封核心拦死。
- **代价与已知上限**：宿主判定依赖命名约定（`dependencies/dsh/`、`core_asar`），
  上游改布局就要同步改探测；旧版官方客户端若缺 `dsh/` 中间层则两侧都要探测。
- **重访信号**：面板 `ai_base` 又指向非当前宿主的路径，或官方客户端报「密封 asar 无法打补丁」。

## Verification

- 官方客户端 `/dsh-purge/status`：`ai_base=...\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai`、
  `host_dsh=0.2.1-rc.5`；tauri 客户端同一字段指向 `dsh-tauri\dependencies\dsh`。
