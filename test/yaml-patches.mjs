/**
 * YAML 折叠块门禁（issue #1）。
 *
 * 背景：#4/#43/#76 这类身份剥离补丁，遇到 `prefix: >-` 折叠块时如果只把块头换成
 * `prefix: ""`、把块内正文留在原地，YAML 立刻非法 → 整个 bundle 被跳过、界面卡 loading。
 *
 * 门禁锁三件事：
 *   1. 补丁的替换字符串**本身**就产出合法形状（手动 String.replace 验证，不经过管线里
 *      的 repairFoldedYamlScalars 兜底）；
 *   2. 身份句确实被删；
 *   3. 故障注入：把替换字符串换回旧写法，检测必须判红——证明它不是永远绿。
 */
import { ALL_PATCHES, applyReplacementsToText, repairFoldedYamlScalars } from "../lib/core.js";

let pass = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? " :: " + detail : ""));
}

/** 「空标量后面跟着更深缩进的正文」= 这次要抓的坏形状。 */
function hasDanglingScalar(text) {
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!/^\s*[A-Za-z0-9_.-]+:[ \t]*""[ \t]*$/.test(lines[i])) continue;
    const indent = (lines[i].match(/^\s*/) || [""])[0].length;
    const next = lines[i + 1];
    if (!next || !next.trim()) continue;
    if ((next.match(/^\s*/) || [""])[0].length > indent) return true;
  }
  return false;
}

const YAML_PATH = "/tmp/host/dsh-web-app/presets/cordis.patch.yml";
function fixture4() {
  return [
    "agentPreset:",
    "    personaPrefix: >-",
    "      You are a coding agent powered by the {{model}} model.",
    "      You help the user customize DeepSeek Harness itself.",
  ].join("\n");
}
function fixture43() {
  return [
    "plugins:",
    "          - id: persona",
    "            name: '@deepseek-ai/dsh-persona'",
    "            config:",
    "              prefix: >-",
    "                You are a coding agent powered by the {{model}} model.",
    "                You help the user customize DeepSeek Harness itself.",
    "          - id: agent-instructions",
  ].join("\n");
}
const IDENTITY = "You are a coding agent powered by the {{model}} model.";

const cases = [
  { id: 4, fixture: fixture4(), foldedIndex: 0 },
  { id: 43, fixture: fixture43(), foldedIndex: 1 },
  { id: 76, fixture: fixture43(), foldedIndex: 1 },
];

for (const c of cases) {
  const patch = ALL_PATCHES.find((p) => p.id === c.id);
  check("#" + c.id + " 存在", Boolean(patch));
  if (!patch) continue;
  const folded = patch.replacements[c.foldedIndex];
  check("#" + c.id + " 折叠块替换存在", Boolean(folded && String(folded.pattern).includes(">-")));

  // 1) 替换字符串本身（绕过管线 repair）
  const manual = c.fixture.replace(folded.pattern, folded.replace);
  check("#" + c.id + " 替换字符串不再产生坏形状", !hasDanglingScalar(manual), JSON.stringify(manual.slice(0, 140)));
  check("#" + c.id + " 身份句已删", !manual.includes(IDENTITY));
  check("#" + c.id + " 替换结果本身无需 repair 兜底", repairFoldedYamlScalars(manual) === manual);

  // 2) 走完整管线
  const viaPipeline = applyReplacementsToText(c.fixture, patch, YAML_PATH).text;
  check("#" + c.id + " 管线输出无坏形状", !hasDanglingScalar(viaPipeline));

  // 3) 故障注入：旧写法（只换块头）必须被抓到
  const brokenManual = c.fixture.replace(folded.pattern, folded.replace.replace(">-,", '""').replace(">-", '""'));
  check("#" + c.id + " [故障注入] 旧写法被判成坏形状", hasDanglingScalar(brokenManual), JSON.stringify(brokenManual.slice(0, 140)));
  check("#" + c.id + " [故障注入] 旧写法会触发 repair", repairFoldedYamlScalars(brokenManual) !== brokenManual);
}

console.log(fails.length ? "FAILED" : "ALL PASS", " (" + pass + " passed, " + fails.length + " failed)");
for (const f of fails) console.log("  ✗ " + f);
process.exit(fails.length ? 1 : 0);
