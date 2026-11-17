import os from "node:os";
import path from "node:path";
import { extractAsar, isAsarArchive, readAsarFile } from "./asar.js";
import { diskFs } from "./extract-asar.js";

/**
 * 这里必须读真实磁盘，不能用 Electron 的 node:fs。
 * 宿主进程里 Electron 把 `*.asar` 映射成目录，`statSync(x.asar).isFile()` 恒为 false，
 * 于是 `<depsRoot>/deepseek-harness-pkg-<平台>.asar` 在宿主里"不存在"：pickAsar 空、
 * tauriAiBase 报 missing、密封保护也不触发，补丁就静默打到别的树上去了。
 * 非 Electron 环境 diskFs() 自动退回 node:fs。
 */
const fs = diskFs();

/**
 * 社区桌面端 dsh-tauri（/Applications/DSH Tauri.app）的宿主布局。
 *
 *   <support>/dependencies.json           -> { dsh: <depsRoot>, node, pnpm }
 *   <support>/.store.dat                  -> { setting: { core_asar, dsh_pkg_tag, ... } }
 *   <depsRoot>/<pkg>.asar                 -> ASAR 核心（密封，只读）
 *   <depsRoot>/node_modules/@deepseek-ai  -> 目录核心（可打补丁）
 *
 * 两种核心共用同一个 depsRoot，core_asar 决定宿主从哪一份加载。
 * 本模块只做「识别 + 解包 + 切换核心格式」，补丁仍然由 core.js 的补丁表打。
 */

export const TAURI_DIR_NAME = "dsh-tauri";
export const TAURI_PKG_PREFIX = "deepseek-harness-pkg-";
export const DIR_CORE_AI_BASE = ["node_modules", "@deepseek-ai"];

const isDir = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};
const isFile = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};
const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
};

/** 从正在运行的宿主 install dir 反推 dsh-tauri 支持目录。 */
export function supportDirFromInstallDir(installDir) {
  const p = String(installDir || "").trim();
  if (!p) return "";
  const marker = `/dependencies/dsh/`;
  const s = p.replace(/\\/g, "/");
  const i = s.toLowerCase().indexOf(marker);
  if (i < 0) return "";
  return path.normalize(s.slice(0, i));
}

