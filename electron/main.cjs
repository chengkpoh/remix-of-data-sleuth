const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { runSearch } = require("./searchEngine.cjs");

// Lazy require so the file can be inspected on machines without mssql installed.
let sql = null;
function getSql() {
  if (!sql) sql = require("mssql");
  return sql;
}

/** @type {import('mssql').ConnectionPool | null} */
let pool = null;
/** @type {{ tables: any[]; columns: any[]; fetchedAt: number } | null} */
let schemaCache = null;
/** @type {AbortController | null} */
let currentSearchAbort = null;

const TEXT_TYPES = new Set(["varchar", "nvarchar", "char", "nchar", "text", "ntext"]);
const NUMBER_TYPES = new Set([
  "int", "bigint", "smallint", "tinyint", "decimal", "numeric", "money", "smallmoney",
]);
const ID_TYPES = new Set(["uniqueidentifier"]);

function quoteIdent(name) {
  return "[" + String(name).replace(/]/g, "]]") + "]";
}

function buildPredicate(column, dataType, value, mode) {
  const col = quoteIdent(column);
  const isText = TEXT_TYPES.has(dataType);
  const isId = ID_TYPES.has(dataType);
  const isNumber = NUMBER_TYPES.has(dataType);

  if (isText) {
    if (mode === "exact") return { sql: `${col} = @v_text`, useText: true };
    if (mode === "starts") return { sql: `${col} LIKE @v_starts`, useStarts: true };
    return { sql: `${col} LIKE @v_contains`, useContains: true };
  }
  if (isId) {
    return { sql: `TRY_CAST(${col} AS NVARCHAR(64)) = @v_text`, useText: true };
  }
  if (isNumber) {
    if (mode === "exact") return { sql: `${col} = @v_number`, useNumber: true };
    return { sql: `TRY_CAST(${col} AS NVARCHAR(64)) ${mode === "starts" ? "LIKE @v_starts" : "LIKE @v_contains"}`, useStarts: mode === "starts", useContains: mode !== "starts" };
  }
  return null;
}

async function loadSchema() {
  if (!pool) throw new Error("Not connected");
  const tablesRes = await pool.request().query(`
    SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [name]
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_SCHEMA, TABLE_NAME
  `);
  const colsRes = await pool.request().query(`
    SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [table], COLUMN_NAME AS [column], DATA_TYPE AS [type]
    FROM INFORMATION_SCHEMA.COLUMNS
    ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
  `);
  schemaCache = {
    tables: tablesRes.recordset,
    columns: colsRes.recordset,
    fetchedAt: Date.now(),
  };
  return schemaCache;
}

async function getPrimaryKey(schema, table) {
  if (!pool) throw new Error("Not connected");
  const r = await pool.request()
    .input("schema", schema)
    .input("table", table)
    .query(`
      SELECT kcu.COLUMN_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       AND tc.TABLE_SCHEMA  = kcu.TABLE_SCHEMA
      WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        AND tc.TABLE_SCHEMA = @schema
        AND tc.TABLE_NAME   = @table
      ORDER BY kcu.ORDINAL_POSITION
    `);
  return r.recordset.map((row) => row.COLUMN_NAME);
}

