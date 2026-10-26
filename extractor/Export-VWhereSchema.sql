/*
  v_Where schema export, T-SQL only (no PowerShell)

  Same output as Export-VWhereSchema.ps1, for machines where PowerShell runs in
  Constrained Language Mode. Nothing here is PowerShell, so CLM doesn't apply:
  sqlcmd runs the query and writes schema.json.

  Read-only. Reads names and types from SQL Server's system catalog and, unless
  @SchemaOnly = 1, the hardware inventory class definitions (v_GroupMap,
  v_InventoryClass, v_InventoryClassProperty, v_InventoryReportClass). Never
  reads device, user or inventory data. Writes only to its own #temp tables.

  Run it with sqlcmd, as an account that can already read the site database:

    sqlcmd -S <sql-server> -d CM_<site code> -E -I -b -f o:65001 -i Export-VWhereSchema.sql -o schema.json

    -E          Windows authentication
    -I          QUOTED_IDENTIFIER on (the XML string building below needs it)
    -b          stop with an error code if anything fails
    -f o:65001  write UTF-8

  The XML ON line below makes sqlcmd write the JSON without a column header,
  padding or truncation. It still starts a new line every 2,000 or so characters,
  even mid-word; v_Where's tools ignore line breaks when they read the file, so
  that's fine. Use sqlcmd rather than SSMS, which cuts long results off.
*/
:XML ON
SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;

DECLARE @SchemaOnly bit = 0;   -- 1 = names and types only: skip the hardware inventory class info

-- Views (v_) and permission-filtered functions (fn_rbac_)
SELECT o.object_id, o.name,
       CAST(CASE WHEN o.type = 'V' THEN 'view' ELSE 'function' END AS varchar(8)) AS kind
INTO #obj
FROM sys.objects o
WHERE o.schema_id = SCHEMA_ID('dbo')
  AND (   (o.type = 'V'          AND o.name LIKE 'v[_]%')
       OR (o.type IN ('IF', 'TF') AND o.name LIKE 'fn[_]rbac[_]%'))
  AND EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id = o.object_id);

-- Columns, with the type as you'd write it in T-SQL: nvarchar(256), decimal(18,2), varchar(max)...
SELECT c.object_id, c.column_id, c.name, c.is_nullable,
       CAST(CASE
         WHEN t.name IN ('nchar', 'nvarchar')
           THEN t.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
         WHEN t.name IN ('char', 'varchar', 'binary', 'varbinary')
           THEN t.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
         WHEN t.name IN ('decimal', 'numeric')
           THEN t.name + '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')'
         ELSE t.name END AS nvarchar(300)) AS dtype
INTO #col
FROM #obj o
JOIN sys.columns c ON c.object_id = o.object_id
JOIN sys.types   t ON t.user_type_id = c.user_type_id;

-- Function parameters, e.g. fn_rbac_R_System(@UserSIDs)
SELECT p.object_id, p.parameter_id, p.name, t.name AS dtype
INTO #par
FROM #obj o
JOIN sys.parameters p ON p.object_id = o.object_id AND p.parameter_id > 0
JOIN sys.types      t ON t.user_type_id = p.user_type_id
WHERE o.kind = 'function';

-- Old short names ConfigMgr keeps for long view names become aliases
SELECT s.name AS alias, PARSENAME(s.base_object_name, 1) AS target
INTO #syn
FROM sys.synonyms s
WHERE s.schema_id = SCHEMA_ID('dbo') AND (s.name LIKE 'v[_]%' OR s.name LIKE 'fn[_]rbac[_]%')
  AND PARSENAME(s.base_object_name, 1) IN (SELECT name FROM #obj);

-- Hardware inventory: the WMI class behind each v_GS_/v_HS_ view, whether Default Client
-- Settings collects it, and the properties it leaves out of classes it does collect.
-- {00000000-0000-0000-0000-000000000001} is Default Client Settings' inventory report.
CREATE TABLE #hinv (viewName sysname COLLATE DATABASE_DEFAULT, gsView sysname COLLATE DATABASE_DEFAULT,
                    display nvarchar(512) COLLATE DATABASE_DEFAULT, wmiClass nvarchar(512) COLLATE DATABASE_DEFAULT NULL,
                    wmiNamespace nvarchar(1024) COLLATE DATABASE_DEFAULT NULL, collected bit);
