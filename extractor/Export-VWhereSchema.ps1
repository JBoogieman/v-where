<#
.SYNOPSIS
    Exports the ConfigMgr site database's reporting views and fn_rbac_ functions
    (names, columns, data types) to JSON for v_Where.

.DESCRIPTION
    Read-only. Never reads device, user, or inventory data.

    1. Schema: SQL Server's system catalog (sys.objects, sys.columns, sys.types,
       sys.parameters, sys.synonyms). Names and types only.
    2. Hardware inventory class definitions (skip with -SchemaOnly): site
       configuration from v_GroupMap, v_InventoryClass, v_InventoryClassProperty
       and v_InventoryReportClass. For each v_GS_/v_HS_ view it records the WMI
       class behind it and whether Default Client Settings collects that class.
       A class that isn't collected still has a view; it's just empty.

    Uses Windows authentication: run it as an account that can already read
    the site database (the same access you'd use for SSRS work).

    Output: one JSON object per line inside "objects", so git diffs stay readable
    when the schema changes between ConfigMgr versions.

    Run it on a settled site. A brand-new site keeps creating inventory views
    for up to an hour after setup finishes.

.PARAMETER SqlServer
    SQL Server hosting the site database: host, host\instance, or host,port.

.PARAMETER Database
    Site database name, e.g. CM_ABC.

.PARAMETER OutFile
    Path for the JSON file. Default: .\schema.json

.PARAMETER SchemaOnly
    Skip step 2 and read nothing but the system catalog.

.EXAMPLE
    .\Export-VWhereSchema.ps1 -SqlServer CM01.lab.internal -Database CM_LAB -OutFile .\schema.json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SqlServer,
    [Parameter(Mandatory)][string]$Database,
    [string]$OutFile = '.\schema.json',
    [switch]$SchemaOnly
)
$ErrorActionPreference = 'Stop'

# Four result sets: columns, function parameters, synonyms, SQL Server version.
$schemaQuery = @'
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

-- Old short names ConfigMgr keeps for long view names (e.g. v_GS_ADVANCED_CLIENT_SSL_CONF).
SELECT s.name AS alias, PARSENAME(s.base_object_name, 1) AS target
FROM sys.synonyms s
WHERE s.schema_id = SCHEMA_ID('dbo') AND (s.name LIKE 'v[_]%' OR s.name LIKE 'fn[_]rbac[_]%')
ORDER BY s.name;

SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64));
'@

# Two result sets: one row per inventory class, then the properties Default
# Client Settings leaves out of classes it does collect.
# {00000000-0000-0000-0000-000000000001} is Default Client Settings' inventory report.
$hinvQuery = @'
DECLARE @dcs nvarchar(64) = N'{00000000-0000-0000-0000-000000000001}';

SELECT g.InvClassName AS gsView, g.InvHistoryClassName AS hsView, g.DisplayName AS display,
       ic.ClassName AS wmiClass, ic.Namespace AS wmiNamespace,
       CAST(CASE WHEN EXISTS (SELECT 1 FROM v_InventoryReportClass rc
                              WHERE rc.InventoryReportID = @dcs AND rc.SMSClassID = g.MIFClass)
                 THEN 1 ELSE 0 END AS bit) AS collected
FROM v_GroupMap g
LEFT JOIN v_InventoryClass ic ON ic.SMSClassID = g.MIFClass
WHERE g.InvClassName IS NOT NULL;

SELECT g.InvClassName AS gsView, p.PropertyName AS prop
FROM v_GroupMap g
JOIN v_InventoryClassProperty p ON p.SMSClassID = g.MIFClass
WHERE EXISTS     (SELECT 1 FROM v_InventoryReportClass rc
                  WHERE rc.InventoryReportID = @dcs AND rc.SMSClassID = g.MIFClass)
  AND NOT EXISTS (SELECT 1 FROM v_InventoryReportClass rc
                  WHERE rc.InventoryReportID = @dcs AND rc.SMSClassID = g.MIFClass
                    AND rc.PropertyName = p.PropertyName)
ORDER BY g.InvClassName, p.PropertyName;
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

