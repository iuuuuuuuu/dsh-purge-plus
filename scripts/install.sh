#!/bin/sh
# 一键安装 dsh-purge：自动识别宿主，装插件、按需切目录核心、打补丁、告诉你下一步。
#
#   sh scripts/install.sh                       # 装本仓库 main
#   sh scripts/install.sh <pnpm spec>           # 换来源，如 github:owner/repo#<sha>
#
# 环境变量：DSH_PROFILE（默认取 $DSH_PROFILE，否则 tauri），DSH_HOME 由 dsh 自己决定。
set -eu

SPEC="${1:-github:iuuuuuuuu/dsh-purge-plus#main}"
PROFILE="${DSH_PROFILE:-tauri}"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_DIR="$HOME_DIR/profiles/$PROFILE/node_modules/dsh-purge"

step() { printf '\n== %s\n' "$1"; }

step "1/4 安装插件（profile=$PROFILE，来源=$SPEC）"
dsh plugin --profile "$PROFILE" add "$SPEC" 2>&1 | tail -4

if [ ! -f "$PLUGIN_DIR/bin/dsh-purge.js" ]; then
  echo "!! 装完没找到 $PLUGIN_DIR/bin/dsh-purge.js" >&2
  exit 1
fi

step "2/4 识别宿主"
node "$PLUGIN_DIR/bin/dsh-purge.js" --status 2>&1 | head -8

step "3/4 社区桌面端（dsh-tauri）：按需把 asar 核心解包成目录核心"
if node -e "import('$PLUGIN_DIR/lib/tauri.js').then(m=>process.exit(m.tauriHost()?0:1))" 2>/dev/null; then
  if node -e "import('$PLUGIN_DIR/lib/tauri.js').then(m=>{const h=m.tauriHost();process.exit(h&&h.coreAsar===false&&h.dirAiBase?0:1)})" 2>/dev/null; then
    echo "  已经是目录核心，跳过"
  else
    node "$PLUGIN_DIR/bin/dsh-purge.js" --tauri-unpack --flip 2>&1 | tail -6
    echo "  !! 核心格式已切到目录版，需要重启 DSH Tauri 后才会从目录加载"
  fi
else
  echo "  不是 dsh-tauri 宿主，跳过"
fi

step "4/4 打补丁"
node "$PLUGIN_DIR/bin/dsh-purge.js" --apply 2>&1 | tail -6

printf '\n完成。重启宿主后跑一次自检：\n  node %s --verify\n' "$PLUGIN_DIR/bin/dsh-purge.js"
