#!/bin/sh
# dsh-purge 一键安装（macOS / Linux / Git Bash on Windows）
#
#   sh scripts/install.sh                    # 交互：自动识别宿主与 profile
#   sh scripts/install.sh --profile tauri    # 指定 profile（社区桌面端多 profile）
#   sh scripts/install.sh --yes              # 不问问题，全用默认
#   sh scripts/install.sh --list             # 只列 profile
#   sh scripts/install.sh --spec "github:owner/repo#<sha>"
#
# 支持：官方 dsh web / 官方桌面 EXE / 社区桌面端 dsh-tauri（含自定义数据目录、
# 自定义依赖目录、多 profile）。
set -eu

SPEC="github:iuuuuuuuu/dsh-purge-plus#main"
PROFILE=""
ASSUME_YES=0
LIST_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --spec) SPEC="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --list) LIST_ONLY=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（-h 看用法）" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
ask() {
  # ask <提示> <默认 y/n>；非交互时用默认
  _prompt="$1"; _def="$2"
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
    [ "$_def" = "y" ] && return 0 || return 1
  fi
  printf '%s ' "$_prompt"
  read _ans </dev/tty || _ans=""
  _ans=${_ans:-$_def}
  case "$_ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

command -v node >/dev/null 2>&1 || { echo "需要 node（>=18）在 PATH 里" >&2; exit 1; }
command -v dsh >/dev/null 2>&1 || { echo "需要 dsh 在 PATH 里（官方 CLI 或桌面端生成的 shim）" >&2; exit 1; }

DSH_HOME_DIR="${DSH_HOME:-}"
[ -n "$DSH_HOME_DIR" ] || DSH_HOME_DIR="$HOME/.dsh"
PROFILES_DIR="$DSH_HOME_DIR/profiles"

say "dsh-purge 安装器"
say "  DSH_HOME   $DSH_HOME_DIR"

# ---- 1. profile 选择 --------------------------------------------------------
profiles=""
if [ -d "$PROFILES_DIR" ]; then
  for d in "$PROFILES_DIR"/*; do
    [ -f "$d/package.json" ] || continue
    profiles="$profiles $(basename "$d")"
  done
fi
profiles=$(printf '%s' "$profiles" | sed 's/^ *//')

if [ "$LIST_ONLY" = "1" ]; then
  say "  profiles:  ${profiles:-（无）}"
  exit 0
fi

if [ -z "$PROFILE" ] && [ -n "${DSH_PROFILE:-}" ] && [ -n "$profiles" ]; then
  case " $profiles " in *" $DSH_PROFILE "*) PROFILE="$DSH_PROFILE" ;; esac
fi
if [ -z "$PROFILE" ]; then
  # 社区桌面端会记住 active_profile
  ACTIVE=$(node -e '
    const fs=require("fs"),p=require("path");
    const cands=[]; const home=process.env.APPDATA||"";
    if (process.platform==="darwin") cands.push(p.join(process.env.HOME||"","Library","Application Support","dsh-tauri",".store.dat"));
    else if (process.platform==="win32") cands.push(p.join(home,"dsh-tauri",".store.dat"));
    else cands.push(p.join(process.env.XDG_CONFIG_HOME||p.join(process.env.HOME||"",".config"),"dsh-tauri",".store.dat"));
    for (const f of cands) { try { const s=JSON.parse(fs.readFileSync(f,"utf8")); if (s.setting&&s.setting.active_profile) { console.log(s.setting.active_profile); break; } } catch {} }
  ' 2>/dev/null || true)
  [ -n "$ACTIVE" ] && case " $profiles " in *" $ACTIVE "*) PROFILE="$ACTIVE" ;; esac
fi
if [ -z "$PROFILE" ]; then
  count=$(printf '%s' "$profiles" | wc -w | tr -d ' ')
  if [ "$count" = "0" ]; then
    say "找不到 profile（$PROFILES_DIR 为空）。先把宿主跑起来一次，或用 --profile 指定。"
    exit 1
  elif [ "$count" = "1" ]; then
    PROFILE="$profiles"
  else
    say ""
    say "发现多个 profile，装哪个？"
    i=1
    for p in $profiles; do say "  $i) $p"; i=$((i+1)); done
    printf '输入序号 [1]: '
    read pick </dev/tty || pick=1
    pick=${pick:-1}
    i=1
    for p in $profiles; do [ "$i" = "$pick" ] && PROFILE="$p"; i=$((i+1)); done
    [ -n "$PROFILE" ] || { say "序号无效"; exit 2; }
  fi
fi
say "  profile    $PROFILE"
say "  来源       $SPEC"

# ---- 2. 装包 ----------------------------------------------------------------
step "1/4 安装插件到 profile: $PROFILE"
dsh plugin --profile "$PROFILE" add "$SPEC" 2>&1 | tail -4

PLUGIN_DIR="$PROFILES_DIR/$PROFILE/node_modules/dsh-purge"
[ -f "$PLUGIN_DIR/bin/dsh-purge.js" ] || { echo "!! 装完没找到 $PLUGIN_DIR/bin/dsh-purge.js" >&2; exit 1; }
say "  插件版本   $(node -p "require('$PLUGIN_DIR/package.json').version")"

# ---- 3. 宿主与目录 ----------------------------------------------------------
step "2/4 识别宿主与目录"
node "$PLUGIN_DIR/bin/dsh-purge.js" --status 2>&1 | sed -n '1,9p'

HOST_JSON=$(node -e '
  import(process.argv[1]).then(m=>{
    const h=m.tauriHost();
    console.log(JSON.stringify(h?{tauri:true,coreAsar:h.coreAsar,dir:Boolean(h.dirAiBase),depsRoot:h.depsRoot,dataDir:h.dataDir,active:h.activeProfile}:{tauri:false}));
  }).catch(()=>console.log(JSON.stringify({tauri:false})));
' "$PLUGIN_DIR/lib/tauri.js")
say "  探测结果   $HOST_JSON"

is_true() { printf '%s' "$HOST_JSON" | grep -q "\"$1\":true"; }

# ---- 4. 社区桌面端：核心格式 ------------------------------------------------
step "3/4 社区桌面端（dsh-tauri）核心格式"
if is_true tauri; then
  if is_true coreAsar; then
    say "  当前核心：密封 asar（归档内不可写，补丁打不上去）"
    say "  目录核心：$(is_true dir && echo 已存在 || echo 尚未解包)"
    if ask "  解包成目录核心并切换核心格式？(y/N)" n; then
      node "$PLUGIN_DIR/bin/dsh-purge.js" --tauri-unpack --flip 2>&1 | tail -8
      say "  ！已切换，必须重启 DSH Tauri 才会从目录核心加载"
    else
      say "  跳过。以后可手动：node \"$PLUGIN_DIR/bin/dsh-purge.js\" --tauri-unpack --flip"
    fi
  else
    say "  当前核心：目录（可直接打补丁）"
  fi
else
  say "  不是 dsh-tauri 宿主，跳过（官方 web / 官方桌面按各自路径处理）"
fi

# ---- 5. 打补丁 --------------------------------------------------------------
step "4/4 打补丁"
node "$PLUGIN_DIR/bin/dsh-purge.js" --apply 2>&1 | tail -6

say ""
say "完成。"
say "  1) 重启宿主（社区桌面端必须手动重启；官方 web 重启 dsh web）"
say "  2) 自检：node \"$PLUGIN_DIR/bin/dsh-purge.js\" --verify"
say "  3) 多 profile 切换：node \"$PLUGIN_DIR/bin/dsh-purge.js\" --profiles"
