<#
.SYNOPSIS
    Exports the ConfigMgr site database's reporting views and fn_rbac_ functions
    (names, columns, data types) to JSON for v_Where.

.DESCRIPTION
    Read-only and schema-only. Queries SQL Server's system catalog
    (sys.objects, sys.columns, sys.types, sys.parameters). It never selects
    rows from any ConfigMgr table or view, so no device, user, or site data
    ends up in the output.

    Uses Windows authentication: run it as an account that can already read
    the site database (the same access you'd use for SSRS work).

    Output: one JSON object per line inside "objects", so git diffs stay readable
    when the schema changes between ConfigMgr versions.

.PARAMETER SqlServer
    SQL Server hosting the site database: host, host\instance, or host,port.

.PARAMETER Database
    Site database name, e.g. CM_ABC.

.PARAMETER OutFile
    Path for the JSON file. Default: .\schema.json

.EXAMPLE
    .\Export-VWhereSchema.ps1 -SqlServer CM01.lab.internal -Database CM_LAB -OutFile .\schema.json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SqlServer,
    [Parameter(Mandatory)][string]$Database,
    [string]$OutFile = '.\schema.json'
)
$ErrorActionPreference = 'Stop'

# Three result sets: columns, function parameters, SQL Server version.
$query = @'
SELECT o.name AS obj, o.type AS otype, c.name AS col, t.name AS dtype,
       c.max_length, c.precision, c.scale, c.is_nullable
FROM sys.objects o
JOIN sys.columns c ON c.object_id = o.object_id
JOIN sys.types   t ON t.user_type_id = c.user_type_id
WHERE o.schema_id = SCHEMA_ID('dbo')
  AND (   (o.type = 'V'         AND o.name LIKE 'v[_]%')
       OR (o.type IN ('IF','TF') AND o.name LIKE 'fn[_]rbac[_]%'))
ORDER BY o.name, c.column_id;

SELECT o.name AS obj, p.name AS param, t.name AS dtype
FROM sys.objects o
JOIN sys.parameters p ON p.object_id = o.object_id
JOIN sys.types      t ON t.user_type_id = p.user_type_id
WHERE o.schema_id = SCHEMA_ID('dbo')
  AND o.type IN ('IF','TF') AND o.name LIKE 'fn[_]rbac[_]%'
  AND p.parameter_id > 0
ORDER BY o.name, p.parameter_id;

SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64));
'@

# Turn sys.types info into the type you'd write in T-SQL: nvarchar(256), decimal(18,2), varchar(max)...
function Format-SqlType {
    param([string]$Type, [int]$Length, [int]$Precision, [int]$Scale)
    switch -Regex ($Type) {
        '^n(var)?char$'                  { if ($Length -eq -1) { return "$Type(max)" } return "$Type($([int]($Length / 2)))" }
        '^(var)?char$|^(var)?binary$'    { if ($Length -eq -1) { return "$Type(max)" } return "$Type($Length)" }
        '^(decimal|numeric)$'            { return "$Type($Precision,$Scale)" }
        default                          { return $Type }
    }
}

$connectionString = "Server=$SqlServer;Database=$Database;Integrated Security=True;Application Name=v_Where schema export"
$cn = New-Object System.Data.SqlClient.SqlConnection $connectionString
$cmd = $cn.CreateCommand()
$cmd.CommandText = $query
$cmd.CommandTimeout = 300
$ds = New-Object System.Data.DataSet
try {
    $cn.Open()
    [void](New-Object System.Data.SqlClient.SqlDataAdapter $cmd).Fill($ds)
} finally {
    $cn.Close()
}

# Group column rows into one object per view/function.
$objects = [ordered]@{}
foreach ($r in $ds.Tables[0].Rows) {
    if (-not $objects.Contains($r.obj)) {
        $objects[$r.obj] = [ordered]@{
            name    = $r.obj
            kind    = $(if ($r.otype.Trim() -eq 'V') { 'view' } else { 'function' })
            columns = New-Object System.Collections.ArrayList
        }
    }
    # Each column is a compact array: [name, type, nullable]
    $col = @($r.col, (Format-SqlType $r.dtype $r.max_length $r.precision $r.scale), [bool]$r.is_nullable)
    [void]$objects[$r.obj].columns.Add($col)
}

# Function parameters, e.g. fn_rbac_R_System(@UserSIDs varchar)
foreach ($r in $ds.Tables[1].Rows) {
    $o = $objects[$r.obj]
    if (-not $o) { continue }
    if (-not $o.Contains('params')) { $o.params = New-Object System.Collections.ArrayList }
    [void]$o.params.Add(@($r.param, $r.dtype))
}

# Link each fn_rbac_X to the view it wraps (v_X), when one exists.
foreach ($o in $objects.Values) {
    if ($o.kind -eq 'function') {
        $base = 'v_' + $o.name.Substring('fn_rbac_'.Length)
        if ($objects.Contains($base)) { $o.baseView = $base }
    }
}

$views     = @($objects.Values | Where-Object { $_.kind -eq 'view' }).Count
$functions = @($objects.Values | Where-Object { $_.kind -eq 'function' }).Count
$columns   = $ds.Tables[0].Rows.Count

$header = [ordered]@{
    schemaVersion = 1
    generatedUtc  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    sqlVersion    = [string]$ds.Tables[2].Rows[0][0]
    counts        = [ordered]@{ views = $views; functions = $functions; columns = $columns }
}

# One object per line keeps diffs readable.
$headerJson = ConvertTo-Json $header -Compress
$lines = foreach ($o in $objects.Values) { ConvertTo-Json $o -Compress -Depth 5 }
$json = $headerJson.Substring(0, $headerJson.Length - 1) + ',"objects":[' + "`n" + ($lines -join ",`n") + "`n]}`n"

$path = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
[IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding $false))

"Exported $views views, $functions fn_rbac_ functions, $columns columns -> $path"
