/**
 * 破甲关键项告警门禁。
 *
 * 为什么需要：宿主升级会让补丁锚点失配，条目落进 skipped；skipped 在面板上历来被当成
 * 「本版本不需要 / 组件未装」的无害终态。于是出现「提示词写得好好的，但授权后任务仍被
 * 沙箱/审批/观测门拦住」——破甲关键项被跳过而界面不报警。
 *
 * 这条门禁锁三件事：
 *   1. 关键项清单非空且都能在补丁表里找到（防止清单写错 id 静默失效）；
 *   2. skipped / unmatched 的关键项会被检出，applied / missing_file / na 不会；
 *   3. 真实 gatherState 的 critical_alert 与检出结果一致（接线正确，不是只写了函数）。
 * 并做故障注入：把 applied 改成 skipped 必须让检出从空变成非空。
 */
import * as core from "../lib/core.js";

let pass = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? " :: " + detail : ""));
}

// 1) 清单本身
const ids = [...core.CRITICAL_PATCH_IDS];
check("关键项清单非空", ids.length >= 5, "size=" + ids.length);
for (const id of ids) {
  check("关键项 #" + id + " 存在于补丁表", core.ALL_PATCHES.some((p) => p.id === id));
}

// 2) 检出语义
const byId = (id) => ({ [id]: "skipped" });
check("空状态不报警", core.criticalSkippedOf({}).length === 0);
const allApplied = {};
for (const p of core.ALL_PATCHES) allApplied[p.id] = "applied";
check("全部 applied 不报警", core.criticalSkippedOf(allApplied).length === 0);
check("skipped 会被检出", core.criticalSkippedOf({ 13: "skipped" }).join(",") === "13");
check("unmatched 会被检出", core.criticalSkippedOf({ 35: "unmatched" }).join(",") === "35");
check("多条按 id 升序", core.criticalSkippedOf({ 62: "skipped", 13: "unmatched" }).join(",") === "13,62");
check("missing_file 不算跳过（组件未装）", core.criticalSkippedOf({ 17: "missing_file" }).length === 0);
check("na 不算跳过（上游已删实现）", core.criticalSkippedOf({ 60: "na" }).length === 0);
check("非关键项 skipped 不报警", core.criticalSkippedOf({ 18: "skipped", 70: "skipped" }).length === 0);

// 3) 故障注入：状态翻转必须让结论翻转（证明不是恒空/恒真）
for (const id of [13, 62]) {
  const applied = core.criticalSkippedOf({ [id]: "applied" });
  const skipped = core.criticalSkippedOf({ [id]: "skipped" });
  check("[故障注入] #" + id + " applied→空", applied.length === 0);
  check("[故障注入] #" + id + " skipped→命中", skipped.length === 1 && skipped[0] === id);
}

// 4) 真实接线：gatherState 的字段与检出结果一致
const state = await core.gatherState();
const expected = core.criticalSkippedOf(state.patch_status || {});
check("gatherState 带 critical_skipped", Array.isArray(state.critical_skipped), JSON.stringify(state.critical_skipped));
check("gatherState 检出与独立计算一致", JSON.stringify(state.critical_skipped) === JSON.stringify(expected), JSON.stringify({ got: state.critical_skipped, expected }));
check("gatherState critical_alert 与检出长度一致", state.critical_alert === (expected.length > 0));
if (expected.length === 0) {
  check("当前宿主无关键项被跳过时 alert=false", state.critical_alert === false);
}

console.log(fails.length ? "FAILED" : "ALL PASS", " (" + pass + " passed, " + fails.length + " failed)");
for (const f of fails) console.log("  ✗ " + f);
process.exit(fails.length ? 1 : 0);
