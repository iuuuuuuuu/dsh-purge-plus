[CmdletBinding()]
param(
  [string]$Profile = "",
  [string]$Spec = "github:iuuuuuuuu/dsh-purge-plus#main",
  [switch]$Yes,
  [switch]$List
)

$ErrorActionPreference = "Stop"

function Say([string]$m) { Write-Host $m }
function Step([string]$m) { Write-Host ""; Write-Host "== $m" }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Say "需要 node（>=18）在 PATH 里"; exit 1 }
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) { Say "需要 dsh 在 PATH 里（官方 CLI 或桌面端生成的 shim）"; exit 1 }

$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$profilesDir = Join-Path $homeDir "profiles"

Say "dsh-purge 安装器"
Say "  DSH_HOME   $homeDir"

$profiles = @()
if (Test-Path $profilesDir) {
  $profiles = @(Get-ChildItem -Path $profilesDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName "package.json") } |
    Select-Object -ExpandProperty Name)
}

if ($List) {
  if ($profiles.Count -gt 0) { Say ("  profiles:  " + ($profiles -join " ")) } else { Say "  profiles:  （无）" }
  exit 0
}

$active = ""
$storeCandidates = @()
if ($env:APPDATA) { $storeCandidates += (Join-Path $env:APPDATA "dsh-tauri\.store.dat") }
if ($env:LOCALAPPDATA) { $storeCandidates += (Join-Path $env:LOCALAPPDATA "dsh-tauri\.store.dat") }
foreach ($f in $storeCandidates) {
  if (-not (Test-Path $f)) { continue }
  try {
    $store = Get-Content -Raw -Path $f | ConvertFrom-Json
    if ($store.setting -and $store.setting.active_profile) { $active = [string]$store.setting.active_profile; break }
  } catch { }
}

if (-not $Profile -and $env:DSH_PROFILE -and ($profiles -contains $env:DSH_PROFILE)) { $Profile = $env:DSH_PROFILE }
if (-not $Profile -and $active -and ($profiles -contains $active)) { $Profile = $active }
if (-not $Profile) {
  if ($profiles.Count -eq 0) { Say "找不到 profile（$profilesDir 为空）。先把宿主跑起来一次，或用 -Profile 指定。"; exit 1 }
  if ($profiles.Count -eq 1) {
    $Profile = $profiles[0]
  } else {
    Say ""
    Say "发现多个 profile，装哪个？"
    for ($i = 0; $i -lt $profiles.Count; $i++) { Say ("  " + ($i + 1) + ") " + $profiles[$i]) }
    $pick = Read-Host "输入序号 [1]"
    if ([string]::IsNullOrWhiteSpace($pick)) { $pick = "1" }
    $idx = 0
    if (-not [int]::TryParse($pick, [ref]$idx)) { Say "序号无效"; exit 2 }
    $idx = $idx - 1
    if ($idx -lt 0 -or $idx -ge $profiles.Count) { Say "序号无效"; exit 2 }
    $Profile = $profiles[$idx]
  }
}
Say "  profile    $Profile"
Say "  来源       $Spec"

Step "1/4 安装插件到 profile: $Profile"
& dsh plugin --profile $Profile add $Spec 2>&1 | Select-Object -Last 4
if ($LASTEXITCODE -ne 0) { Say "!! pnpm 安装失败（exit $LASTEXITCODE）"; exit 1 }

$pluginDir = Join-Path $profilesDir (Join-Path $Profile "node_modules\dsh-purge")
$pluginBin = Join-Path $pluginDir "bin\dsh-purge.js"
if (-not (Test-Path $pluginBin)) { Say "!! 装完没找到 $pluginBin"; exit 1 }
$pluginVersion = & node -p "require(String.raw`$pluginDir/package.json`).version"
Say "  插件版本   $pluginVersion"

Step "2/4 识别宿主与目录"
& node $pluginBin --status 2>&1 | Select-Object -First 9

$probeFile = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-purge-probe.mjs"
$probeCode = @'
import(process.argv[1]).then((m) => {
  const h = m.tauriHost();
  console.log(JSON.stringify(h ? { tauri: true, coreAsar: h.coreAsar, dir: Boolean(h.dirAiBase), depsRoot: h.depsRoot, dataDir: h.dataDir } : { tauri: false }));
}).catch(() => console.log(JSON.stringify({ tauri: false })));
'@
Set-Content -Path $probeFile -Value $probeCode -Encoding UTF8
$hostJson = (& node $probeFile (Join-Path $pluginDir "lib\tauri.js") | Select-Object -Last 1)
$hostInfo = $hostJson | ConvertFrom-Json
Say "  探测结果   $hostJson"

Step "3/4 社区桌面端（dsh-tauri）核心格式"
if ($hostInfo.tauri) {
  if ($hostInfo.coreAsar) {
    Say "  当前核心：密封 asar（归档内不可写，补丁打不上去）"
    if ($hostInfo.dir) { Say "  目录核心：已存在" } else { Say "  目录核心：尚未解包" }
    $answer = "n"
    if (-not $Yes) {
      $answer = Read-Host "  解包成目录核心并切换核心格式？(y/N)"
      if ([string]::IsNullOrWhiteSpace($answer)) { $answer = "n" }
    }
    if ($Yes -or $answer -match '^(y|yes)$') {
      & node $pluginBin --tauri-unpack --flip 2>&1 | Select-Object -Last 8
      Say "  ！已切换，必须重启 DSH Tauri 才会从目录核心加载"
    } else {
      Say "  跳过。以后可手动：node <plugin>/bin/dsh-purge.js --tauri-unpack --flip"
    }
  } else {
    Say "  当前核心：目录（可直接打补丁）"
  }
} else {
  Say "  不是 dsh-tauri 宿主，跳过（官方 web / 官方桌面按各自路径处理）"
}

Step "4/4 打补丁"
& node $pluginBin --apply 2>&1 | Select-Object -Last 6

Say ""
Say "完成。"
Say "  1) 重启宿主（社区桌面端必须手动重启；官方 web 重启 dsh web）"
Say "  2) 自检：node <plugin>/bin/dsh-purge.js --verify"
Say "  3) 多 profile 切换：node <plugin>/bin/dsh-purge.js --profiles"
