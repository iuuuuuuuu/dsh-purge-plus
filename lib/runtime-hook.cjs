'use strict';
/*
 * [dsh-purge] 加载期注入预加载（Route 3）
 *
 * 为什么需要它：社区桌面端把整个 @deepseek-ai 装进密封 asar，桌面端自己的
 * 「切换目录核心」在部分构建上会失败（CORE_INTEGRITY_UNAVAILABLE），补丁就没有
 * 任何可写目标。这里换成在**模块加载期**直接交付补丁后的源码：asar 一个字节不动。
 *
 * 由宿主启动参数里的 --require <shim>\asar-native.cjs 拉起（插件只在那份文件末尾
 * 追一行 require，留 .bak、可还原）。module.registerHooks 是 Node 22.15+ 的同步钩子，
 * ESM / CJS 都覆盖；老 Node 上自动退化成"什么都不做"。
 *
 * 铁律：这里任何异常都不许抛出去——抛了宿主就起不来。
 */
(function installPurgeRuntimeHook() {
  var fs, url;
  try { fs = require('node:fs'); url = require('node:url'); } catch (e) { return; }

  var conf = null;
  try { conf = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'runtime-hook.conf.json'), 'utf8')); } catch (e) { return; }
  if (!conf || conf.enabled !== true || !conf.manifest) return;

  var logPath = conf.log || '';
  function log(msg) {
    if (!logPath) return;
    try { fs.appendFileSync(logPath, new Date().toISOString() + ' [runtime-inject] ' + msg + '\n', 'utf8'); } catch (e) { /* 吞 */ }
  }

  var manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(conf.manifest, 'utf8')); } catch (e) { log('manifest 读取失败: ' + (e && e.message)); return; }
  var files = (manifest && manifest.files) || {};
  var total = Object.keys(files).length;
  if (!total) { log('manifest 为空，跳过'); return; }

  var mod = null;
  try { mod = require('node:module'); } catch (e) { /* ignore */ }
  if (!mod || typeof mod.registerHooks !== 'function') {
    log('当前 Node 没有 module.registerHooks，运行时注入不可用 (node=' + (process.versions && process.versions.node) + ')');
    return;
  }

  function normKey(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }

  var served = Object.create(null);
  try {
    mod.registerHooks({
      load: function (specifier, context, nextLoad) {
        var bare = String(specifier || '');
        var q = bare.search(/[?#]/);
        if (q >= 0) bare = bare.slice(0, q);
        if (bare.slice(0, 5).toLowerCase() !== 'file:') return nextLoad(specifier, context);
        var file = '';
        try { file = url.fileURLToPath(bare); } catch (e) { return nextLoad(specifier, context); }
        var src = files[normKey(file)];
        if (typeof src !== 'string') return nextLoad(specifier, context);
        var loaded = nextLoad(specifier, context);
        if (!loaded || loaded.format == null) return loaded;
        served[normKey(file)] = (served[normKey(file)] || 0) + 1;
        log('served ' + loaded.format + ' ' + file);
        return { format: loaded.format, source: src, shortCircuit: true };
      },
    });
    log('installed node=' + (process.versions && process.versions.node) + ' files=' + total + ' patches=' + ((manifest && manifest.patches) || 0));
  } catch (e) {
    log('registerHooks 失败: ' + (e && e.message));
  }

  /*
   * 第二条通道：yml/json/md 这类**不是模块**的文件走不了 registerHooks。
   * 它们由宿主用 fs.readFileSync 读取（cordis.patch.yml、presets/*.patch.yml 等），
   * 所以在这里对**精确路径**做只读替换；不在表里的路径原样交回。
   */
  var textFiles = 0;
  try {
    var fsmod = require('node:fs');
    var origRead = fsmod.readFileSync;
    fsmod.readFileSync = function (target, options) {
      try {
        if (typeof target === 'string') {
          var hit = files[normKey(target)];
          if (typeof hit === 'string') {
            textFiles += 1;
            served[normKey(target)] = (served[normKey(target)] || 0) + 1;
            log('served text ' + target);
            var enc = (typeof options === 'string') ? options : (options && options.encoding);
            return enc ? hit : Buffer.from(hit, 'utf8');
          }
        }
      } catch (e) { /* 落到原函数 */ }
      return origRead.apply(fsmod, arguments);
    };
  } catch (e) {
    log('fs 通道安装失败: ' + (e && e.message));
  }

  try {
    globalThis.__dshPurgeRuntime = { installed: true, files: total, textFiles: textFiles, served: served, at: new Date().toISOString(), get textServed() { return textFiles; } };
  } catch (e) { /* ignore */ }
})();
