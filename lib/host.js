import { adapterFor, detectSurface } from "./surface.js";
import * as desktop from "./desktop.js";
import * as web from "./web.js";

/**
 * 当前进程是不是社区桌面端（dsh-tauri）托管的宿主。
 * 这种宿主由桌面端自己的服务管理器拉起，插件若擅自杀进程/自启，会留下一个
 * 桌面端不认识的后台进程（pid 文件失真、端口占用），所以只提示手动重启。
 */
function tauriManaged() {
  const install = String(process.env.DSH_INSTALL_DIR || "");
  if (install.includes("/dependencies/dsh/")) return true;
  if (/DSH\s*Tauri|dsh-tauri/i.test(String(process.env.DSH_NODE_EXECUTABLE || ""))) return true;
  return /DSH\s*Tauri|dsh-tauri/i.test(String(process.execPath || ""));
}

const ADAPTERS = {
  web,
  desktop,
};

export function currentSurface(input) {
  return detectSurface(input);
}

export function hostAdapter(kind = detectSurface()) {
  return ADAPTERS[adapterFor(kind)] || web;
}

export function scheduleRestart(request, ctx, options = {}) {
  if (tauriManaged()) {
    return {
      restarting: false,
      manual: true,
      error: "社区桌面端（dsh-tauri）：补丁已写入，请手动重启 DSH Tauri 后生效。",
    };
  }
  return hostAdapter().scheduleRestart(request, ctx, options);
}

export function scheduleCleanupRestart(opts) {
  return hostAdapter().scheduleCleanupRestart(opts);
}

export function restartNote() {
  return hostAdapter().restartNote();
}
