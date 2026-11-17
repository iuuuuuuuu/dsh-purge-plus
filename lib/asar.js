import path from "node:path";
import { diskFs } from "./extract-asar.js";

/**
 * 读归档必须走真实磁盘（original-fs）。
 * 宿主进程里 Electron 的 node:fs 把 `*.asar` 当成目录：openSync 会 ENOENT，
 * statSync().isFile() 也是 false。在 CLI（node）里两者等价，在宿主里只有这份能用。
 */
const fs = diskFs();

/**
 * 最小可用的 asar 读取/解包实现（不引第三方依赖）。
 *
 * 社区桌面端（dsh-tauri）把整个 @deepseek-ai 运行时装进一个密封归档
 *    <support>/dependencies/dsh/deepseek-harness-pkg-<platform>-<arch>.asar
 * 归档内的文件在这个数组里只读（Electron 的 asar fs 走的是内存映射）。
 * 想给它打补丁只有一条路：解包成目录核心，让宿主从目录加载。
 *
 * 归档格式（Electron asar）：
 *   [0,4)   u32 4
 *   [4,8)   u32 header pickle 大小
 *   [8,12)  u32 header 字符串长度
 *   [12,16) u32 header 字符串长度（同上，实际用于定位数据区）
 *   [16,16+align4(sz))  JSON header
 *   之后是文件数据，offset 相对数据区起点
 */

const HEADER_FIXED = 16;

export function isAsarArchive(fp) {
  try {
    return fs.statSync(fp).isFile() && fp.toLowerCase().endsWith(".asar");
  } catch {
    return false;
  }
}

export function readAsarHeader(fp) {
  const fd = fs.openSync(fp, "r");
  try {
    const head = Buffer.alloc(HEADER_FIXED);
    fs.readSync(fd, head, 0, HEADER_FIXED, 0);
    if (head.readUInt32LE(0) !== 4) throw new Error("not an asar archive: bad magic");
    const size = head.readUInt32LE(12);
    if (!size || size > 256 * 1024 * 1024) throw new Error("not an asar archive: bad header size");
    const headerBuf = Buffer.alloc(size);
    fs.readSync(fd, headerBuf, 0, size, HEADER_FIXED);
    const json = headerBuf.toString("utf8").replace(/\u0000+$/, "");
    const header = JSON.parse(json);
    // 数据区按 4 字节对齐
    const dataStart = HEADER_FIXED + Math.ceil(size / 4) * 4;
    return { header, dataStart };
  } finally {
    fs.closeSync(fd);
  }
}

/** 把 header 展开成 [{ path, size, offset, executable, unpacked, link }]。 */
export function listAsarEntries(header, options = {}) {
  const entries = [];
  const skip = options.skip || (() => false);
  const walk = (node, prefix) => {
    const files = node && node.files;
    if (!files) return;
    for (const [name, child] of Object.entries(files)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child && child.files) {
        walk(child, rel);
        continue;
      }
      if (skip(rel)) continue;
      entries.push({
        path: rel,
        size: Number(child.size || 0),
        offset: child.offset === undefined ? null : Number(child.offset),
        executable: child.executable === true,
        unpacked: child.unpacked === true,
        link: typeof child.link === "string" ? child.link : null,
      });
    }
  };
  walk(header, "");
  return entries;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyChunked(fd, offset, target, size) {
  const buf = Buffer.allocUnsafe(Math.min(4 * 1024 * 1024, Math.max(size, 1)));
  let written = 0;
  const out = fs.openSync(target, "w");
  try {
    while (written < size) {
      const want = Math.min(buf.length, size - written);
      const got = fs.readSync(fd, buf, 0, want, offset + written);
      if (got <= 0) break;
      fs.writeSync(out, buf, 0, got);
      written += got;
    }
  } finally {
    fs.closeSync(out);
  }
  return written;
}

/**
 * 把 asar 解包到 destDir（保留相对路径、权限位、符号链接）。
 * onProgress(entry, index, total) 可选；返回值带统计。
 */
export function extractAsar(archive, destDir, options = {}) {
  const { header, dataStart } = readAsarHeader(archive);
  const entries = listAsarEntries(header);
  const unpackedDir = `${archive}.unpacked`;
  const fd = fs.openSync(archive, "r");
  const stats = { files: 0, links: 0, unpackedCopied: 0, bytes: 0, errors: [] };
  try {
    entries.forEach((entry, index) => {
      const target = path.join(destDir, ...entry.path.split("/"));
      try {
        ensureDir(path.dirname(target));
        if (entry.link) {
          try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
          fs.symlinkSync(entry.link, target);
          stats.links += 1;
        } else if (entry.unpacked) {
          const source = path.join(unpackedDir, ...entry.path.split("/"));
          fs.copyFileSync(source, target);
          stats.unpackedCopied += 1;
          stats.bytes += entry.size;
        } else {
          const written = copyChunked(fd, dataStart + (entry.offset || 0), target, entry.size);
          stats.bytes += written;
          if (entry.executable) fs.chmodSync(target, 0o755);
          else fs.chmodSync(target, 0o644);
        }
        stats.files += 1;
      } catch (error) {
        stats.errors.push(`${entry.path}: ${error && error.message ? error.message : String(error)}`);
      }
      if (typeof options.onProgress === "function") {
        options.onProgress(entry, index, entries.length);
      }
    });
  } finally {
    fs.closeSync(fd);
  }
  return { ...stats, total: entries.length };
}
/** 从归档里读单个文件（不解包），用于取版本号之类的小文件。 */
export function readAsarFile(archive, relPath, options = {}) {
  const { header, dataStart } = readAsarHeader(archive);
  const want = String(relPath || "").split("/").filter(Boolean);
  let node = header;
  for (const part of want) {
    if (!node || !node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  if (!node || node.files) return null;
  const max = Number(options.maxBytes || 1024 * 1024);
  const size = Math.min(Number(node.size || 0), max);
  const fd = fs.openSync(archive, "r");
  try {
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, dataStart + Number(node.offset || 0));
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
