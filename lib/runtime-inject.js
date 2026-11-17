import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { envPreloadState, installEnvPreload, removeEnvPreload } from "./runtime-env-preload.js";
import {
  ALL_PATCHES,
  applyReplacementsToText,
  atomicWriteSync,
  findAiBase,
  findDshHome,
  findShimDir,
  sealedHostArchive,
  targetFilesAllowSealed,
} from "./core.js";

/**
 * Runtime Inject（Route 3）
 *
 * 宿主是密封 asar、桌面端又切不了核心时，补丁没有可写目标。这里改成在**模块加载期**
 * 换源码：插件先把「每个目标文件的补丁后全文」算好写进 manifest，再由
 * lib/runtime-hook.cjs 通过宿主启动参数里的 --require 预加载，用 Node 的
 * module.registerHooks() 在加载时直接交付补丁后的源码。asar 一个字节不动，
 * 替换语义完全复用 applyReplacementsToText()（CRLF / YAML / marker 一并照旧）。
 */

const MANIFEST_NAME = "runtime-inject.json";
const CONF_NAME = "runtime-hook.conf.json";
const HOOK_NAME = "runtime-hook.cjs";
const PRELOAD_MARK = "// [dsh-purge] runtime-inject preload (safe to remove)";
const LOG_NAME = "runtime-inject.log";

const normKey = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
const sealedPathRe = /[\\/][^\\/]+\.asar[\\/]/i;

export function manifestPath(dshHome = findDshHome()) {
  return path.join(dshHome, "dsh-purge", MANIFEST_NAME);
}
export function logPath(dshHome = findDshHome()) {
  return path.join(dshHome, "dsh-purge", LOG_NAME);
}
export function hookPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), HOOK_NAME);
}

