/**
 * 用户级 NODE_OPTIONS 预加载（Route 3 的"第一顺位"通道）
 *
 * 为什么需要：桌面端每次启动都会重写 --require 那份 asar-native.cjs，宿主的预加载位
 * 永远被洗掉；插件在进程内装钩子又太晚（核心服务已经 import 完，实测只接到 7/43）。
 * 用户级 NODE_OPTIONS 是唯一能排在宿主第一顺位的位置 —— 由 Node 在跑任何用户代码前加载。
 *
 * 安全约束：
 * - 只追加/移除我们自己那一段，原来的 NODE_OPTIONS 原样保留（原文记在 node-options.json）。
 * - 钩子放在 $DSH_HOME/dsh-purge/preload.cjs（插件自己的数据目录），不依赖 profile 里的包，
 *   重装插件也不会失效。
 * - 同目录生成 restore-node-options.cmd：万一钩子文件被删导致 node 起不来，双击即可恢复。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ENV_KEY = "NODE_OPTIONS";
const RECORD_NAME = "node-options.json";
const PRELOAD_NAME = "preload.cjs";
const RESTORE_NAME = "restore-node-options.cmd";

function psQuote(value) {
  return String(value || "").replace(/'/g, "''");
}

export function readUserNodeOptions() {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${ENV_KEY}','User')`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20000,
    });
    return String(out || "").trim();
  } catch {
    return "";
  }
}

function writeUserNodeOptions(value) {
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::SetEnvironmentVariable('${ENV_KEY}', $env:DSHPURGE_NOVAL, 'User')`], {
    env: { ...process.env, DSHPURGE_NOVAL: value || "" },
    stdio: "ignore",
    timeout: 20000,
  });
}

export function envPreloadPath(dshHome) {
  return path.join(dshHome, "dsh-purge", PRELOAD_NAME);
}
function recordPath(dshHome) {
  return path.join(dshHome, "dsh-purge", RECORD_NAME);
}

function stripOurToken(value) {
  return String(value || "")
    .replace(/--require\s+"?[^"]*preload\.cjs"?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function envPreloadState(dshHome) {
  const fp = envPreloadPath(dshHome);
  const current = readUserNodeOptions();
  const want = `--require "${fp}"`;
  return {
    path: fp,
    file: fs.existsSync(fp),
    current,
    active: current.includes(fp),
    want,
    backup: recordPath(dshHome),
  };
}

/** 装：拷钩子 + 写 conf + 追加 NODE_OPTIONS（原文留档，可原样还原）。 */
export function installEnvPreload({ dshHome, hookSource }) {
  const dir = path.join(dshHome, "dsh-purge");
  const fp = envPreloadPath(dshHome);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(hookSource, fp);
    // 钩子读同目录的 conf；这里指向 DSH_HOME 里的 manifest 与日志
    fs.writeFileSync(path.join(dir, "runtime-hook.conf.json"), `${JSON.stringify({
      enabled: true,
      manifest: path.join(dir, "runtime-inject.json"),
      log: path.join(dir, "runtime-inject.log"),
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(dir, RESTORE_NAME), [
      "@echo off",
      "rem [dsh-purge] 若 NODE_OPTIONS 指向的预加载文件丢失导致 node 起不来，双击本文件恢复。",
      `powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('NODE_OPTIONS','', 'User')"`,
      "echo 已清空用户级 NODE_OPTIONS。",
      "pause",
      "",
    ].join("\r\n"), "utf8");
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
  const before = readUserNodeOptions();
  try {
    fs.writeFileSync(recordPath(dshHome), `${JSON.stringify({ original: before, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  } catch { /* 记录失败也继续，下面还有还原脚本 */ }
  if (before.includes(fp)) return { ok: true, already: true, before, after: before };
  const after = `${before ? before + " " : ""}--require "${fp}"`.trim();
  try {
    writeUserNodeOptions(after);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), before, after };
  }
  return { ok: true, before, after };
}

/** 摘：把 NODE_OPTIONS 还原成装之前的样子；可选删掉预加载副本。 */
export function removeEnvPreload(dshHome, { deleteFile = false } = {}) {
  const current = readUserNodeOptions();
  let original = "";
  try { original = String(JSON.parse(fs.readFileSync(recordPath(dshHome), "utf8")).original || ""); } catch { /* 没记录就整段剥掉 */ }
  const target = original || stripOurToken(current);
  try {
    if (current !== target) writeUserNodeOptions(target);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), current, target };
  }
  if (deleteFile) {
    try { fs.rmSync(envPreloadPath(dshHome), { force: true }); } catch { /* ignore */ }
  }
  return { ok: true, before: current, after: target };
}
