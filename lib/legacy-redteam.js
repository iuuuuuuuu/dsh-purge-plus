import fs from "node:fs";
import path from "node:path";

/**
 * 旧版独立红队包（dsh-redteam-mode 等）曾经由 bundle patch 里的
 * `- id: redteam-mode / disabled: true` 关掉。那几行在没装的机器上会让宿主每次
 * 启动刷 "patch: entry ... not found"，1.5.0 起改成运行时检测：
 * 只有真的装了才提示，不再改宿主的补丁层。
 */
export const LEGACY_REDTEAM_PACKAGES = [
  "dsh-redteam-mode",
  "dsh-redteam-store",
  "dsh-redteam-ui",
];

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 在 $DSH_HOME 下每个 profile 的 node_modules 里找出还留着的旧红队包。 */
export function detectLegacyRedteam(dshHome) {
  const root = String(dshHome || "").trim();
  if (!root) return [];
  const profilesDir = path.join(root, "profiles");
  const profiles = isDir(profilesDir) ? (() => {
    try { return fs.readdirSync(profilesDir); } catch { return []; }
  })() : [];
  const out = [];
  for (const profile of profiles) {
    const nm = path.join(profilesDir, profile, "node_modules");
    if (!isDir(nm)) continue;
    const hits = LEGACY_REDTEAM_PACKAGES.filter((name) => isDir(path.join(nm, name)));
    if (hits.length) out.push({ profile, packages: hits });
  }
  return out;
}

export function legacyRedteamWarning(dshHome) {
  const found = detectLegacyRedteam(dshHome);
  if (!found.length) return "";
  const detail = found.map((f) => `${f.profile}: ${f.packages.join(", ")}`).join("; ");
  return `检测到旧版独立红队包（${detail}）。它们会和本插件的演练台抢同一批 id，建议在 profile 里移除，或在补丁层手动写 disabled: true。`;
}
