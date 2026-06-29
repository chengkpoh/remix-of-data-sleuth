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
    const r = await pool.request().query(`
      SELECT
        SUM(CAST(size AS bigint)) * 8.0 / 1024 AS TotalMB,
        SUM(CAST(FILEPROPERTY(name, 'SpaceUsed') AS bigint)) * 8.0 / 1024 AS UsedMB
      FROM sys.database_files
      WHERE type_desc IN ('ROWS','LOG')
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