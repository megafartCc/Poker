param(
  [string]$BlueprintPath = "C:\out\Poker\data\cpp_fullgame_blueprint_v1.strategy.tsv",
  [string]$BucketsPath = "C:\out\PokerBot\data\blueprint_buckets_v1_200.json",
  [int]$Port = 8787,
  [int]$ThinkMs = 1000,
  [int]$EquityTrials = 1200,
  [double]$JsPriorBlend = 0.0
)

$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path "$PSScriptRoot\..")

if (!(Test-Path $BlueprintPath)) {
  throw "Missing C++ blueprint: $BlueprintPath"
}
if (!(Test-Path $BucketsPath)) {
  throw "Missing buckets: $BucketsPath"
}

$env:BLUEPRINT_PATH = $BlueprintPath
$env:BUCKETS_PATH = $BucketsPath
$env:PORT = "$Port"
$env:ENABLE_RT = "1"
$env:RT_MS = "$ThinkMs"
$env:EQUITY_TRIALS = "$EquityTrials"
$env:ENABLE_JS_POSTFLOP_PRIOR = "0"
$env:POSTFLOP_PRIOR_BLEND = "$JsPriorBlend"

Write-Host "[server-cpp] BLUEPRINT_PATH=$BlueprintPath"
Write-Host "[server-cpp] BUCKETS_PATH=$BucketsPath"
Write-Host "[server-cpp] PORT=$Port ENABLE_RT=1 RT_MS=$ThinkMs EQUITY_TRIALS=$EquityTrials"
Write-Host "[server-cpp] JS prior disabled"
Write-Host ""

node .\server_fullgame.cjs