CREATE TABLE #off (gsView sysname COLLATE DATABASE_DEFAULT, col sysname COLLATE DATABASE_DEFAULT);

IF @SchemaOnly = 0 AND OBJECT_ID('dbo.v_GroupMap') IS NOT NULL
BEGIN TRY
  -- Dynamic SQL, so a database without these views still exports names and types
  EXEC sp_executesql N'
    DECLARE @dcs nvarchar(64) = N''{00000000-0000-0000-0000-000000000001}'';
    WITH g AS (
      SELECT g.InvClassName AS gsView, g.InvHistoryClassName AS hsView, g.DisplayName AS display,
             ic.ClassName AS wmiClass, ic.Namespace AS wmiNamespace,
             CASE WHEN EXISTS (SELECT 1 FROM v_InventoryReportClass rc
                               WHERE rc.InventoryReportID = @dcs AND rc.SMSClassID = g.MIFClass)
                  THEN 1 ELSE 0 END AS collected
      FROM v_GroupMap g
      LEFT JOIN v_InventoryClass ic ON ic.SMSClassID = g.MIFClass
      WHERE g.InvClassName IS NOT NULL),
    v AS (
      SELECT x.viewName, g.*, ROW_NUMBER() OVER (PARTITION BY x.viewName ORDER BY g.collected DESC) AS n
      FROM g CROSS APPLY (VALUES (g.gsView), (g.hsView)) x(viewName)
      WHERE x.viewName IN (SELECT name FROM #obj))
    INSERT INTO #hinv (viewName, gsView, display, wmiClass, wmiNamespace, collected)
    SELECT viewName, gsView, ISNULL(display, N''''), wmiClass, wmiNamespace, collected FROM v WHERE n = 1;

    INSERT INTO #off (gsView, col)
    SELECT DISTINCT g.InvClassName, p.PropertyName + N''0''        -- view columns are the property name + 0
    FROM v_GroupMap g
    JOIN v_InventoryClassProperty p ON p.SMSClassID = g.MIFClass
    WHERE g.InvClassName IS NOT NULL
      AND EXISTS     (SELECT 1 FROM v_InventoryReportClass rc
                      WHERE rc.InventoryReportID = @dcs AND rc.SMSClassID = g.MIFClass)
      AND NOT EXISTS (SELECT 1 FROM v_InventoryReportClass rc
                      WHERE rc.InventoryReportID = @dcs AND rc.SMSClassID = g.MIFClass
                        AND rc.PropertyName = p.PropertyName);';
END TRY
BEGIN CATCH
  -- Leave the inventory info out; counts.inventoryViews = 0 in the output shows it was skipped
  DELETE FROM #hinv; DELETE FROM #off;
END CATCH;

-- Counts for the header
DECLARE @views int, @functions int, @columns int, @aliases int, @inventoryViews int;
SELECT @views = SUM(CASE WHEN kind = 'view' THEN 1 ELSE 0 END),
       @functions = SUM(CASE WHEN kind = 'function' THEN 1 ELSE 0 END) FROM #obj;
SELECT @columns = COUNT(*) FROM #col;
SELECT @aliases = COUNT(*) FROM #syn;
SELECT @inventoryViews = COUNT(*) FROM #hinv;

-- All objects, one per line, sorted by name
DECLARE @objects nvarchar(max) = (
  SELECT CASE WHEN x.n = 1 THEN N'' ELSE N',' + NCHAR(10) END + x.line
  FROM (
    SELECT ROW_NUMBER() OVER (ORDER BY o.name) AS n,
         N'{"name":"' + STRING_ESCAPE(o.name, 'json') + N'","kind":"' + o.kind + N'"'
         -- columns: [name, type, nullable]
         + N',"columns":[' + STUFF((
             SELECT N',["' + STRING_ESCAPE(c.name, 'json') + N'","' + STRING_ESCAPE(c.dtype, 'json') + N'",'
                  + CASE WHEN c.is_nullable = 1 THEN N'true' ELSE N'false' END + N']'
             FROM #col c WHERE c.object_id = o.object_id ORDER BY c.column_id
             FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, N'') + N']'
         -- params: [name, type]
         + ISNULL(N',"params":[' + STUFF((
             SELECT N',["' + STRING_ESCAPE(p.name, 'json') + N'","' + STRING_ESCAPE(p.dtype, 'json') + N'"]'
             FROM #par p WHERE p.object_id = o.object_id ORDER BY p.parameter_id
             FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, N'') + N']', N'')
         + ISNULL(N',"aliases":[' + STUFF((
             SELECT N',"' + STRING_ESCAPE(s.alias, 'json') + N'"'
             FROM #syn s WHERE s.target = o.name ORDER BY s.alias
             FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, N'') + N']', N'')
         -- fn_rbac_X wraps v_X
         + CASE WHEN o.kind = 'function' AND b.name IS NOT NULL THEN N',"baseView":"' + STRING_ESCAPE(b.name, 'json') + N'"' ELSE N'' END
         -- hardware inventory class; the namespace is stored MOF-escaped: \\\\.\\root\\cimv2 -> root\cimv2
         + ISNULL(N',"hinv":{"display":"' + STRING_ESCAPE(h.display, 'json') + N'"'
             + ISNULL(N',"class":"' + STRING_ESCAPE(h.wmiClass, 'json') + N'","namespace":"' + STRING_ESCAPE(ns.v, 'json') + N'"', N'')
             + N',"collected":' + CASE WHEN h.collected = 1 THEN N'true' ELSE N'false' END + N'}', N'')
         + ISNULL(N',"offColumns":[' + STUFF((
             SELECT N',"' + STRING_ESCAPE(f.col, 'json') + N'"'
             FROM #off f
             WHERE f.gsView = h.gsView AND EXISTS (SELECT 1 FROM #col c WHERE c.object_id = o.object_id AND c.name = f.col)
             ORDER BY f.col
             FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, N'') + N']', N'')
         + N'}' AS line
  FROM #obj o
    LEFT JOIN #obj b ON o.kind = 'function' AND b.kind = 'view' AND b.name = N'v_' + SUBSTRING(o.name, 9, 256)
    LEFT JOIN #hinv h ON h.viewName = o.name
    OUTER APPLY (SELECT REPLACE(ISNULL(h.wmiNamespace, N''), N'\\', N'\') AS r) r
    OUTER APPLY (SELECT CASE WHEN LEFT(r.r, 4) = N'\\.\' THEN SUBSTRING(r.r, 5, 1024) ELSE r.r END AS v) ns
  
  ) x
  ORDER BY x.n
  FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)');

-- The file: header fields, counts, then the objects. JSON_QUERY passes the objects through as-is
-- (and fails loudly if they aren't valid JSON).
SELECT 2 AS schemaVersion,
       LEFT(CONVERT(varchar(30), SYSUTCDATETIME(), 126), 19) + 'Z' AS generatedUtc,
       CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS sqlVersion,
       @views AS [counts.views], @functions AS [counts.functions], @columns AS [counts.columns],
       @aliases AS [counts.aliases], @inventoryViews AS [counts.inventoryViews],
       JSON_QUERY(N'[' + NCHAR(10) + @objects + NCHAR(10) + N']') AS objects
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
