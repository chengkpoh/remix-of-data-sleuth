/**
 * ERP Search Engine — black-box wrapper.
 *
 * The T-SQL body in CORE_SQL_BODY is the user's tested ERP search script.
 * It is reproduced verbatim from the original; only the leading
 * DECLARE / SET block (which hard-coded @SearchStrColumnValue, @SearchStrTableName,
 * @SearchStrColumnName, @SearchStrInXML, @FullRowResult, @FullRowResultRows)
 * has been removed so those variables can be driven by bound parameters
 * passed in from the Node wrapper. No scanning logic has been modified.
 *
 * Multi-table selection, column-type filtering, result capping, progress
 * reporting, and cancellation are implemented in the Node wrapper around
 * the engine — not inside the SQL.
 */

// ---------------------------------------------------------------------------
// Core engine body — VERBATIM from the user's tested script (after the
// initial DECLARE / SET assignments that we now bind as parameters).
// DO NOT MODIFY the SQL below.
// ---------------------------------------------------------------------------
const CORE_SQL_BODY = `
IF OBJECT_ID('tempdb..#Results') IS NOT NULL DROP TABLE #Results
CREATE TABLE #Results (TableName nvarchar(128), ColumnName nvarchar(128), ColumnValue nvarchar(max),ColumnType nvarchar(20))

SET NOCOUNT ON

DECLARE @TableName nvarchar(256) = '',@ColumnName nvarchar(128),@ColumnType nvarchar(20), @QuotedSearchStrColumnValue nvarchar(110), @QuotedSearchStrColumnName nvarchar(110)
SET @QuotedSearchStrColumnValue = QUOTENAME(@SearchStrColumnValue,'''')
DECLARE @ColumnNameTable TABLE (COLUMN_NAME nvarchar(128),DATA_TYPE nvarchar(20))

WHILE @TableName IS NOT NULL
BEGIN
    SET @TableName =
    (
        SELECT MIN(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME))
        FROM    INFORMATION_SCHEMA.TABLES
        WHERE       TABLE_TYPE = 'BASE TABLE'
            AND TABLE_NAME LIKE COALESCE(@SearchStrTableName,TABLE_NAME)
            AND QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME) > @TableName
            AND OBJECTPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)), 'IsMSShipped') = 0
    )
    IF @TableName IS NOT NULL
    BEGIN
        DECLARE @sql VARCHAR(MAX)
        SET @sql = 'SELECT QUOTENAME(COLUMN_NAME),DATA_TYPE
                FROM    INFORMATION_SCHEMA.COLUMNS
                WHERE       TABLE_SCHEMA    = PARSENAME(''' + @TableName + ''', 2)
                AND TABLE_NAME  = PARSENAME(''' + @TableName + ''', 1)
                AND DATA_TYPE IN (' + CASE WHEN ISNUMERIC(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(@SearchStrColumnValue,'%',''),'_',''),'[',''),']',''),'-','')) = 1 THEN '''tinyint'',''int'',''smallint'',''bigint'',''numeric'',''decimal'',''smallmoney'',''money'',' ELSE '' END + '''char'',''varchar'',''nchar'',''nvarchar'',''timestamp'',''uniqueidentifier''' + CASE @SearchStrInXML WHEN 1 THEN ',''xml''' ELSE '' END + ')
                AND COLUMN_NAME LIKE COALESCE(' + CASE WHEN @SearchStrColumnName IS NULL THEN 'NULL' ELSE '''' + @SearchStrColumnName + '''' END  + ',COLUMN_NAME)'
        INSERT INTO @ColumnNameTable
        EXEC (@sql)
        WHILE EXISTS (SELECT TOP 1 COLUMN_NAME FROM @ColumnNameTable)
        BEGIN
            PRINT @ColumnName
            SELECT TOP 1 @ColumnName = COLUMN_NAME,@ColumnType = DATA_TYPE FROM @ColumnNameTable
            SET @sql = 'SELECT ''' + @TableName + ''',''' + @ColumnName + ''',' + CASE @ColumnType WHEN 'xml' THEN 'LEFT(CAST(' + @ColumnName + ' AS nvarchar(MAX)), 4096),'''
            WHEN 'timestamp' THEN 'master.dbo.fn_varbintohexstr('+ @ColumnName + '),'''
            ELSE 'LEFT(' + @ColumnName + ', 4096),''' END + @ColumnType + '''
                    FROM ' + @TableName + ' (NOLOCK) ' +
                    ' WHERE ' + CASE @ColumnType WHEN 'xml' THEN 'CAST(' + @ColumnName + ' AS nvarchar(MAX))'
                    WHEN 'timestamp' THEN 'master.dbo.fn_varbintohexstr('+ @ColumnName + ')'
                    ELSE @ColumnName END + ' LIKE ' + @QuotedSearchStrColumnValue
            INSERT INTO #Results
            EXEC(@sql)
            IF @@ROWCOUNT > 0 IF @FullRowResult = 1
            BEGIN
                SET @sql = 'SELECT TOP ' + CAST(@FullRowResultRows AS VARCHAR(3)) + ' ''' + @TableName + ''' AS [TableFound],''' + @ColumnName + ''' AS [ColumnFound],''FullRow>'' AS [FullRow>],*' +
                    ' FROM ' + @TableName + ' (NOLOCK) ' +
                    ' WHERE ' + CASE @ColumnType WHEN 'xml' THEN 'CAST(' + @ColumnName + ' AS nvarchar(MAX))'
                    WHEN 'timestamp' THEN 'master.dbo.fn_varbintohexstr('+ @ColumnName + ')'
                    ELSE @ColumnName END + ' LIKE ' + @QuotedSearchStrColumnValue
                EXEC(@sql)
            END
            DELETE FROM @ColumnNameTable WHERE COLUMN_NAME = @ColumnName
        END
    END
END
SET NOCOUNT OFF

SELECT TableName, ColumnName, ColumnValue, ColumnType, COUNT(*) AS Count FROM #Results
GROUP BY TableName, ColumnName, ColumnValue, ColumnType
`;

