# Collab bundle 源码同步脚本
# 背景：pnpm 的 file: 依赖是【复制】不是【链接】——改了 collab-bundle/ 源码后，
# profile 的 node_modules 副本不会自动更新，重启加载的永远是旧代码（已踩坑两次）。
# 用法：powershell -ExecutionPolicy Bypass -File collab/sync-bundle.ps1
$ErrorActionPreference = 'Stop'

$profileDir = 'C:\Users\丧彪\.dsh\profiles\web'
$pkg = Join-Path $profileDir 'node_modules\dsh-collab-bundle'

if (Test-Path $pkg) {
  Remove-Item $pkg -Recurse -Force
  Write-Host '[1/3] 旧副本已删除'
} else {
  Write-Host '[1/3] 无旧副本，跳过删除'
}

Push-Location $profileDir
try {
  Write-Host '[2/3] pnpm install 重新复制副本...'
  pnpm install 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败: $LASTEXITCODE" }
} finally {
  Pop-Location
}

Write-Host '[3/3] 验证副本...'
node --input-type=module -e "const m = await import('dsh-collab-bundle'); console.log('exports:', Object.keys(m).join(', ')); console.log('name:', m.name)" --input-type=module
if ($LASTEXITCODE -ne 0) { throw '副本验证失败' }

Write-Host '✅ 同步完成。重启 DSH 后新代码生效。'
