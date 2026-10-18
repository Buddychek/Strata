$root = 'd:\Strata-main\worktree'
$lines = Get-Content (Join-Path $root 'CMakeLists.txt')
# 0-based 1175..1189 = the edited block: comment, policy guard, Declare, GetProperties, Populate, endif
$g = $lines[1175..1189]
$cases = [ordered]@{
  guarded   = $g
  unguarded = ($g[0..3] + $g[7..14])   # drop the if(POLICY CMP0169)/cmake_policy/endif lines
}
foreach ($case in $cases.Keys) {
  $dir = Join-Path $root ".fctest2\$case"
  $src = Join-Path $dir 'src'
  New-Item -ItemType Directory -Force -Path $src, (Join-Path $dir 'build') | Out-Null
  $body = ($cases[$case] -join "`n")
  $header = @'
cmake_minimum_required(VERSION 3.24)
project(fc_snippet LANGUAGES NONE)
include(FetchContent)
'@
  $footer = @'

message(STATUS "populated: ${strata_llamacpp_POPULATED} src=${strata_llamacpp_SOURCE_DIR}")
'@
  Set-Content -Path (Join-Path $dir 'CMakeLists.txt') -Value ($header + "`n" + $body + $footer)
  $out = cmake -S $dir -B (Join-Path $dir 'build') "-DFETCHCONTENT_SOURCE_DIR_STRATA_LLAMACPP=$src" 2>&1 | Out-String
  $warn = if ($out -match 'deprecated') { 'WARNING PRESENT' } else { 'no warning' }
  Write-Host "== $case => $warn =="
  ($out -split "`n" | Where-Object { $psitem -match 'deprecat|populated:|Configuring done' }) | ForEach-Object { Write-Host $_ }
}