function Invoke-Query([string]$Sql) {
    $cn = New-Object System.Data.SqlClient.SqlConnection "Server=$SqlServer;Database=$Database;Integrated Security=True;Application Name=v_Where schema export"
    $cmd = $cn.CreateCommand()
    $cmd.CommandText = $Sql
    $cmd.CommandTimeout = 300
    $ds = New-Object System.Data.DataSet
    try {
        $cn.Open()
        [void](New-Object System.Data.SqlClient.SqlDataAdapter $cmd).Fill($ds)
    } finally {
        $cn.Close()
    }
    return ,$ds
}

$ds = Invoke-Query $schemaQuery

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

# Synonyms become aliases on the object they point to.
$aliasCount = 0
foreach ($r in $ds.Tables[2].Rows) {
    $o = $objects[$r.target]
    if (-not $o) { continue }
    if (-not $o.Contains('aliases')) { $o.aliases = New-Object System.Collections.ArrayList }
    [void]$o.aliases.Add($r.alias)
    $aliasCount++
}

# Link each fn_rbac_X to the view it wraps (v_X), when one exists.
foreach ($o in $objects.Values) {
    if ($o.kind -eq 'function') {
        $base = 'v_' + $o.name.Substring('fn_rbac_'.Length)
        if ($objects.Contains($base)) { $o.baseView = $base }
    }
}

# Hardware inventory classes: which WMI class feeds each v_GS_/v_HS_ view, and
# whether Default Client Settings collects it.
$hinvCount = 0
if (-not $SchemaOnly) {
    try {
        $hds = Invoke-Query $hinvQuery
        $off = @{}
        foreach ($r in $hds.Tables[1].Rows) {
            if (-not $off.ContainsKey($r.gsView)) { $off[$r.gsView] = New-Object System.Collections.ArrayList }
            [void]$off[$r.gsView].Add([string]$r.prop + '0')    # view columns are the property name + 0
        }
        foreach ($r in $hds.Tables[0].Rows) {
            $info = [ordered]@{ display = [string]$r.display }
            if ($r.wmiClass -isnot [DBNull]) {
                $info.class     = [string]$r.wmiClass
                # Stored MOF-escaped: \\\\.\\root\\cimv2 -> \\.\root\cimv2 -> root\cimv2
                $info.namespace = ([string]$r.wmiNamespace).Replace('\\', '\') -replace '^\\\\\.\\', ''
            }
            $info.collected = [bool]$r.collected
            foreach ($viewName in @($r.gsView, $r.hsView)) {
                if ($viewName -is [DBNull] -or -not $objects.Contains($viewName)) { continue }
                $o = $objects[$viewName]
                $o.hinv = $info
                if ($off.ContainsKey($r.gsView)) {
                    # Only list columns that exist in this view.
                    $have = @{}; foreach ($c in $o.columns) { $have[$c[0]] = 1 }
                    $cols = @($off[$r.gsView] | Where-Object { $have.ContainsKey($_) })
                    if ($cols.Count) { $o.offColumns = $cols }
                }
                $hinvCount++
            }
        }
    } catch {
        Write-Warning "Skipped hardware inventory class info: $($_.Exception.Message)"
    }
}

$views     = @($objects.Values | Where-Object { $_.kind -eq 'view' }).Count
$functions = @($objects.Values | Where-Object { $_.kind -eq 'function' }).Count
$columns   = $ds.Tables[0].Rows.Count

$header = [ordered]@{
    schemaVersion = 2
    generatedUtc  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    sqlVersion    = [string]$ds.Tables[3].Rows[0][0]
    counts        = [ordered]@{ views = $views; functions = $functions; columns = $columns; aliases = $aliasCount; inventoryViews = $hinvCount }
}

# One object per line keeps diffs readable.
$headerJson = ConvertTo-Json $header -Compress
$lines = foreach ($o in $objects.Values) { ConvertTo-Json $o -Compress -Depth 5 }
$json = $headerJson.Substring(0, $headerJson.Length - 1) + ',"objects":[' + "`n" + ($lines -join ",`n") + "`n]}`n"

$path = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
[IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding $false))

"Exported $views views, $functions fn_rbac_ functions, $columns columns, $aliasCount aliases, $hinvCount inventory views -> $path"