/** 候选支持目录：运行中宿主优先，然后平台默认位置。 */
export function tauriSupportDirs(env = process.env) {
  const out = [];
  const add = (p) => {
    if (!p) return;
    out.push(path.normalize(String(p)));
  };
  add(supportDirFromInstallDir(env.DSH_INSTALL_DIR));
  const node = String(env.DSH_NODE_EXECUTABLE || "").trim();
  if (node && /DSH Tauri|dsh-tauri/i.test(node)) {
    // /Applications/DSH Tauri.app/Contents/Resources/... 与支持目录无关，靠默认位置兜底
  }
  const appData = env.APPDATA || (env.HOME ? path.join(env.HOME, "AppData", "Roaming") : "");
  if (process.platform === "darwin") {
    add(path.join(os.homedir(), "Library", "Application Support", TAURI_DIR_NAME));
  } else if (process.platform === "win32") {
    add(path.join(appData, TAURI_DIR_NAME));
  } else {
    add(path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), TAURI_DIR_NAME));
  }
  const seen = new Set();
  return out.filter((p) => {
    const k = p.toLowerCase();
    if (!isDir(p) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function pickAsar(depsRoot) {
  if (!isDir(depsRoot)) return "";
  let names = [];
  try { names = fs.readdirSync(depsRoot); } catch { return ""; }
  const hits = names
    .filter((n) => n.startsWith(TAURI_PKG_PREFIX) && n.toLowerCase().endsWith(".asar"))
    .map((n) => path.join(depsRoot, n))
    .filter(isFile);
  if (!hits.length) return "";
  // 多个归档时挑最新的（官方升级会留下旧的）
  hits.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  });
  return hits[0];
}

function dirAiBase(depsRoot) {
  const base = path.join(depsRoot, ...DIR_CORE_AI_BASE);
  return isDir(path.join(base, "dsh-agent-instructions", "lib")) ? base : "";
}

function asarAiBase(depsRoot, asar) {
  if (!asar) return "";
  return path.join(asar, "node_modules", "@deepseek-ai");
}

/** 识别 dsh-tauri 宿主；不在这里时返回 null。 */
export function tauriHost(env = process.env) {
  const dirs = tauriSupportDirs(env);
  if (!dirs.length) return null;
  const support = dirs[0];
  const depsJson = readJson(path.join(support, "dependencies.json")) || {};
  const depsRoot = path.normalize(
    String(depsJson.dsh || "").trim() || path.join(support, "dependencies", "dsh"),
  );
  const store = readJson(path.join(support, ".store.dat")) || {};
  const setting = store.setting || {};
  // 数据目录（$DSH_HOME）与依赖目录都可能被用户迁到别的盘：env 优先，其次 store。
  const dataDir = String(env.DSH_HOME || setting.data_dir || "").trim();
  const dependenciesRootSetting = String(setting.dependencies_root || "").trim();
  // 老版本没有该字段时按 asar 处理（官方默认）。
  const coreAsar = setting.core_asar !== false;
  const asar = pickAsar(depsRoot);
  const dirNodes = isDir(path.join(depsRoot, "node_modules", "@deepseek-ai"));
  let version = "";
  if (!coreAsar) {
    // 目录核心根 package.json 的 version 是打包壳版本，宿主的真实版本在 @deepseek-ai/dsh
    const real = readJson(path.join(depsRoot, "node_modules", "@deepseek-ai", "dsh", "package.json"));
    const shell = readJson(path.join(depsRoot, "package.json"));
    version = String((real && real.version) || (shell && shell.version) || "");
  }
  if (!version && asar) {
    try {
      const raw = readAsarFile(asar, "package.json", { maxBytes: 64 * 1024 });
      if (raw) version = String(JSON.parse(raw).version || "");
    } catch { /* ignore */ }
  }
  return {
    support,
    depsRoot,
    storePath: path.join(support, ".store.dat"),
    coreAsar,
    asar,
    dirNodes,
    dirAiBase: dirNodes ? dirAiBase(depsRoot) : "",
    asarAiBase: asarAiBase(depsRoot, asar),
    version,
    tag: String(setting.dsh_pkg_tag || ""),
    commit: String(setting.dsh_pkg_commit || ""),
    dataDir,
    dependenciesRootSetting,
    activeProfile: String(setting.active_profile || ""),
  };
}

/**
 * 当前宿主该打的 @deepseek-ai 根。
 * - 目录核心：直接返回可写目录
 * - asar 核心：返回 { sealed: true, asar }，调用方不得退回到别的树
 */
export function tauriAiBase(env = process.env) {
  const host = tauriHost(env);
  if (!host) return null;
  if (host.coreAsar) {
    if (host.asar) return { base: null, sealed: true, asar: host.asar, host };
    // core_asar 为真但没有归档：退回目录核心，避免完全不可用
    if (host.dirAiBase) return { base: host.dirAiBase, sealed: false, host };
    return { base: null, sealed: false, host, missing: true };
  }
  if (host.dirAiBase) return { base: host.dirAiBase, sealed: false, host };
  if (host.asar) return { base: null, sealed: true, asar: host.asar, host, notUnpacked: true };
  return { base: null, sealed: false, host, missing: true };
}

function atomicWrite(file, text) {
  const tmp = `${file}.dshpurge.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/** 改 .store.dat 里的 core_asar；返回改前/改后。 */
export function setCoreAsar(enabled, env = process.env) {
  const host = tauriHost(env);
  if (!host) return { ok: false, error: "not a dsh-tauri host" };
  const storePath = host.storePath;
  const raw = readJson(storePath);
  if (!raw) return { ok: false, error: `cannot read ${storePath}` };
  const before = raw.setting?.core_asar !== false;
  const want = enabled !== false;
  if (!raw.setting) raw.setting = {};
  raw.setting.core_asar = want;
  const backup = `${storePath}.dshpurge.bak`;
  if (!isFile(backup)) {
    try { fs.copyFileSync(storePath, backup); } catch { /* ignore */ }
  }
  atomicWrite(storePath, `${JSON.stringify(raw, null, 2)}\n`);
  return { ok: true, before, after: want, storePath, backup };
}

function stampPath(dshHome) {
  return path.join(dshHome, "dsh-purge", "tauri-core.json");
}

export function readTauriCoreStamp(dshHome) {
  return readJson(stampPath(dshHome));
}

function writeTauriCoreStamp(dshHome, data) {
  const fp = stampPath(dshHome);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  atomicWrite(fp, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * 把 asar 核心解包成目录核心（depsRoot/node_modules/...）。
 * 幂等：归档大小/时间没变且目录核心可用时跳过。
 */
export function unpackTauriCore(options = {}) {
  const host = options.host || tauriHost(options.env || process.env);
  if (!host) return { ok: false, error: "not a dsh-tauri host" };
  if (!host.asar) {
    if (host.dirAiBase) return { ok: true, skipped: true, reason: "directory core already present", base: host.dirAiBase };
    return { ok: false, error: `no asar core under ${host.depsRoot}` };
  }
  const dshHome = options.dshHome;
  let stat = null;
  try { stat = fs.statSync(host.asar); } catch { /* ignore */ }
  const stamp = dshHome ? readTauriCoreStamp(dshHome) : null;
  const same = Boolean(
    stamp
    && stat
    && stamp.asar === host.asar
    && Number(stamp.size) === stat.size
    && Number(stamp.mtimeMs) === stat.mtimeMs
    && host.dirAiBase,
  );
  if (same && options.force !== true) {
    return { ok: true, skipped: true, reason: "already unpacked", base: host.dirAiBase };
  }
  const result = extractAsar(host.asar, host.depsRoot, {
    onProgress: options.onProgress,
  });
  const base = dirAiBase(host.depsRoot);
  if (dshHome && stat) {
    writeTauriCoreStamp(dshHome, {
      asar: host.asar,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      files: result.files,
      bytes: result.bytes,
      at: new Date().toISOString(),
    });
  }
  const ok = Boolean(base) && result.errors.length === 0;
  return {
    ok,
    base,
    depsRoot: host.depsRoot,
    asar: host.asar,
    ...result,
    error: ok ? "" : (result.errors[0] || `extracted but no @deepseek-ai under ${host.depsRoot}`),
  };
}

/** 当前进程是不是由社区桌面端（dsh-tauri）托管的宿主。官方桌面 / 官方 dsh web 都返回 false。 */
export function isTauriManaged(env = process.env) {
  // Windows 上是反斜杠，统一成正斜杠再比
  const install = String(env.DSH_INSTALL_DIR || "").replace(/\\/g, "/");
  if (install.toLowerCase().includes("/dependencies/dsh/")) return true;
  if (/DSH\s*Tauri|dsh-tauri/i.test(String(env.DSH_NODE_EXECUTABLE || ""))) return true;
  return /DSH\s*Tauri|dsh-tauri/i.test(String(process.execPath || ""));
}

export function describeTauriHost(host) {
  if (!host) return "not a dsh-tauri host";
  const kind = host.coreAsar ? "asar" : "directory";
  return `dsh-tauri @ ${host.support} | core=${kind} | version=${host.version || "?"} | deps=${host.depsRoot}`;
}
