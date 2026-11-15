// dsh-tauri（社区桌面端）宿主适配的单元测试：不启动宿主、不碰真实桌面安装。
// usage: node test/tauri-host.mjs [pluginDir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = process.argv[2] || path.resolve(here, "..");
const load = (name) => import(pathToFileURL(path.join(pluginDir, "lib", name)).href);

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log("  ok   " + name);
  } else {
    failed += 1;
    console.log("  FAIL " + name + (detail ? "  << " + detail : ""));
  }
}

/** 造一个最小合法 asar（header + 对齐后的 JSON + 数据区）。 */
function buildAsar(files) {
  const names = Object.keys(files).sort();
  const flat = [];
  let offset = 0;
  for (const name of names) {
    const buf = Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name], "utf8");
    flat.push({ name, buf, offset });
    offset += buf.length;
  }
  const header = { files: {} };
  for (const f of flat) {
    const parts = f.name.split("/");
    let node = header;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      if (!node.files[key]) node.files[key] = { files: {} };
      node = node.files[key];
    }
    node.files[parts[parts.length - 1]] = { size: f.buf.length, offset: String(f.offset) };
  }
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(padded.length, 4);
  head.writeUInt32LE(json.length, 8);
  head.writeUInt32LE(padded.length, 12);
  return Buffer.concat([head, padded, ...flat.map((f) => f.buf)]);
}

const MARKER = "license-free-live-verify";

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-tauri-"));
  const support = path.join(root, "dsh-tauri");
  const deps = path.join(support, "dependencies", "dsh");
  const pkgName = "deepseek-harness-pkg-test-arch";
  fs.mkdirSync(deps, { recursive: true });
  fs.writeFileSync(path.join(support, "dependencies.json"), JSON.stringify({ dsh: deps, node: null, pnpm: null }, null, 2));
  fs.writeFileSync(path.join(support, ".store.dat"), JSON.stringify({
    setting: { core_asar: true, dsh_pkg_tag: "dsh-test", active_profile: "tauri" },
  }, null, 2));
  const archive = path.join(deps, `${pkgName}.asar`);
  fs.writeFileSync(archive, buildAsar({
    "package.json": JSON.stringify({ name: "fake-harness", version: "9.9.9" }),
    "node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js":
      `export const WORKSPACE_CONTEXT_INTRO = "${MARKER}";\n`,
    "node_modules/@deepseek-ai/dsh/package.json": JSON.stringify({ name: "@deepseek-ai/dsh", version: "9.9.9" }),
  }));
  return { root, support, deps, archive, pkgName };
}