function registerIpc(mainWindow) {
  ipcMain.handle("erp:test", async (_e, cfg) => {
    const mssql = getSql();
    const testPool = new mssql.ConnectionPool({
      server: cfg.server,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      port: cfg.port || 1433,
      options: { encrypt: !!cfg.encrypt, trustServerCertificate: true },
      connectionTimeout: 10000,
    });
    try {
      await testPool.connect();
      await testPool.request().query("SELECT 1 AS ok");
      await testPool.close();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle("erp:connect", async (_e, cfg) => {
    const mssql = getSql();
    if (pool) { try { await pool.close(); } catch {} pool = null; }
    pool = new mssql.ConnectionPool({
      server: cfg.server,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      port: cfg.port || 1433,
      options: { encrypt: !!cfg.encrypt, trustServerCertificate: true },
      connectionTimeout: 15000,
      requestTimeout: 60000,
      pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    });
    await pool.connect();
    const schema = await loadSchema();
    return { ok: true, schema };
  });

  ipcMain.handle("erp:disconnect", async () => {
    if (pool) { try { await pool.close(); } catch {} pool = null; }
    schemaCache = null;
    return { ok: true };
  });

  ipcMain.handle("erp:getSchema", async () => {
    if (!pool) throw new Error("Not connected");
    return schemaCache || (await loadSchema());
  });

  ipcMain.handle("erp:cancelSearch", async () => {
    if (currentSearchAbort) currentSearchAbort.abort();
    return { ok: true };
  });

  ipcMain.handle("erp:search", async (event, params) => {
    if (!pool) throw new Error("Not connected");
    const { value, mode = "contains", maxResults = 50, selectedTables, allowedTypes } = params;
    if (!value || !String(value).length) return { results: [], scanned: 0, total: 0 };

    // Make sure the schema cache is warm so the renderer can resolve schema/PK later.
    if (!schemaCache) { try { await loadSchema(); } catch (_) {} }

    currentSearchAbort = new AbortController();
    const signal = currentSearchAbort.signal;
    const startedAt = Date.now();

    // Map UI tables -> array of plain table names for the engine's @SearchStrTableName.
    const selectedTableNames = (selectedTables && selectedTables.length)
      ? selectedTables.map((t) => (typeof t === "string" ? t : t.name))
      : null;

    try {
      const out = await runSearch({
        pool,
        searchValue: String(value),
        selectedTables: selectedTableNames,
        selectedColumnTypes: (allowedTypes && allowedTypes.length) ? allowedTypes : null,
        searchMode: mode,
        maxResult: maxResults,
        signal,
        onProgress: (p) => { event.sender.send("erp:searchProgress", p); },
      });

      // Resolve schema for each engine row (engine returns quoted "[schema].[table]"),
      // and also expose the engine's native shape on each row.
      const stripQuoted = (s) => String(s || "").replace(/^\[|\]$/g, "").replace(/\]\]/g, "]");
      const results = out.results.map((r) => {
        // r.tableName looks like "[dbo].[Customer]" — split into schema / table.
        const m = /^\[([^\]]+(?:\]\][^\]]*)*)\]\.\[([^\]]+(?:\]\][^\]]*)*)\]$/.exec(r.tableName);
        const schemaName = m ? stripQuoted(`[${m[1]}]`) : "";
        const tableName = m ? stripQuoted(`[${m[2]}]`) : r.tableName;
        const columnName = stripQuoted(r.columnName);
        return {
          // Engine-native shape (what the user spec'd):
          tableName: r.tableName,
          columnName: r.columnName,
          foundValue: r.foundValue,
          // Compatibility shape used by the existing renderer UI:
          schema: schemaName,
          table: tableName,
          column: columnName,
          dataType: r.columnType,
          value: r.foundValue,
          row: {
            TableName: r.tableName,
            ColumnName: r.columnName,
            ColumnValue: r.foundValue,
            ColumnType: r.columnType,
            Count: r.count,
          },
        };
      });

      return {
        results,
        scanned: out.scanned,
        total: out.total,
        durationMs: Date.now() - startedAt,
        aborted: out.aborted || signal.aborted,
      };
    } finally {
      currentSearchAbort = null;
    }
  });

  ipcMain.handle("erp:getRecord", async (_e, { schema, table, column, value }) => {
    if (!pool) throw new Error("Not connected");
    const pk = await getPrimaryKey(schema, table);
    const tableRef = `${quoteIdent(schema)}.${quoteIdent(table)}`;
    const r = await pool.request()
      .input("v", String(value))
      .query(`SELECT TOP 1 * FROM ${tableRef} WITH (NOLOCK) WHERE TRY_CAST(${quoteIdent(column)} AS NVARCHAR(MAX)) = @v`);
    return { row: r.recordset[0] || null, primaryKey: pk };
  });

  // ---------------- Dashboard: server info ----------------
  ipcMain.handle("erp:getServerInfo", async () => {
    if (!pool) throw new Error("Not connected");
    const r = await pool.request().query(`
      SELECT
        CAST(SERVERPROPERTY('ServerName')    AS NVARCHAR(256)) AS ServerName,
        CAST(DB_NAME()                       AS NVARCHAR(256)) AS DatabaseName,
        CAST(SERVERPROPERTY('ProductVersion')AS NVARCHAR(128)) AS Version,
        CAST(SERVERPROPERTY('Edition')       AS NVARCHAR(256)) AS Edition,
        CAST(SERVERPROPERTY('ProductLevel')  AS NVARCHAR(128)) AS Level
    `);
    return r.recordset[0] || {};
  });

  // ---------------- Dashboard: database storage ----------------
  ipcMain.handle("erp:getDatabaseSize", async () => {
    if (!pool) throw new Error("Not connected");
    // Allocation-based calculation (accurate in Azure SQL Database / Elastic Pool,
    // where sys.database_files reports pool-level sizes, not per-DB usage).
    const r = await pool.request().query(`
      ;WITH alloc AS (
        SELECT SUM(a.total_pages) AS total_pages,
               SUM(a.used_pages)  AS used_pages
        FROM sys.tables t
        JOIN sys.indexes i           ON i.object_id = t.object_id
        JOIN sys.partitions p        ON p.object_id = i.object_id AND p.index_id = i.index_id
        JOIN sys.allocation_units a  ON a.container_id = p.partition_id
      )
      SELECT
        CAST(ISNULL(total_pages,0) * 8.0 / 1024 AS float) AS TotalMB,
        CAST(ISNULL(used_pages, 0) * 8.0 / 1024 AS float) AS UsedMB
      FROM alloc
    `);
    const row = r.recordset[0] || { TotalMB: 0, UsedMB: 0 };
    const totalMB = Number(row.TotalMB) || 0;
    const usedMB  = Number(row.UsedMB)  || 0;
    const freeMB  = Math.max(0, totalMB - usedMB);
    return { totalMB, usedMB, freeMB };
  });


  // ---------------- Maintenance: shrink ----------------
  ipcMain.handle("erp:shrinkDatabase", async () => {
    if (!pool) throw new Error("Not connected");
    const dbRes = await pool.request().query("SELECT DB_NAME() AS db");
    const dbName = dbRes.recordset[0].db;
    const startedAt = Date.now();
    await pool.request().query(`DBCC SHRINKDATABASE(${quoteIdent(dbName)})`);
    return { ok: true, database: dbName, durationMs: Date.now() - startedAt };
  });

  // ---------------- Maintenance: fragmentation list ----------------
  ipcMain.handle("erp:getFragmentation", async (_e, { threshold = 5 } = {}) => {
    if (!pool) throw new Error("Not connected");
    const r = await pool.request()
      .input("threshold", Number(threshold) || 0)
      .query(`
        SELECT
          QUOTENAME(s.name) + '.' + QUOTENAME(OBJECT_NAME(ind.object_id)) AS TableName,
          ind.name AS IndexName,
          ips.index_type_desc AS IndexType,
          CAST(ips.avg_fragmentation_in_percent AS DECIMAL(11,2)) AS Fragmentation
        FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, NULL) ips
        INNER JOIN sys.indexes ind
          ON ind.object_id = ips.object_id AND ind.index_id = ips.index_id
        INNER JOIN sys.objects o ON o.object_id = ind.object_id
        INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE ips.avg_fragmentation_in_percent > @threshold
          AND ind.name IS NOT NULL
          AND o.is_ms_shipped = 0
        ORDER BY ips.avg_fragmentation_in_percent DESC
      `);
    return r.recordset;
  });

  /** @type {AbortController | null} */
  let currentMaintAbort = null;
  ipcMain.handle("erp:cancelMaintenance", async () => {
    if (currentMaintAbort) currentMaintAbort.abort();
    return { ok: true };
  });

  // ---------------- Maintenance: run index maintenance ----------------
  ipcMain.handle("erp:runIndexMaintenance", async (event, { threshold = 5 } = {}) => {
    if (!pool) throw new Error("Not connected");
    currentMaintAbort = new AbortController();
    const signal = currentMaintAbort.signal;
    const startedAt = Date.now();

    const listRes = await pool.request()
      .input("threshold", Number(threshold) || 0)
      .query(`
        SELECT
          QUOTENAME(s.name) + '.' + QUOTENAME(OBJECT_NAME(ind.object_id)) AS TableName,
          ind.name AS IndexName,
          ips.index_type_desc AS IndexType,
          CAST(ips.avg_fragmentation_in_percent AS DECIMAL(11,2)) AS Fragmentation
        FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, NULL) ips
        INNER JOIN sys.indexes ind
          ON ind.object_id = ips.object_id AND ind.index_id = ips.index_id
        INNER JOIN sys.objects o ON o.object_id = ind.object_id
        INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE ips.avg_fragmentation_in_percent > @threshold
          AND ind.name IS NOT NULL
          AND o.is_ms_shipped = 0
        ORDER BY ips.avg_fragmentation_in_percent DESC
      `);
    const indexes = listRes.recordset;
    const total = indexes.length;
    const processed = [];
    let aborted = false;

    for (let i = 0; i < indexes.length; i++) {
      if (signal.aborted) { aborted = true; break; }
      const ix = indexes[i];
      const action = Number(ix.Fragmentation) > 30 ? "REBUILD" : "REORGANIZE";
      const idxIdent = quoteIdent(ix.IndexName);
      const sqlStmt = `ALTER INDEX ${idxIdent} ON ${ix.TableName} ${action}`;
      event.sender.send("erp:maintenanceProgress", {
        index: i + 1, total,
        tableName: ix.TableName,
        indexName: ix.IndexName,
        fragmentation: Number(ix.Fragmentation),
        action,
        status: "running",
      });
      try {
        const req = pool.request();
        const onAbort = () => { try { req.cancel(); } catch (_) {} };
        signal.addEventListener("abort", onAbort, { once: true });
        try { await req.query(sqlStmt); } finally { signal.removeEventListener("abort", onAbort); }
        processed.push({ ...ix, action, ok: true });
        event.sender.send("erp:maintenanceProgress", {
          index: i + 1, total,
          tableName: ix.TableName, indexName: ix.IndexName,
          fragmentation: Number(ix.Fragmentation), action, status: "done",
        });
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        if (signal.aborted) { aborted = true; break; }
        processed.push({ ...ix, action, ok: false, error: message });
        event.sender.send("erp:maintenanceProgress", {
          index: i + 1, total,
          tableName: ix.TableName, indexName: ix.IndexName,
          fragmentation: Number(ix.Fragmentation), action,
          status: "error", error: message,
        });
      }
    }


    currentMaintAbort = null;
    return { total, processed, aborted, durationMs: Date.now() - startedAt };
  });

  // ---------------- Schema Manager: list table columns ----------------
  ipcMain.handle("erp:getTableColumns", async (_e, { schema, table }) => {
    if (!pool) throw new Error("Not connected");
    const r = await pool.request()
      .input("schema", schema)
      .input("table", table)
      .query(`
        SELECT
          c.COLUMN_NAME           AS columnName,
          c.DATA_TYPE             AS dataType,
          c.CHARACTER_MAXIMUM_LENGTH AS charMaxLength,
          c.NUMERIC_PRECISION     AS numericPrecision,
          c.NUMERIC_SCALE         AS numericScale,
          c.IS_NULLABLE           AS isNullable,
          c.ORDINAL_POSITION      AS ordinal,
          CAST(CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS bit) AS isPrimaryKey,
          fk.ref_schema           AS fkRefSchema,
          fk.ref_table            AS fkRefTable,
          fk.ref_column           AS fkRefColumn
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN (
          SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME
          FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
            ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
           AND tc.TABLE_SCHEMA   = kcu.TABLE_SCHEMA
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        ) pk
          ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA
         AND pk.TABLE_NAME   = c.TABLE_NAME
         AND pk.COLUMN_NAME  = c.COLUMN_NAME
        LEFT JOIN (
          SELECT
            ps.name      AS parent_schema,
            pt.name      AS parent_table,
            pc.name      AS parent_column,
            rs.name      AS ref_schema,
            rt.name      AS ref_table,
            rc.name      AS ref_column
          FROM sys.foreign_key_columns fkc
          JOIN sys.tables   pt ON pt.object_id = fkc.parent_object_id
          JOIN sys.schemas  ps ON ps.schema_id = pt.schema_id
          JOIN sys.columns  pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
          JOIN sys.tables   rt ON rt.object_id = fkc.referenced_object_id
          JOIN sys.schemas  rs ON rs.schema_id = rt.schema_id
          JOIN sys.columns  rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        ) fk
          ON fk.parent_schema = c.TABLE_SCHEMA
         AND fk.parent_table  = c.TABLE_NAME
         AND fk.parent_column = c.COLUMN_NAME
        WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
        ORDER BY c.ORDINAL_POSITION
      `);
    return r.recordset;
  });

  // ---------------- Schema Manager: column dependencies ----------------
  ipcMain.handle("erp:getColumnDependencies", async (_e, { schema, table, column }) => {
    if (!pool) throw new Error("Not connected");
    const req = pool.request()
      .input("schema", schema)
      .input("table", table)
      .input("column", column);

    const fkOut = await req.query(`
      SELECT
        fk.name AS fkName,
        OBJECT_SCHEMA_NAME(fkc.parent_object_id) AS parentSchema,
        OBJECT_NAME(fkc.parent_object_id) AS parentTable,
        pc.name AS parentColumn,
        OBJECT_SCHEMA_NAME(fkc.referenced_object_id) AS refSchema,
        OBJECT_NAME(fkc.referenced_object_id) AS refTable,
        rc.name AS refColumn
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE
        (OBJECT_SCHEMA_NAME(fkc.parent_object_id) = @schema
         AND OBJECT_NAME(fkc.parent_object_id) = @table
         AND pc.name = @column)
        OR
        (OBJECT_SCHEMA_NAME(fkc.referenced_object_id) = @schema
         AND OBJECT_NAME(fkc.referenced_object_id) = @table
         AND rc.name = @column)
    `);

    const idxOut = await pool.request()
      .input("schema", schema)
      .input("table", table)
      .input("column", column)
      .query(`
        SELECT
          i.name AS indexName,
          i.is_primary_key AS isPrimaryKey,
          i.is_unique_constraint AS isUniqueConstraint,
          i.type_desc AS indexType
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        JOIN sys.tables t ON t.object_id = i.object_id
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        WHERE s.name = @schema AND t.name = @table AND c.name = @column
      `);

    return { foreignKeys: fkOut.recordset, indexes: idxOut.recordset };
  });

  // ---------------- Schema Manager: execute ALTER batch ----------------
  ipcMain.handle("erp:executeAlterStatements", async (_e, { statements }) => {
    if (!pool) throw new Error("Not connected");
    if (!Array.isArray(statements) || !statements.length) {
      return { ok: false, error: "No statements provided", executed: [] };
    }
    const mssql = getSql();
    const tx = new mssql.Transaction(pool);
    const executed = [];
    try {
      await tx.begin();
      for (const stmt of statements) {
        await new mssql.Request(tx).query(stmt);
        executed.push(stmt);
      }
      await tx.commit();
      return { ok: true, executed };
    } catch (err) {
      try { await tx.rollback(); } catch {}
      return {
        ok: false,
        error: String(err && err.message ? err.message : err),
        executed,
      };
    }
  });

  // ---------------- Data Health Checker ----------------
  /** @type {AbortController | null} */
  let currentHealthAbort = null;
  ipcMain.handle("erp:cancelHealthCheck", async () => {
    if (currentHealthAbort) currentHealthAbort.abort();
    return { ok: true };
  });

  ipcMain.handle("erp:runHealthCheck", async (event, { schema, table, maxPerColumn = 500 } = {}) => {
    if (!pool) throw new Error("Not connected");
    currentHealthAbort = new AbortController();
    const signal = currentHealthAbort.signal;
    const startedAt = Date.now();

    const tableReq = pool.request();
    let tableSql = `
      SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [name]
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'`;
    if (schema && table) {
      tableReq.input("schema", schema).input("table", table);
      tableSql += ` AND TABLE_SCHEMA = @schema AND TABLE_NAME = @table`;
    }
    tableSql += ` ORDER BY TABLE_SCHEMA, TABLE_NAME`;
    const tablesRes = await tableReq.query(tableSql);
    const tables = tablesRes.recordset;

    const violations = [];
    const total = tables.length;
    let aborted = false;

    for (let i = 0; i < tables.length; i++) {
      if (signal.aborted) { aborted = true; break; }
      const t = tables[i];
      event.sender.send("erp:healthCheckProgress", {
        index: i + 1, total, currentTable: `${t.schema}.${t.name}`,
      });

      const colsRes = await pool.request()
        .input("schema", t.schema)
        .input("table", t.name)
        .query(`
          SELECT COLUMN_NAME AS columnName, DATA_TYPE AS dataType,
                 CHARACTER_MAXIMUM_LENGTH AS maxLen
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
            AND DATA_TYPE IN ('varchar','nvarchar','char','nchar')
            AND CHARACTER_MAXIMUM_LENGTH IS NOT NULL
            AND CHARACTER_MAXIMUM_LENGTH > 0
        `);
      const cols = colsRes.recordset;
      if (!cols.length) continue;

      let pk = [];
      try { pk = await getPrimaryKey(t.schema, t.name); } catch { pk = []; }
      const tableRef = `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;

      for (const c of cols) {
        if (signal.aborted) { aborted = true; break; }
        const colIdent = quoteIdent(c.columnName);
        const idExpr = pk.length
          ? pk.map((p) => `ISNULL(CAST(${quoteIdent(p)} AS NVARCHAR(MAX)),'')`).join(" + '|' + ")
          : `CAST('' AS NVARCHAR(MAX))`;
        try {
          const r = await pool.request()
            .input("maxLen", Number(c.maxLen))
            .input("topN", Number(maxPerColumn) || 500)
            .query(`
              SELECT TOP (@topN)
                ${idExpr} AS recordId,
                LEN(${colIdent}) AS actualLen
              FROM ${tableRef} WITH (NOLOCK)
              WHERE ${colIdent} IS NOT NULL AND LEN(${colIdent}) > @maxLen
            `);
          for (const row of r.recordset) {
            violations.push({
              schema: t.schema,
              table: t.name,
              column: c.columnName,
              dataType: c.dataType,
              allowedLength: Number(c.maxLen),
              actualLength: Number(row.actualLen),
              recordId: row.recordId == null ? "" : String(row.recordId),
              primaryKey: pk.join(","),
            });
          }
        } catch (err) {
          event.sender.send("erp:healthCheckProgress", {
            index: i + 1, total,
            currentTable: `${t.schema}.${t.name}`,
            warning: `${c.columnName}: ${String(err && err.message ? err.message : err)}`,
          });
        }
      }
    }

    currentHealthAbort = null;
    return {
      violations,
      scanned: tables.length,
      total,
      aborted,
      durationMs: Date.now() - startedAt,
    };
  });
}

function createWindow() {
  const fs = require("fs");
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0b1220",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Diagnostics: log every load failure and open DevTools so the user can see them.
  win.webContents.on("did-fail-load", (_e, errorCode, errorDesc, validatedURL) => {
    console.error("[electron] did-fail-load", { errorCode, errorDesc, validatedURL });
    try { win.webContents.openDevTools({ mode: "detach" }); } catch {}
  });
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    console.error("[electron] preload-error", preloadPath, error);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("[electron] renderer gone:", details);
  });

  const devUrl = process.env.ELECTRON_DEV_URL || "http://localhost:8080";
  const candidates = [
    path.join(__dirname, "..", "dist", "index.html"),
    path.join(__dirname, "..", "dist", "client", "index.html"),
  ];
  const indexPath = candidates.find((p) => fs.existsSync(p));

  console.log("[electron] ELECTRON_DEV =", process.env.ELECTRON_DEV);
  console.log("[electron] __dirname =", __dirname);
  console.log("[electron] candidates =", candidates);
  console.log("[electron] resolved indexPath =", indexPath);

  if (process.env.ELECTRON_DEV === "1") {
    win.loadURL(devUrl);
  } else if (indexPath) {
    win.loadFile(indexPath).catch((err) => {
      console.error("[electron] loadFile failed:", err);
      showLoadError(win, `loadFile failed for ${indexPath}: ${err && err.message}`);
    });
  } else {
    const msg =
      "No index.html was produced by the build.\n\n" +
      "This project is TanStack Start (SSR via Nitro), so `vite build` outputs a server bundle in dist/server/ and JS/CSS chunks in dist/client/, but NOT a static dist/index.html.\n\n" +
      "Electron's file:// loader has nothing to load, which is why the window is blank and SQL never connects (the React UI never renders, so the IPC bridge is never called).\n\n" +
      "Fix options:\n" +
      "  1) Switch to a SPA/prerender build so dist/index.html is emitted.\n" +
      "  2) Bundle a Node SSR server inside Electron and loadURL(http://127.0.0.1:<port>).";
    console.error("[electron] " + msg);
    showLoadError(win, msg);
  }
  registerIpc(win);
}

function showLoadError(win, message) {
  const html =
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<!doctype html><html><body style="background:#0b1220;color:#e5e7eb;font:14px/1.5 system-ui;padding:24px">
        <h2 style="color:#f87171;margin:0 0 12px">ERP Data Finder failed to load the UI</h2>
        <pre style="white-space:pre-wrap;background:#111827;padding:16px;border-radius:8px">${message
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")}</pre>
      </body></html>`,
    );
  win.loadURL(html);
  try { win.webContents.openDevTools({ mode: "detach" }); } catch {}
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});