function componentNames(patch) {
  const raw = patch.file != null ? patch.file : patch.files;
  if (raw == null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * 生成 manifest：每条补丁按 applyReplacementsToText() 跑到源码上，
 * 只要结果与原文不同就记下整份"补丁后源码"。
 */
export function buildRuntimeManifest({ aiBase, dshHome = findDshHome() } = {}) {
  const result = { ok: false, aiBase: aiBase || "", files: {}, patches: 0, bytes: 0, unresolved: [], unchanged: 0, error: "" };
  if (!aiBase) { result.error = "没有可用的插件根"; return result; }
  // 读原文：先把自己这一层注入暂停，否则读到的是补丁后源码（见 runtime-hook.cjs）。
  const pauseState = globalThis.__dshPurgePause || (globalThis.__dshPurgePause = { paused: false });
  const prevPaused = pauseState.paused;
  pauseState.paused = true;
  let map = {};
  try {
    map = targetFilesAllowSealed(aiBase, dshHome) || {};
  } catch (e) {
    pauseState.paused = prevPaused;
    result.error = String(e && e.message ? e.message : e);
    return result;
  }
  const seenPatch = new Set();
  for (const patch of ALL_PATCHES) {
    for (const name of componentNames(patch)) {
      // yml/json 这类预设/overlay 一律不注入：它们是启动关键路径，且 ESM 侧读不到
      // 我们的 fs 包装（实测 esm_marks=0）。提示词/身份层由运行时 assemble 改写覆盖。
      if (/preset|patch\.ya?ml|patch-ya?ml/i.test(String(name))) { result.unchanged += 1; continue; }
      // targetFiles() 某些组件给的是候选数组（同一文件的不同布局），逐个试。
      const raw = map[name];
      const cands = Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && x) : (raw ? [raw] : []);
      if (!cands.length) { result.unresolved.push({ id: patch.id, name }); continue; }
      let hit = false;
      for (const fp of cands) {
        if (/\.(ya?ml)$/i.test(fp)) { result.unchanged += 1; continue; }
        let src = "";
        try { src = fs.readFileSync(fp, "utf8"); } catch { continue; }
        let out = src;
        try {
          const r = applyReplacementsToText(out, patch, fp);
          if (r && typeof r.text === "string") out = r.text;
        } catch { /* 单条失败不影响其它补丁 */ }
        hit = true;
        if (out === src) continue;
        result.files[normKey(fp)] = out;
        if (!seenPatch.has(patch.id)) { seenPatch.add(patch.id); result.patches += 1; }
      }
      if (!hit) result.unresolved.push({ id: patch.id, name, error: "候选文件都读不到" });
      else if (!seenPatch.has(patch.id)) result.unchanged += 1;
    }
  }
  pauseState.paused = prevPaused;
  result.bytes = Object.values(result.files).reduce((a, s) => a + Buffer.byteLength(s, "utf8"), 0);
  result.ok = Object.keys(result.files).length > 0;
  if (!result.ok && !result.error) {
    result.error = result.unresolved.length
      ? `${result.unresolved.length} 个补丁解析不到可注入文件`
      : "所有补丁在原文件里都已生效，无需注入";
  }
  return result;
}

export function writeRuntimeManifest(dshHome, manifest) {
  const fp = manifestPath(dshHome);
  atomicWriteSync(fp, JSON.stringify({ v: 1, aiBase: manifest.aiBase, patches: manifest.patches, files: manifest.files }), "utf8");
  return fp;
}

function argvPreloads() {
  const out = [];
  try {
    for (const arg of process.argv) {
      if (typeof arg !== "string") continue;
      if (/\.cjs$/i.test(arg) && /[\\/]bin[\\/]/i.test(arg)) out.push(path.dirname(arg));
    }
  } catch { /* ignore */ }
  return out;
}

/** 宿主实际 --require 的那份 asar-native.cjs 所在目录优先，其次常规 shim 目录。 */
function shimPreloadTargets() {
  const dirs = [...argvPreloads()];
  try { const d = findShimDir(); if (d) dirs.push(d); } catch { /* ignore */ }
  const local = process.env.LOCALAPPDATA || "";
  if (local) dirs.push(path.join(local, "deepseek-harness", "bin"));
  const seen = new Set();
  return dirs.map((d) => path.normalize(d)).filter((d) => {
    const k = d.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return fs.existsSync(path.join(d, "asar-native.cjs"));
  });
}

/** 在 asar-native.cjs 末尾挂一行 require（幂等，留 .bak）。 */
export function installPreload() {
  const hook = hookPath();
  if (!fs.existsSync(hook)) return { ok: false, error: `缺少 ${HOOK_NAME}`, results: [] };
  const results = [];
  for (const dir of shimPreloadTargets()) {
    const target = path.join(dir, "asar-native.cjs");
    let text = "";
    try { text = fs.readFileSync(target, "utf8"); } catch (e) { results.push({ dir, error: String(e && e.message ? e.message : e) }); continue; }
    // 已经挂过但指向别处（例如从仓库目录装过、现在跑的是 profile 里的副本）要重新指。
    if (text.includes(PRELOAD_MARK)) {
      const head = text.slice(0, text.indexOf(PRELOAD_MARK)).replace(/\s+$/, "\n");
      const fresh = `\n${PRELOAD_MARK}\ntry { require(${JSON.stringify(hook)}) } catch (e) { /* 不许影响宿主启动 */ }\n`;
      if (text.includes(JSON.stringify(hook))) { results.push({ dir, state: "already" }); continue; }
      try {
        fs.writeFileSync(target, head + fresh, "utf8");
        results.push({ dir, state: "repointed" });
      } catch (e) {
        results.push({ dir, error: String(e && e.message ? e.message : e) });
      }
      continue;
    }
    const backup = `${target}.dshpurge.bak`;
    try { if (!fs.existsSync(backup)) fs.copyFileSync(target, backup); } catch { /* 备份失败也继续 */ }
    const line = `\n${PRELOAD_MARK}\ntry { require(${JSON.stringify(hook)}) } catch (e) { /* 不许影响宿主启动 */ }\n`;
    try {
      fs.writeFileSync(target, text + line, "utf8");
      results.push({ dir, state: "patched", backup });
    } catch (e) {
      results.push({ dir, error: String(e && e.message ? e.message : e) });
    }
  }
  return { ok: results.some((r) => r.state === "patched" || r.state === "already"), results };
}

/** 目录核心/未密封时摘掉注入，避免对已改过的文件二次改写。 */
export function uninstallPreload() {
  const results = [];
  for (const dir of shimPreloadTargets()) {
    const target = path.join(dir, "asar-native.cjs");
    let text = "";
    try { text = fs.readFileSync(target, "utf8"); } catch { continue; }
    const i = text.indexOf(PRELOAD_MARK);
    if (i < 0) { results.push({ dir, state: "clean" }); continue; }
    try {
      fs.writeFileSync(target, text.slice(0, i).replace(/\s+$/, "\n"), "utf8");
      results.push({ dir, state: "removed" });
    } catch (e) {
      results.push({ dir, error: String(e && e.message ? e.message : e) });
    }
  }
  return results;
}

export function writeHookConf(dshHome, { enabled }) {
  const conf = { enabled: enabled === true, manifest: manifestPath(dshHome), log: logPath(dshHome) };
  const fp = path.join(path.dirname(hookPath()), CONF_NAME);
  atomicWriteSync(fp, `${JSON.stringify(conf, null, 2)}\n`, "utf8");
  return { conf, path: fp };
}

function manifestHash(files) {
  const h = createHash("sha256");
  for (const key of Object.keys(files).sort()) {
    h.update(key);
    h.update("\u0000");
    h.update(String(files[key]));
    h.update("\u0000");
  }
  return h.digest("hex");
}

/**
 * 语法闸门：改写后的源码必须每份都能被 Node 解析。
 * 少这份检查的话，一条改坏的补丁就能让宿主下次直接起不来。
 * 同一份 manifest（hash 相同）只验一次。
 */
export function verifyManifestSyntax(files, { hash = "", dshHome = findDshHome() } = {}) {
  const stampPath = path.join(dshHome, "dsh-purge", "runtime-inject.verified.json");
  if (hash) {
    try {
      const prev = JSON.parse(fs.readFileSync(stampPath, "utf8"));
      if (prev && prev.hash === hash && prev.ok === true) return { ok: true, cached: true, checked: prev.checked || 0 };
    } catch { /* 没有历史记录就真验 */ }
  }
  const isJs = (key) => /\.(mjs|cjs|js|jsx|ts)$/i.test(String(key));
  const jsFiles = Object.entries(files).filter(([key]) => isJs(key));
  const skipped = Object.keys(files).length - jsFiles.length;
  let tmpRoot = "";
  try { tmpRoot = os.tmpdir(); } catch { tmpRoot = ""; }
  if (!tmpRoot || !path.isAbsolute(tmpRoot)) tmpRoot = path.join(dshHome, "dsh-purge", "tmp");
  const tmp = path.join(tmpRoot, `dshpurge-rt-${process.pid}-${Date.now()}`);
  const errors = [];
  let checked = 0;
  try {
    fs.mkdirSync(tmp, { recursive: true });
    for (const [key, src] of jsFiles) {
      const base = String(key).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-90);
      const fp = path.join(tmp, `${base}.mjs`);
      try {
        fs.writeFileSync(fp, String(src), "utf8");
        execFileSync(process.execPath, ["--check", fp], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: "pipe",
          timeout: 30000,
        });
        checked += 1;
      } catch (e) {
        const detail = String((e && (e.stderr || e.message)) || e).slice(0, 400);
        errors.push({ file: key, error: detail });
      }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const ok = errors.length === 0;
  if (hash) {
    try { atomicWriteSync(stampPath, `${JSON.stringify({ hash, ok, checked, skipped, at: new Date().toISOString(), errors })}\n`, "utf8"); } catch { /* ignore */ }
  }
  return { ok, cached: false, checked, skipped, errors };
}

/**
 * 一步到位：宿主是密封 asar → 建 manifest（过语法闸门）+ 挂预加载；否则摘掉。
 */
export function syncRuntimeInject({ aiBase, dshHome = findDshHome() } = {}) {
  if (!sealedPathRe.test(String(aiBase || ""))) {
    writeHookConf(dshHome, { enabled: false });
    const removed = uninstallPreload();
    const envRemoved = removeEnvPreload(dshHome);
    return { active: false, reason: "宿主不是密封 asar，文件级补丁已经足够", removed, envRemoved };
  }
  const manifest = buildRuntimeManifest({ aiBase, dshHome });
  if (!manifest.ok) {
    writeHookConf(dshHome, { enabled: false });
    uninstallPreload();
    return { active: false, reason: manifest.error || "manifest 构建失败", unresolved: manifest.unresolved.slice(0, 5) };
  }
  const hash = manifestHash(manifest.files);
  const gate = verifyManifestSyntax(manifest.files, { hash, dshHome });
  if (!gate.ok) {
    writeHookConf(dshHome, { enabled: false });
    uninstallPreload();
    return {
      active: false,
      reason: `语法闸门未通过，已拒绝启用运行时注入（${gate.errors.length} 个文件）`,
      gate,
      unresolved: manifest.unresolved.slice(0, 5),
    };
  }
  const written = writeRuntimeManifest(dshHome, manifest);
  const preload = installPreload();
  writeHookConf(dshHome, { enabled: true });
  /* 第一顺位通道（用户级 NODE_OPTIONS）默认**不开**：
   * 实测 deepseek-harness-desktop 派生宿主时会过滤掉 NODE_OPTIONS（新 launcher 也拿不到），
   * 装了只会留下"钩子文件被删则全机 node 起不来"的脚枪。
   * 换其他桌面端（会转发 NODE_OPTIONS 的）时可用 DSH_PURGE_ENV_PRELOAD=1 打开。 */
  const wantEnvPreload = String(process.env.DSH_PURGE_ENV_PRELOAD || "").trim() === "1";
  const env = wantEnvPreload
    ? installEnvPreload({ dshHome, hookSource: hookPath() })
    : { ok: true, skipped: "launcher 过滤 NODE_OPTIONS，默认不开（DSH_PURGE_ENV_PRELOAD=1 可开）" };
  return {
    active: true,
    env,
    manifest: written,
    files: Object.keys(manifest.files).length,
    patches: manifest.patches,
    bytes: manifest.bytes,
    unchanged: manifest.unchanged,
    unresolved: manifest.unresolved.slice(0, 5),
    gate: { ok: true, cached: gate.cached === true, checked: gate.checked || 0 },
    preload,
  };
}

/**
 * 目录核心（已打过补丁的实体树）上线前闸门：每份被改写的 JS 必须能被 node --check 解析，
 * 每个被改写的 YAML 必须能被 js-yaml 解析（放行宿主自定义 !!js）。
 * 任一不通过就返回 ok:false，调用方不得把 asar 换走 / 不得启用注入。
 */
export function verifyPatchedTree(aiBase, { dshHome = findDshHome(), patches = ALL_PATCHES } = {}) {
  const changed = new Map();
  const unresolved = [];
  for (const patch of patches) {
    const raw = patch.file != null ? patch.file : patch.files;
    const names = raw == null ? [] : (Array.isArray(raw) ? raw : [raw]);
    for (const name of names) {
      let map = {};
      try { map = targetFilesAllowSealed(aiBase, dshHome) || {}; } catch { /* ignore */ }
      const v = map[name];
      for (const fp of (Array.isArray(v) ? v : (v ? [v] : []))) {
        if (typeof fp !== "string" || !fp) continue;
        let src = "";
        try { src = fs.readFileSync(fp, "utf8"); } catch { continue; }
        let out = src;
        try {
          const r = applyReplacementsToText(out, patch, fp);
          if (r && typeof r.text === "string") out = r.text;
        } catch { /* ignore */ }
        if (out !== src) changed.set(fp, out);
      }
    }
  }
  const jsMap = {};
  const yamlMap = {};
  for (const [fp, text] of changed) {
    if (/\.(ya?ml)$/i.test(fp)) yamlMap[normKey(fp)] = text;
    else if (/\.(mjs|cjs|js|jsx|ts)$/i.test(fp)) jsMap[normKey(fp)] = text;
  }
  const syntax = Object.keys(jsMap).length
    ? verifyManifestSyntax(jsMap, { hash: "", dshHome })
    : { ok: true, checked: 0, errors: [] };
  const yamlErrors = [];
  let yamlChecked = 0;
  if (Object.keys(yamlMap).length) {
    const parser = loadYaml();
    if (parser) {
      for (const [fp, text] of Object.entries(yamlMap)) {
        yamlChecked += 1;
        try { parser.load(text, { schema: parser.schema }); } catch (e) {
          yamlErrors.push({ file: fp, error: String(e && e.message ? e.message : e).slice(0, 200) });
        }
      }
    }
  }
  const errors = [...(syntax.errors || []), ...yamlErrors];
  return {
    ok: errors.length === 0,
    changedFiles: changed.size,
    js: { checked: syntax.checked || 0, errors: (syntax.errors || []).length },
    yaml: { checked: yamlChecked, errors: yamlErrors.length },
    errors: errors.slice(0, 5),
    unresolved,
  };
}

/**
 * 对**已打过补丁的实体树**做结构校验：把每个补丁目标文件按扩展名过一遍
 * （JS → node --check，YAML → js-yaml）。换走 asar 之前必须过这一关。
 * 与 verifyPatchedTree 的区别：那个是"预演"，这个是"验成品"。
 */
export function verifyHostTreeSyntax(aiBase, { dshHome = findDshHome(), patches = ALL_PATCHES } = {}) {
  const js = [];
  const yaml = [];
  const seen = new Set();
  let map = {};
  try { map = targetFilesAllowSealed(aiBase, dshHome) || {}; } catch { return { ok: false, errors: [{ file: "(map)", error: "解析 targetFiles 失败" }] }; }
  for (const patch of patches) {
    const raw = patch.file != null ? patch.file : patch.files;
    for (const name of (raw == null ? [] : (Array.isArray(raw) ? raw : [raw]))) {
      const v = map[name];
      for (const fp of (Array.isArray(v) ? v : (v ? [v] : []))) {
        if (typeof fp !== "string" || !fp || seen.has(fp)) continue;
        seen.add(fp);
        if (/\.(ya?ml)$/i.test(fp)) yaml.push(fp);
        else if (/\.(mjs|cjs|js|jsx|ts)$/i.test(fp)) js.push(fp);
      }
    }
  }
  const errors = [];
  const tmp = path.join(dshHome, "dsh-purge", "tmp-verify");
  let jsChecked = 0;
  try {
    fs.mkdirSync(tmp, { recursive: true });
    for (const fp of js) {
      jsChecked += 1;
      try {
        execFileSync(process.execPath, ["--check", fp], { stdio: "pipe", timeout: 30000 });
      } catch (e) {
        errors.push({ file: fp, error: String((e && (e.stderr || e.message)) || e).slice(0, 200) });
      }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  let yamlChecked = 0;
  const parser = loadYaml();
  if (parser) {
    for (const fp of yaml) {
      yamlChecked += 1;
      try { parser.load(fs.readFileSync(fp, "utf8"), { schema: parser.schema }); } catch (e) {
        errors.push({ file: fp, error: String(e && e.message ? e.message : e).slice(0, 200) });
      }
    }
  }
  return { ok: errors.length === 0, jsChecked, yamlChecked, yamlSkipped: parser ? 0 : yaml.length, errors: errors.slice(0, 8) };
}

/** 宿主树里找 js-yaml（官方/tauri 的 node_modules 里都有），找不到就退化为"不校验 YAML"。 */
function loadYaml() {
  if (loadYaml.cached !== undefined) return loadYaml.cached;
  const req = createRequire(import.meta.url);
  const bases = [];
  try { const b = findAiBase(); if (b) bases.push(b); } catch { /* ignore */ }
  try { const b = sealedHostArchive(); if (b) bases.push(path.join(b, "dsh", "node_modules"), b); } catch { /* ignore */ }
  bases.push(path.join(process.cwd(), "node_modules"));
  for (const base of bases) {
    for (const rel of ["js-yaml", "yaml"]) {
      try {
        const mod = req(path.join(base, rel));
        if (rel === "js-yaml" && typeof mod.load === "function") {
          const JsTag = new mod.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (d) => d });
          loadYaml.cached = { load: mod.load, schema: mod.DEFAULT_SCHEMA.extend([JsTag]) };
          return loadYaml.cached;
        }
        if (rel === "yaml" && typeof mod.parse === "function") {
          loadYaml.cached = { load: (t) => mod.parse(t), schema: undefined };
          return loadYaml.cached;
        }
      } catch { /* 下一个候选 */ }
    }
  }
  loadYaml.cached = null;
  return null;
}

/**
 * 在宿主进程内装同一套钩子。
 * 桌面端每次启动都会重写 asar-native.cjs（把 --require 那行洗掉），所以主进程拿不到
 * 预加载；这里补一刀，能覆盖"晚于插件加载"的模块（覆盖率见 runtime-inject.log 的 served 行）。
 */
export function installInProcess() {
  try {
    // 首次部署后的第一次启动：conf 还没被 sync 写出来，钩子会因为"没配置"直接返回。
    // 只要 manifest 已经在，就先把 conf 补上，别让顺序问题把这一轮注入吃掉。
    const confFile = path.join(path.dirname(hookPath()), CONF_NAME);
    if (!fs.existsSync(confFile)) {
      try {
        if (fs.existsSync(manifestPath())) writeHookConf(findDshHome(), { enabled: true });
      } catch { /* 补不上就算了 */ }
    }
    const req = createRequire(import.meta.url);
    const hook = req(hookPath());
    if (hook && typeof hook.install === "function") hook.install();
    const rt = globalThis.__dshPurgeRuntime || null;
    return { installed: Boolean(rt && rt.installed), files: rt ? rt.files : 0, served: rt ? Object.keys(rt.served || {}).length : 0 };
  } catch (e) {
    return { installed: false, error: String(e && e.message ? e.message : e) };
  }
}

/** 状态摘要：界面/CLI 用。 */
export function statusSummary(dshHome = findDshHome()) {
  const out = { active: false, files: 0, patches: 0, bytes: 0, preload: false, log: null };
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(path.dirname(hookPath()), CONF_NAME), "utf8"));
    out.active = conf.enabled === true;
  } catch { /* 没装 */ }
  try {
    const man = JSON.parse(fs.readFileSync(manifestPath(dshHome), "utf8"));
    out.files = Object.keys(man.files || {}).length;
    out.patches = Number(man.patches || 0);
    out.bytes = Object.values(man.files || {}).reduce((a, s) => a + Buffer.byteLength(String(s), "utf8"), 0);
  } catch { /* ignore */ }
  try {
    for (const dir of shimPreloadTargets()) {
      const t = path.join(dir, "asar-native.cjs");
      if (fs.existsSync(t) && fs.readFileSync(t, "utf8").includes(PRELOAD_MARK)) out.preload = true;
    }
  } catch { /* ignore */ }
  try {
    const rt = globalThis.__dshPurgeRuntime;
    if (rt && rt.installed) {
      out.inproc = true;
      out.served = Object.keys(rt.served || {}).length;
    }
  } catch { /* ignore */ }
  try { out.env = envPreloadState(dshHome); } catch { /* ignore */ }
  out.log = readRuntimeLog(dshHome, 8);
  return out;
}

/** 读回上一轮钩子写进日志的战果（要宿主重启一次才有内容）。 */
export function readRuntimeLog(dshHome = findDshHome(), lines = 12) {
  const fp = logPath(dshHome);
  try {
    const all = fs.readFileSync(fp, "utf8").trim().split(/\r?\n/).filter(Boolean);
    return { path: fp, tail: all.slice(-lines), total: all.length };
  } catch {
    return { path: fp, tail: [], total: 0 };
  }
}
