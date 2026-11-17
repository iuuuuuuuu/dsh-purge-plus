import path from "node:path";
import { createHash } from "node:crypto";
import { diskFs } from "./extract-asar.js";
import { listAsarEntries, readAsarHeader } from "./asar.js";

/**
 * 最小可用的 asar 打包器（零依赖）。
 *
 * 用途：社区桌面端的 @deepseek-ai 装在密封 asar 里，桌面端又拒绝切换目录核心时，
 * 唯一能让补丁生效的办法是把「补丁后的内容」重新封成同一个归档，让宿主照旧从 asar 加载。
 *
 * 格式（与 lib/asar.js 的读取器、Electron 一致）：
 *   [0,4)   u32 4
 *   [4,8)   u32 8 + align4(jsonLen)      // size pickle
 *   [8,12)  u32 4 + align4(jsonLen)      // header pickle 负载
 *   [12,16) u32 jsonLen
 *   [16,16+align4(jsonLen))  JSON header（NUL 补齐）
 *   之后是文件数据，offset 相对数据区起点
 *
 * transform(relPath, originalBuf) 返回替换后的 Buffer；返回 null 表示原样保留。
 * 改动过的条目会重算 integrity（SHA256 + 4MB 分块），未改动的原样保留。
 */

const BLOCK_SIZE = 4194304;

function align4(n) {
  return Math.ceil(n / 4) * 4;
}

function integrityOf(buf) {
  const blocks = [];
  for (let off = 0; off < buf.length || off === 0; off += BLOCK_SIZE) {
    const slice = buf.subarray(off, Math.min(off + BLOCK_SIZE, buf.length));
    blocks.push(createHash("sha256").update(slice).digest("hex"));
    if (off + BLOCK_SIZE >= buf.length) break;
  }
  return {
    algorithm: "SHA256",
    hash: createHash("sha256").update(buf).digest("hex"),
    blockSize: BLOCK_SIZE,
    blocks,
  };
}

function readRange(fd, offset, size) {
  if (size <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(size);
  let got = 0;
  while (got < size) {
    const n = diskFs().readSync(fd, buf, got, size - got, offset + got);
    if (n <= 0) break;
    got += n;
  }
  return got === size ? buf : buf.subarray(0, got);
}

function nodeAt(header, relPath) {
  const parts = String(relPath).split("/").filter(Boolean);
  let node = header;
  for (const part of parts) {
    if (!node || !node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  return node && !node.files ? node : null;
}

/**
 * 打包。source 为原始归档；out 为新归档路径（可指向临时目录）。
 * 返回 { ok, out, entries, changed, bytes, errors }。
 */
export function packAsar({ source, out, transform } = {}) {
  const fs = diskFs();
  const { header, dataStart } = readAsarHeader(source);
  const entries = listAsarEntries(header);
  const errors = [];
  const replacements = new Map();
  let changed = 0;
  let cursor = 0;

  const srcFd = fs.openSync(source, "r");
  try {
    // 第一遍：算出每个条目的新尺寸与新 offset（只保留改动过的小文件在内存里）
    for (const entry of entries) {
      if (entry.link || entry.unpacked) continue;
      const original = readRange(srcFd, dataStart + (entry.offset || 0), entry.size);
      let next = original;
      if (typeof transform === "function") {
        try {
          const replaced = transform(entry.path, original);
          if (replaced && Buffer.isBuffer(replaced)) next = replaced;
        } catch (e) {
          errors.push(`${entry.path}: ${e && e.message ? e.message : e}`);
        }
      }
      const node = nodeAt(header, entry.path);
      if (next !== original) {
        if (node) node.integrity = integrityOf(next);
        changed += 1;
        replacements.set(entry.path, next);
      }
      if (node) {
        node.size = next.length;
        // 官方/厂商归档里 offset 是**字符串**（"0"）。Electron 的 asar 读取器对数字
        // 不认（实测：同结构数字偏移 → 所有文件 ENOENT，字符串偏移 → 正常），所以照抄。
        node.offset = String(cursor);
      }
      cursor += align4(next.length);
    }
  } finally {
    fs.closeSync(srcFd);
  }

  // 写 header
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const jsonLen = json.length;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + align4(jsonLen), 4);
  prefix.writeUInt32LE(4 + align4(jsonLen), 8);
  prefix.writeUInt32LE(jsonLen, 12);
  const paddedJson = Buffer.alloc(align4(jsonLen));
  json.copy(paddedJson);
  // JSON 必须按 NUL 值判断（Buffer.allocUnsafe 会留垃圾），这里用 0 补齐后再写一次
  paddedJson.fill(0, jsonLen);

  const outFd = fs.openSync(out, "w");
  try {
    fs.writeSync(outFd, prefix, 0, prefix.length, 0);
    fs.writeSync(outFd, paddedJson, 0, paddedJson.length, prefix.length);
  } finally {
    fs.closeSync(outFd);
  }

  // 第二遍：写数据区（对齐到 4 字节）
  const srcFd2 = fs.openSync(source, "r");
  const outFd2 = fs.openSync(out, "r+");
  let written = 0;
  try {
    for (const entry of entries) {
      if (entry.link || entry.unpacked) continue;
      const node = nodeAt(header, entry.path);
      if (!node) continue;
      const buffer = replacements.get(entry.path);
      // offset 在 header 里是字符串（Electron 要求），算位置时必须转回数字，否则会变成字符串拼接。
      const target = prefix.length + paddedJson.length + Number(node.offset || 0);
      if (buffer) {
        fs.writeSync(outFd2, buffer, 0, buffer.length, target);
        written += buffer.length;
      } else {
        const chunk = readRange(srcFd2, dataStart + (entry.offset || 0), entry.size);
        fs.writeSync(outFd2, chunk, 0, chunk.length, target);
        written += chunk.length;
      }
    }
  } finally {
    fs.closeSync(srcFd2);
    fs.closeSync(outFd2);
  }

  return {
    ok: errors.length === 0,
    out,
    entries: entries.length,
    changed,
    bytes: written,
    dataStart: prefix.length + paddedJson.length,
    jsonLen,
    errors,
  };
}
