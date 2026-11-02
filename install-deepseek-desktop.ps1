# Connect DeepSeek Harness Desktop on Windows to a remote llm-wiki workspace.
#
# Harness Desktop manages its own profile and refuses `dsh plugin`, so the two
# plugins are installed from the app, from the .tgz files beside this script.
# No Node.js install is needed: the Node shipped inside Harness runs the setup.
# Run this from Windows, never from WSL: the workspace must point at Windows paths.
#
# Usage: powershell -ExecutionPolicy Bypass -File .\install-deepseek-desktop.ps1

$ErrorActionPreference = 'Stop'

$profileName = 'desktop'

function Find-Tarball($pattern) {
  $found = Get-ChildItem -LiteralPath $PSScriptRoot -Filter $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) {
    throw "Missing $pattern beside this script ($PSScriptRoot)."
  }
  return $found.FullName
}

function Find-Node {
  if ($env:LLM_WIKI_NODE) {
    return $env:LLM_WIKI_NODE
  }
  $installs = @(Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match 'harness' -and $_.Path } |
    ForEach-Object { Split-Path -Parent $_.Path })
  $roots = @($env:LOCALAPPDATA, "$env:LOCALAPPDATA\Programs", $env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
  foreach ($root in $roots) {
    $installs += @(Get-ChildItem -Path (Join-Path $root '*') -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'harness|deepseek' } |
      ForEach-Object { $_.FullName })
  }
  foreach ($install in ($installs | Select-Object -Unique)) {
    $bundled = Get-ChildItem -LiteralPath (Join-Path $install 'resources\runtime\primary-runtime\dependencies\node') -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($bundled) {
      return $bundled.FullName
    }
  }
  $system = Get-Command node -ErrorAction SilentlyContinue
  if ($system) {
    return $system.Source
  }
  throw 'Could not find the Node shipped with Harness. Open Harness and run this again, or set LLM_WIKI_NODE to the full path of node.exe under resources\runtime\primary-runtime\dependencies\node in the Harness install folder.'
}

$pluginTarball = Find-Tarball 'dotdrelle-dsh-llm-wiki-*.tgz'
$loaderTarball = Find-Tarball 'momojie-s-dsh-workspace-mcp-*.tgz'

$nodeBin = Find-Node
$nodeVersion = (& $nodeBin --version).Trim()
Write-Host "Using Node $nodeVersion ($nodeBin)"
if ([int]($nodeVersion -replace '^v?(\d+).*$', '$1') -lt 24) {
  throw "Node.js 24 or newer is required by the per-workspace MCP loader; found $nodeVersion."
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$modules = Join-Path $dshHome "profiles\$profileName\node_modules"
$helper = Join-Path $modules '@dotdrelle\dsh-llm-wiki\workspace.mjs'
$loader = Join-Path $modules '@momojie-s\dsh-workspace-mcp\lib\index.js'

function Wait-ForPlugin($path, $target, $label) {
  while (-not (Test-Path -LiteralPath $path)) {
    Write-Host ''
    Write-Host "Install the $label in Harness Desktop:"
    Write-Host '  Plugins > Add plugin > Install a third-party plugin'
    Write-Host "  $target"
    Write-Host 'Choose Install, then Enable now.'
    Read-Host 'Press Enter when it is installed'
    if (-not (Test-Path -LiteralPath $path)) {
      Write-Host "Not found yet: $path"
    }
  }
  Write-Host "Found the $label."
}

Wait-ForPlugin $helper $pluginTarball 'llm-wiki plugin'
Wait-ForPlugin $loader $loaderTarball 'per-workspace MCP loader'

Write-Host ''
Write-Host 'Creating a local Harness workspace connected to the remote wiki...'
Write-Host 'On a local network, the URLs may use http://192.168.x.x. Tokens then travel unencrypted.'
$env:LLM_WIKI_DSH_PROFILE = $profileName
# The installed package is a link: without this flag the helper does not see
# itself as the main module and exits without doing anything.
& $nodeBin --preserve-symlinks-main $helper setup
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host ''
Write-Host 'Restart Harness Desktop, add the printed folder with Add workspace, and open a conversation in it.'
