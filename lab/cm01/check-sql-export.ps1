<#
.SYNOPSIS
    Lab check for extractor/Export-VWhereSchema.sql: runs the T-SQL export and the
    PowerShell export against the lab site database, then compares them.

.DESCRIPTION
    Both exporters only read names and types (plus inventory class definitions),
    so this changes nothing in the database. It writes schema-sql.json and
    schema-ps.json to the current folder. The two should describe the same schema;
    only the export time may differ.

    Uses the extractor files next to it in the repo, or downloads them from GitHub
    (-Branch) when run on its own.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\check-sql-export.ps1
    powershell -ExecutionPolicy Bypass -File .\check-sql-export.ps1 -Branch phase5-clm-export
#>
param(
    [string]$SqlServer = 'localhost',
    [string]$Database = 'CM_LAB',
    [string]$Branch = 'main'
)
$ErrorActionPreference = 'Stop'

# 1. Find (or download) the two exporters
$here = Join-Path $PSScriptRoot '..\..\extractor'
$sql = Join-Path $here 'Export-VWhereSchema.sql'
$ps1 = Join-Path $here 'Export-VWhereSchema.ps1'
if (-not (Test-Path $sql) -or -not (Test-Path $ps1)) {
    $base = "https://raw.githubusercontent.com/JBoogieman/v-where/$Branch/extractor"
    $sql = Join-Path (Get-Location) 'Export-VWhereSchema.sql'
    $ps1 = Join-Path (Get-Location) 'Export-VWhereSchema.ps1'
    foreach ($f in $sql, $ps1) {
        Invoke-WebRequest "$base/$(Split-Path $f -Leaf)" -OutFile $f -UseBasicParsing
    }
    "Downloaded the exporters from branch $Branch"
}

# 2. T-SQL export with sqlcmd (the command from the user guide)
$t = Get-Date
& sqlcmd -S $SqlServer -d $Database -E -I -b -h -1 -y 0 -f o:65001 -i $sql -o schema-sql.json
if ($LASTEXITCODE) {
    Get-Content schema-sql.json -TotalCount 15
    throw "sqlcmd failed with exit code $LASTEXITCODE (its messages are above)"
}
"T-SQL export:      {0:N0} bytes in {1:N1} s" -f (Get-Item schema-sql.json).Length, ((Get-Date) - $t).TotalSeconds

# 3. PowerShell export
$t = Get-Date
& $ps1 -SqlServer $SqlServer -Database $Database -OutFile schema-ps.json | Out-Null
"PowerShell export: {0:N0} bytes in {1:N1} s" -f (Get-Item schema-ps.json).Length, ((Get-Date) - $t).TotalSeconds

# 4. Compare: each object reduced to comparable strings (order-insensitive where order doesn't matter)
function Get-Shape($o) {
    $join = { param($rows) if ($rows) { (@($rows) | ForEach-Object { @($_) -join '|' }) -join ';' } else { '' } }
    [ordered]@{
        kind       = [string]$o.kind
        columns    = & $join $o.columns
        params     = & $join $o.params
        aliases    = if ($o.aliases) { (@($o.aliases) | Sort-Object) -join ';' } else { '' }
        baseView   = [string]$o.baseView
        hinv       = if ($o.hinv) { '{0}|{1}|{2}|{3}' -f $o.hinv.display, $o.hinv.class, $o.hinv.namespace, $o.hinv.collected } else { '' }
        offColumns = if ($o.offColumns) { (@($o.offColumns) | Sort-Object) -join ';' } else { '' }
    }
}
try {
    $a = Get-Content schema-ps.json -Raw -Encoding UTF8 | ConvertFrom-Json
} catch { throw "schema-ps.json isn't valid JSON: $_" }
try {
    $b = Get-Content schema-sql.json -Raw -Encoding UTF8 | ConvertFrom-Json
} catch { throw "schema-sql.json isn't valid JSON: $_" }

$diffs = 0
""
"{0,-16}{1,12}{2,12}" -f 'count', 'PowerShell', 'T-SQL'
foreach ($k in 'views', 'functions', 'columns', 'aliases', 'inventoryViews') {
    $va = $a.counts.$k; $vb = $b.counts.$k
    $mark = if ($va -ne $vb) { $diffs++; '   <- differs' } else { '' }
    "{0,-16}{1,12}{2,12}{3}" -f $k, $va, $vb, $mark
}

$sa = @{}; foreach ($o in $a.objects) { $sa[$o.name] = Get-Shape $o }
$sb = @{}; foreach ($o in $b.objects) { $sb[$o.name] = Get-Shape $o }
$onlyA = @($sa.Keys | Where-Object { -not $sb.ContainsKey($_) } | Sort-Object)
$onlyB = @($sb.Keys | Where-Object { -not $sa.ContainsKey($_) } | Sort-Object)
if ($onlyA.Count) { $diffs += $onlyA.Count; ""; "Only in the PowerShell export ($($onlyA.Count)): " + (($onlyA | Select-Object -First 20) -join ', ') }
if ($onlyB.Count) { $diffs += $onlyB.Count; ""; "Only in the T-SQL export ($($onlyB.Count)): " + (($onlyB | Select-Object -First 20) -join ', ') }

$changed = 0
foreach ($n in ($sa.Keys | Where-Object { $sb.ContainsKey($_) } | Sort-Object)) {
    $parts = @($sa[$n].Keys | Where-Object { $sa[$n][$_] -ne $sb[$n][$_] })
    if (-not $parts.Count) { continue }
    $changed++; $diffs++
    if ($changed -eq 1) { ""; "Different:" }
    if ($changed -le 15) {
        "  $n : $($parts -join ', ')"
        foreach ($p in $parts) {
            $x = [string]$sa[$n][$p]; $y = [string]$sb[$n][$p]
            "      PowerShell: " + $x.Substring(0, [Math]::Min(150, $x.Length))
            "      T-SQL:      " + $y.Substring(0, [Math]::Min(150, $y.Length))
        }
    }
}
if ($changed -gt 15) { "  ... and $($changed - 15) more" }

""
if ($diffs) { "$diffs difference(s)." } else { "Same schema. The T-SQL export matches the PowerShell one." }