/**
 * Build the LIKE pattern from a raw search value + UI mode.
 * LIKE wildcards inside the user's value are escaped so they are matched literally.
 */
function buildLikePattern(value, mode) {
  const escaped = String(value)
    .replace(/\[/g, "[[]")
    .replace(/%/g, "[%]")
    .replace(/_/g, "[_]");
  switch (mode) {
    case "exact":
    case "exactMatch":
      return escaped;
    case "starts":
    case "startsWith":
      return `${escaped}%`;
    case "contains":
    default:
      return `%${escaped}%`;
  }
}

/**
 * Run the engine ONCE with a given @SearchStrTableName value.
 * Returns recordset rows: { TableName, ColumnName, ColumnValue, ColumnType, Count }
 */
async function runEngineOnce({ pool, likePattern, tableNamePattern, signal }) {
  const req = pool.request();
  req.input("SearchStrColumnValue", likePattern);
  // @SearchStrTableName accepts NULL (= all tables) or a LIKE pattern / exact name.
  req.input("SearchStrTableName", tableNamePattern ?? null);

  // Prepend parameter-bound DECLAREs that replace the original hard-coded SETs.
  // The body is UNCHANGED — it still reads @SearchStrColumnValue, @SearchStrTableName,
  // @SearchStrColumnName, @SearchStrInXML, @FullRowResult, @FullRowResultRows.
  const sqlText = `
    DECLARE @SearchStrColumnName nvarchar(255) = NULL;
    DECLARE @SearchStrInXML bit = 0;
    DECLARE @FullRowResult bit = 0;
    DECLARE @FullRowResultRows int = 0;
    ${CORE_SQL_BODY}
  `;

  // Cancellation: if the abort signal fires mid-query, cancel the active request.
  const onAbort = () => { try { req.cancel(); } catch (_) {} };
  if (signal) {
    if (signal.aborted) { try { req.cancel(); } catch (_) {} }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const res = await req.query(sqlText);
    // mssql returns the LAST result set in .recordset; the engine's final
    // SELECT is the grouped #Results projection.
    return Array.isArray(res.recordsets) && res.recordsets.length
      ? res.recordsets[res.recordsets.length - 1]
      : (res.recordset || []);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Public entry point used by the IPC handler.
 *
 * @param {object}  opts
 * @param {import('mssql').ConnectionPool} opts.pool
 * @param {string}  opts.searchValue
 * @param {string[]|null} opts.selectedTables   null = all tables; array of table names = only these
 * @param {string[]|null} opts.selectedColumnTypes null = all supported types
 * @param {"contains"|"starts"|"exact"} opts.searchMode
 * @param {number}  opts.maxResult
 * @param {(p:{scanned:number,total:number,currentTable:string,warning?:string})=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ results: {tableName:string,columnName:string,foundValue:string,columnType:string,count:number}[], scanned:number, total:number, aborted:boolean }>}
 */
async function runSearch(opts) {
  const {
    pool,
    searchValue,
    selectedTables,
    selectedColumnTypes,
    searchMode = "contains",
    maxResult = 50,
    onProgress,
    signal,
  } = opts;

  if (!pool) throw new Error("Not connected");
  if (!searchValue || !String(searchValue).length) {
    return { results: [], scanned: 0, total: 0, aborted: false };
  }

  const likePattern = buildLikePattern(searchValue, searchMode);
  const typeFilter = (selectedColumnTypes && selectedColumnTypes.length)
    ? new Set(selectedColumnTypes.map((t) => String(t).toLowerCase()))
    : null;

  // Run the engine once per selected table (so each call binds @SearchStrTableName
  // to that table's exact name). If no selection, run once with NULL (= all tables).
  const targets = (selectedTables && selectedTables.length)
    ? selectedTables.map((t) => (typeof t === "string" ? t : t.name))
    : [null];

  const results = [];
  const total = targets.length;
  let scanned = 0;
  let aborted = false;

  for (const tableName of targets) {
    if (signal && signal.aborted) { aborted = true; break; }
    if (results.length >= maxResult) break;
    scanned += 1;
    if (onProgress) {
      onProgress({ scanned, total, currentTable: tableName ?? "(all tables)" });
    }

    try {
      const rows = await runEngineOnce({
        pool,
        likePattern,
        tableNamePattern: tableName,
        signal,
      });

      for (const r of rows) {
        if (typeFilter && !typeFilter.has(String(r.ColumnType || "").toLowerCase())) continue;
        results.push({
          tableName: String(r.TableName ?? tableName ?? ""),
          columnName: String(r.ColumnName ?? ""),
          foundValue: r.ColumnValue == null ? "" : String(r.ColumnValue),
          columnType: String(r.ColumnType ?? ""),
          count: Number(r.Count ?? 1),
        });
        if (results.length >= maxResult) break;
      }
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      // mssql throws on request.cancel() — treat as cooperative cancellation.
      if (signal && signal.aborted) { aborted = true; break; }
      if (onProgress) {
        onProgress({
          scanned,
          total,
          currentTable: tableName ?? "(all tables)",
          warning: message,
        });
      }
    }
  }

  return { results, scanned, total, aborted };
}

module.exports = { runSearch, buildLikePattern };