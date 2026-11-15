#!/usr/bin/env node

import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";

const args = process.argv.slice(2);

function printStatus(state) {
  const out = [];
  out.push("dsh-purge 状态 / Status");
  out.push("  宿主 / surface " + (state.surface || "web") + (state.host_kind ? " (" + state.host_kind + ")" : ""));
  out.push("  DSH_HOME      " + state.dsh_home);
  if (state.tauri_support) {
    out.push("  dsh-tauri     " + state.tauri_support + " | core=" + (state.tauri_core || "?") + " | v" + (state.tauri_version || "?"));
  }
  if (state.sealed) out.push("  密封核心       " + state.sealed_asar + "（归档内不可写，需解包成目录核心）");
  if (state.legacy_redteam_warning) out.push("  ⚠ 旧红队包      " + state.legacy_redteam_warning);
  if (state.desktop_install) out.push("  桌面安装       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  插件根 / root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  插件根 / root  " + core.missingAiBaseMessage());
  }
  out.push(`  shim 目录      ${state.shim_dir || "未定位 / not found"}`);
  out.push(`  备份 / backup  ${state.has_backup ? "有 / yes" : "无 / no"}`);
  out.push(`  注入文件       ${state.override_path}`);
  out.push(`  注入状态       ${state.override_status}`);
  out.push("");
  out.push(`  补丁 ${state.patches_applied}/${core.ALL_PATCHES.length} 已清洗, ${state.patches_pending} 待清洗`);
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id];
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : "·";
    out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  out.push("");
  out.push(`  shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

async function main() {
  const mode = args.find((a) => ["--apply", "--revert", "--uninstall", "--status", "--edit", "--help", "--tauri-unpack", "--tauri-core"].includes(a));

  if (mode === "--help" || args.includes("-h")) {
    console.log(`dsh-purge 用法:
  dsh-purge --status     显示状态
  dsh-purge --apply      应用全部清洗（提示词+代码+shim+override）
  dsh-purge --revert     回滚还原
  dsh-purge --uninstall  卸载插件（已应用则先还原）
  dsh-purge --edit       编辑注入文件 prompt-inject.md
  dsh-purge --tauri-unpack [--flip]   把 dsh-tauri 的 asar 核心解包成目录核心（--flip 同时切换核心格式）
  dsh-purge --tauri-core dir|asar     切换 dsh-tauri 的核心格式（切换后需重启桌面端）
  dsh-purge --help       帮助`);
    return;
  }

  const state = await core.gatherState();
  console.log(printStatus(state));
  console.log("");

  if (mode === "--apply") {
    if (!state.ai_base) {
      console.log("[ERROR] " + core.missingAiBaseMessage());
      console.log("  fix: 把 DSH_BASE 指到含 dsh-agent-instructions/lib 的 @deepseek-ai 目录");
      process.exit(1);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] 提示词和规则集都是空的，必须先添加提示词");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  宿主 / host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ 已清洗" : r.status === "already" ? "- 已是最新" : r.status === "missing_file" ? "⚠ 文件缺失" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`);
    }
    const flashHost = hosts[0]?.aiBase || state.ai_base;
    const flash = core.silenceCmdFlash(flashHost);
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  多宿主 / multi-host: ${hosts.length} 份 @deepseek-ai 已清洗`);
    }
    console.log(inject.source === "rule"
      ? "  - 使用当前规则集，不改写提示词文件"
      : "  - 使用已有提示词文件");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} 注入 / injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} 已注入 / already injected`);
        else if (st === "missing") console.log(`  - shim ${fname} 不存在 / missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  ⚠ 未定位 shim 目录，跳过注入");
    }
    console.log("");
    console.log("全部完成 / All done。重启 dsh 生效 / Restart dsh to take effect.");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ 已还原 / Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ 还原失败 ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - 没有补丁备份可还原 / no patch backup");
    }
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
    console.log("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
  } else if (mode === "--tauri-unpack") {
    const tauri = await import("../lib/tauri.js");
    const host = tauri.tauriHost();
    if (!host) {
      console.log("[ERROR] 没找到 dsh-tauri 宿主（dependencies.json / .store.dat）");
      process.exit(1);
    }
    console.log("  " + tauri.describeTauriHost(host));
    if (!host.asar) {
      console.log("  - 没有 asar 核心，无需解包" + (host.dirAiBase ? "；目录核心已在：" + host.dirAiBase : ""));
      process.exit(host.dirAiBase ? 0 : 1);
    }
    console.log("  注意：桌面对依赖目录有自己的安装校验。切换核心格式后它若判定「缺失/过期」，");
    console.log("        会自行从 GitHub 下载 deepseek-harness-pkg-<平台>.zip（约 200 MB）覆盖本目录；");
    console.log("        那是桌面端行为，插件接管不了。解包的意义是离线/避免这次下载。");
    console.log("  解包 / unpacking → " + host.depsRoot);
    let seen = 0;
    const result = tauri.unpackTauriCore({
      dshHome: state.dsh_home,
      host,
      onProgress: (entry, index, total) => {
        seen = index + 1;
        if (seen % 5000 === 0) console.log(`    ${seen}/${total} ${entry.path}`);
      },
    });
    if (result.skipped) {
      console.log("  - 已解包过，跳过 / already unpacked");
    } else {
      console.log(`  ✓ 解包完成：${result.files}/${result.total} 个文件，${(result.bytes / 1048576).toFixed(1)} MB` + (result.links ? `，${result.links} 个符号链接` : ""));
      if (result.errors.length) {
        for (const e of result.errors.slice(0, 8)) console.log("  ⚠ " + e);
        if (result.errors.length > 8) console.log(`  ⚠ 另有 ${result.errors.length - 8} 个错误`);
      }
    }
    if (!result.base) {
      console.log("[ERROR] 解包后仍然找不到 node_modules/@deepseek-ai");
      process.exit(1);
    }
    console.log("  目录核心 / directory core " + result.base);
    if (args.includes("--flip")) {
      const flipped = tauri.setCoreAsar(false);
      if (!flipped.ok) {
        console.log("[ERROR] 切换核心格式失败: " + flipped.error);
        process.exit(1);
      }
      console.log(`  ✓ 核心格式 asar → directory（备份 ${flipped.backup}）`);
      console.log("  重启 DSH Tauri 后生效，然后点「应用」。");
    } else {
      console.log("  下一步：dsh-purge --tauri-core dir（或 DSH Tauri 设置里关掉 ASAR），重启桌面端后点「应用」。");
    }
  } else if (mode === "--tauri-core") {
    const tauri = await import("../lib/tauri.js");
    const want = String(args[args.indexOf("--tauri-core") + 1] || "").trim().toLowerCase();
    if (!["dir", "directory", "asar"].includes(want)) {
      console.log("[ERROR] 用法：dsh-purge --tauri-core dir|asar");
      process.exit(1);
    }
    const host = tauri.tauriHost();
    if (!host) {
      console.log("[ERROR] 没找到 dsh-tauri 宿主");
      process.exit(1);
    }
    const enabled = want === "asar";
    const res = tauri.setCoreAsar(enabled);
    if (!res.ok) {
      console.log("[ERROR] " + res.error);
      process.exit(1);
    }
    console.log(`  ✓ core_asar: ${res.before} → ${res.after}（${res.storePath}；备份 ${res.backup}）`);
    if (!enabled && !host.dirAiBase) {
      console.log("  ⚠ 目录核心还不存在，先跑 dsh-purge --tauri-unpack，否则桌面端起不来");
      process.exit(1);
    }
    console.log("  重启 DSH Tauri 后生效。");
  } else if (mode === "--uninstall") {
    const { uninstallPurge } = await import("../lib/uninstall.js");
    const result = await uninstallPurge();
    if (result.applied) console.log("  已检测到补丁，已还原回原版。");
    else console.log("  未检测到已应用补丁，仍会清除插件文件。");
    if (result.override?.removed) console.log(`  已删除 ${result.override.path}`);
    if (result.stripped?.length) console.log(`  已从 profile 移除: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    if (!result.ok) {
      console.log("  卸载中止：还原失败，插件文件未删除。");
      process.exit(1);
    }
    console.log("");
    console.log("卸载完成。请重启 dsh。");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ 已创建默认注入文件：${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → 已打开 ${r.editor} 编辑注入文件：${r.path}`);
    }
    console.log("  编辑完成后重启 dsh 生效。");
  } else {
    console.log("默认不清洗，使用 --apply 应用清洗。");
  }
}

main().catch((e) => {
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