async function main() {
  const { root, support, deps, archive } = makeFixture();
  const asarMod = await load("asar.js");
  const tauri = await load("tauri.js");
  const core = await load("core.js");

  console.log("asar 读取与解包");
  const header = asarMod.readAsarHeader(archive);
  check("header 可解析", Boolean(header.header && header.header.files));
  const entries = asarMod.listAsarEntries(header.header);
  check("条目数正确", entries.length === 3, String(entries.length));
  check("单文件读取", String(asarMod.readAsarFile(archive, "package.json")).includes("9.9.9"));

  console.log("宿主识别（asar 核心）");
  const sealedEnv = {
    ...process.env,
    DSH_INSTALL_DIR: path.join(archive, "node_modules", "@deepseek-ai", "dsh"),
  };
  const hostSealed = tauri.tauriHost(sealedEnv);
  check("支持目录来自 DSH_INSTALL_DIR", hostSealed && hostSealed.support === support, hostSealed && hostSealed.support);
  check("识别为 asar 核心", hostSealed && hostSealed.coreAsar === true);
  check("版本取自归档", hostSealed && hostSealed.version === "9.9.9", hostSealed && hostSealed.version);
  const sealedBase = tauri.tauriAiBase(sealedEnv);
  check("asar 核心不给出可写根", sealedBase && sealedBase.sealed === true && sealedBase.base === null);
  check("密封路径可回报", sealedBase && sealedBase.asar === archive);

  console.log("core.findAiBase 不退回旧树");
  const savedInstall = process.env.DSH_INSTALL_DIR;
  process.env.DSH_INSTALL_DIR = sealedEnv.DSH_INSTALL_DIR;
  core.resetPathMemo();
  check("密封宿主 → 未定位", core.findAiBase() === null, String(core.findAiBase()));
  check("hostKind 为 tauri", core.hostKind() === "tauri", core.hostKind());
  // 机器上可能还装着别的宿主（本机就有），所以只断言夹具里的路径不外泄。
  const bases = core.enumeratePatchAiBases();
  check("密封 asar 不外泄为补丁目标", bases.every((b) => !b.includes(root)), JSON.stringify(bases));
  check("补丁目标里没有 .asar 内路径", bases.every((b) => !b.toLowerCase().includes(".asar/")));
  check("提示文案指向解包", /tauri-unpack/.test(core.missingAiBaseMessage()));

  console.log("解包成目录核心");
  const unpacked = tauri.unpackTauriCore({ env: sealedEnv, dshHome: root });
  check("解包成功", unpacked.ok === true, unpacked.error);
  check("生成了 @deepseek-ai", fs.existsSync(path.join(deps, "node_modules", "@deepseek-ai", "dsh-agent-instructions", "lib", "index.js")));
  const text = fs.readFileSync(path.join(deps, "node_modules", "@deepseek-ai", "dsh-agent-instructions", "lib", "index.js"), "utf8");
  check("内容逐字节还原", text.includes(MARKER));
  const again = tauri.unpackTauriCore({ env: sealedEnv, dshHome: root });
  check("重复解包跳过", again.skipped === true);

  console.log("切换核心格式");
  const flipped = tauri.setCoreAsar(false, sealedEnv);
  check("core_asar 关掉", flipped.ok === true && flipped.after === false, flipped.error);
  const store = JSON.parse(fs.readFileSync(path.join(support, ".store.dat"), "utf8"));
  check("store 已写入", store.setting.core_asar === false);
  check("备份存在", fs.existsSync(path.join(support, ".store.dat.dshpurge.bak")));
  const dirHost = tauri.tauriHost(sealedEnv);
  const dirBase = tauri.tauriAiBase(sealedEnv);
  check("切到目录核心后给出可写根", dirBase && dirBase.sealed === false && dirBase.base === path.join(deps, "node_modules", "@deepseek-ai"), dirBase && dirBase.base);
  check("宿主仍识别到同一 deps", dirHost && dirHost.depsRoot === deps);

  console.log("目录核心下 findAiBase 命中");
  process.env.DSH_INSTALL_DIR = path.join(deps, "node_modules", "@deepseek-ai", "dsh");
  core.resetPathMemo();
  const structural = tauri.tauriAiBase();
  check("tauriAiBase 有根", Boolean(structural && structural.base), JSON.stringify(structural && structural.base));
  check("目录核心不密封", core.sealedHostAsar() === "");

  console.log("官方桌面 / 官方 web 不被 tauri 规则误伤");
  const officialAsar = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";
  const officialEnv = {
    HOME: process.env.HOME,
    DSH_INSTALL_DIR: path.join(officialAsar, "node_modules", "@deepseek-ai", "dsh"),
    DSH_NODE_EXECUTABLE: "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
  };
  check("官方 app.asar 不算 tauri 托管", tauri.isTauriManaged(officialEnv) === false);
  check("tauri 夹具算 tauri 托管", tauri.isTauriManaged(sealedEnv) === true);
  const offInst = core.aiBaseFromInstallDir(officialEnv.DSH_INSTALL_DIR);
  check("官方 app.asar 仍被识别为密封", offInst.kind === "sealed", offInst.kind);
  check("官方 app.asar 的归档路径正确", offInst.asar === officialAsar, offInst.asar);
  // 官方 web：安装位是真实目录 → 直接命中，不进入任何密封分支
  // 模拟一台纯 dsh web 机器：npm 全局安装位，路径不含 dsh-tauri/dependencies
  const webBase = path.join(root, "npm-global", "lib", "node_modules", "@deepseek-ai");
  fs.mkdirSync(path.join(webBase, "dsh-agent-instructions", "lib"), { recursive: true });
  fs.writeFileSync(path.join(webBase, "dsh-agent-instructions", "lib", "index.js"), "export const x = 1;\n");
  const webEnv = { HOME: process.env.HOME, DSH_INSTALL_DIR: path.join(webBase, "dsh") };
  const webInst = core.aiBaseFromInstallDir(webEnv.DSH_INSTALL_DIR);
  check("官方 web 安装位直接命中", webInst.kind === "ok" && webInst.base === webBase, JSON.stringify(webInst));
  check("官方 web 不算 tauri 托管", tauri.isTauriManaged(webEnv) === false);

  console.log("旧树过滤");
  const stale = path.join(support, "dependencies", "dsh-0.2.1-rc.2", "node_modules", "@deepseek-ai");
  check("dependencies 下旧核心判为不可打", core.isUnpatchableBase(stale) === true);
  check("asar 内路径判为不可打", core.isUnpatchableBase(path.join(archive, "node_modules", "@deepseek-ai")) === true);
  check("目录核心可打", core.isUnpatchableBase(path.join(deps, "node_modules", "@deepseek-ai")) === false);

  process.env.DSH_INSTALL_DIR = savedInstall;
  core.resetPathMemo();
  fs.rmSync(root, { recursive: true, force: true });

  console.log("");
  console.log(failed === 0 ? `ALL PASS  (${passed} passed)` : `FAILED  (${failed} failed / ${passed} passed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
