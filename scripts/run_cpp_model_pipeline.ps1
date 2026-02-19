param(
  [string]$CliPath = "C:\out\PokerBot\build\Release\pokerbot_cli.exe",
  [string]$BucketsPath = "C:\out\PokerBot\data\blueprint_buckets_v1_200.json",
  [string]$OutBlueprint = "C:\out\Poker\data\cpp_fullgame_blueprint_v1.strategy.tsv",
  [int]$Seats = 2,
  [int]$Iters = 12000,
  [int]$DepthLimit = 5,
  [int]$CheckpointEvery = 3000,
  [int]$Seed = 42,
  [int]$ThinkMs = 1000
)

$ErrorActionPreference = "Stop"

if (!(Test-Path $CliPath)) {
  throw "CLI not found: $CliPath"
}
if (!(Test-Path $BucketsPath)) {
  throw "Buckets not found: $BucketsPath"
}

Write-Host "[cpp-model] training fullgame blueprint..."
& $CliPath train-fullgame `
  --seats $Seats `
  --buckets $BucketsPath `
  --iters $Iters `
  --seed $Seed `
  --depth-limit $DepthLimit `
  --checkpoint-every $CheckpointEvery `
  --strategy-out $OutBlueprint

if (!(Test-Path $OutBlueprint)) {
  throw "Blueprint output missing: $OutBlueprint"
}

$outDecision = [System.IO.Path]::ChangeExtension($OutBlueprint, ".realtime_test.tsv")
Write-Host "[cpp-model] smoke test solve-realtime..."
& $CliPath solve-realtime `
  --seats $Seats `
  --hero-seat 0 `
  --street flop `
  --buckets $BucketsPath `
  --blueprint $OutBlueprint `
  --think-ms $ThinkMs `
  --depth-limit $DepthLimit `
  --seed 242 `
  --output $outDecision

Write-Host "[cpp-model] done."
Write-Host "  blueprint: $OutBlueprint"
Write-Host "  realtime test: $outDecision"
Write-Host ""
Write-Host "Use in server_fullgame.cjs:"
Write-Host "  setx BLUEPRINT_PATH `"$OutBlueprint`""
Write-Host "  setx ENABLE_RT `"1`""
