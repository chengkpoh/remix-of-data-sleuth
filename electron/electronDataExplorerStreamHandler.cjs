// ============================================================================
// electronDataExplorerStreamHandler.cjs
// -----------------------------------------------------------------------------
// 流式版 Data Explorer 查询处理器 —— 替代原来的 ipcMain.handle。
//
// 核心改动：
//   1. 用 ipcMain.on + event.sender.send 流式返回行数据
//   2. 用 mssql 的 request.stream = true 逐行读取，不等待全量缓冲
//   3. 每 BATCH_SIZE 行发一个 batch 事件，前端立即渲染
//   4. 全量数据仍在前端内存中，不影响 client-side filter/sort
//
// 用法（在 Electron 主进程 index.cjs 里）：
//
//   const { initStreamHandler } = require("./electronDataExplorerStreamHandler.cjs");
//   initStreamHandler(ipcMain, () => pool, () => schemaCache, () => loadSchema());
//
// 同时保留原来的 ipcMain.handle("erp:runDataExplorerQuery", ...) 作为 fallback。
// ============================================================================

const BATCH_SIZE = 2000;

function buildSqlText(spec, pool, schemaCache, loadSchema) {
  // ---- rawSql 直接返回 ----
  if (spec.rawSql) {
    return { rawSql: spec.rawSql.trim() };
  }

  // ---- 以下和原 handler 完全一致的 SQL 构建逻辑 ----
  if (!schemaCache) {
    throw new Error("Schema not loaded");
  }

  const tables = Array.isArray(spec?.tables) ? spec.tables : [];
  if (!tables.length) throw new Error("Select at least one table.");

  const tableByAlias = new Map();
  const orderedTables = [];
  for (const t of tables) {
    const exists = schemaCache.tables.some((x) => x.schema === t.schema && x.name === t.name);
    if (!exists) throw new Error(`Unknown table ${t.schema}.${t.name}`);
    const alias = String(t.alias || t.name).replace(/[^A-Za-z0-9_]/g, "");
    if (!alias) throw new Error(`Invalid alias for ${t.schema}.${t.name}`);
    if (tableByAlias.has(alias)) throw new Error(`Duplicate alias "${alias}"`);
    const instance = { ...t, alias };
    tableByAlias.set(alias, instance);
    orderedTables.push(instance);
  }

  const colExists = (alias, col) => {
    const t = tableByAlias.get(alias);
    if (!t) return null;
    const c = schemaCache.columns.find(
      (x) => x.schema === t.schema && x.table === t.name && x.column === col,
    );
    return c ? c.type : null;
  };

  const qi = (s) => "[" + String(s).replace(/]/g, "]]") + "]";
  const tableSource = (t) => `${qi(t.schema)}.${qi(t.name)} AS ${qi(t.alias)} WITH (NOLOCK)`;

  const firstAlias = orderedTables[0].alias;
  const fromParts = [tableSource(orderedTables[0])];

  const joins = Array.isArray(spec.joins) ? spec.joins : [];
  const joinedAliases = new Set([firstAlias]);
  for (const j of joins) {
    const jt = String(j.joinType || "LEFT").toUpperCase();
    const leftTable = tableByAlias.get(j.leftAlias);
    const rightTable = tableByAlias.get(j.rightAlias);
    if (!leftTable) throw new Error(`Unknown alias in join: ${j.leftAlias}`);
    if (!rightTable) throw new Error(`Unknown alias in join: ${j.rightAlias}`);

    let t = rightTable;
    let aliasToJoin = j.rightAlias;
    if (joinedAliases.has(j.rightAlias) && !joinedAliases.has(j.leftAlias)) {
      t = leftTable;
      aliasToJoin = j.leftAlias;
    }
    if (!joinedAliases.has(j.leftAlias) && !joinedAliases.has(j.rightAlias)) {
      fromParts.push(`CROSS JOIN ${tableSource(leftTable)}`);
      joinedAliases.add(j.leftAlias);
      t = rightTable;
      aliasToJoin = j.rightAlias;
    }
    if (joinedAliases.has(aliasToJoin)) continue;

    if (jt === "CROSS") {
      fromParts.push(`CROSS JOIN ${tableSource(t)}`);
      joinedAliases.add(aliasToJoin);
      continue;
    }
    const leftType = colExists(j.leftAlias, j.leftColumn);
    const rightType = colExists(j.rightAlias, j.rightColumn);
    if (!leftType || !rightType) throw new Error(`Invalid join column: ${j.leftAlias}.${j.leftColumn} = ${j.rightAlias}.${j.rightColumn}`);
    const allowedTypes = new Set(["INNER", "LEFT", "RIGHT", "FULL"]);
    const kw = allowedTypes.has(jt) ? (jt === "FULL" ? "FULL OUTER" : jt) : "LEFT";
    fromParts.push(
      `${kw} JOIN ${tableSource(t)} ON ${qi(j.leftAlias)}.${qi(j.leftColumn)} = ${qi(j.rightAlias)}.${qi(j.rightColumn)}`,
    );
    joinedAliases.add(aliasToJoin);
  }

  for (const t of orderedTables) {
    if (!joinedAliases.has(t.alias)) {
      fromParts.push(`CROSS JOIN ${tableSource(t)}`);
      joinedAliases.add(t.alias);
    }
  }

  // WHERE
  const conditions = Array.isArray(spec.conditions) ? spec.conditions : [];
  const req = pool.request();
  let paramIdx = 0;
  const addParam = (val) => {
    const name = `p${paramIdx++}`;
    req.input(name, val);
    return `@${name}`;
  };
  const allowedOps = new Set([
    "contains", "notContains", "startsWith", "endsWith", "equals", "notEquals",
    "=", "!=", ">", "<", ">=", "<=", "between",
    "isTrue", "isFalse", "before", "after", "onDate", "isNull", "isNotNull",
    "raw",
  ]);

  const whereParts = [];
  conditions.forEach((c, i) => {
    const type = c.operator === "raw" ? "raw" : colExists(c.alias, c.column);
    if (c.operator !== "raw" && !type) throw new Error(`Unknown column ${c.alias}.${c.column}`);
    if (!allowedOps.has(c.operator)) throw new Error(`Bad operator ${c.operator}`);
    const colRef = `${qi(c.alias)}.${qi(c.column)}`;
    let expr;
    if (c.operator === "raw") { expr = String(c.raw || ""); }
    else switch (c.operator) {
      case "contains":     expr = `${colRef} LIKE ${addParam(`%${c.value ?? ""}%`)}`; break;
      case "notContains":  expr = `${colRef} NOT LIKE ${addParam(`%${c.value ?? ""}%`)}`; break;
      case "startsWith":   expr = `${colRef} LIKE ${addParam(`${c.value ?? ""}%`)}`; break;
      case "endsWith":     expr = `${colRef} LIKE ${addParam(`%${c.value ?? ""}`)}`; break;
      case "equals":
      case "=":            expr = `${colRef} = ${addParam(c.value)}`; break;
      case "notEquals":
      case "!=":           expr = `${colRef} <> ${addParam(c.value)}`; break;
      case ">":            expr = `${colRef} > ${addParam(c.value)}`; break;
      case "<":            expr = `${colRef} < ${addParam(c.value)}`; break;
      case ">=":           expr = `${colRef} >= ${addParam(c.value)}`; break;
      case "<=":           expr = `${colRef} <= ${addParam(c.value)}`; break;
      case "between":      expr = `${colRef} BETWEEN ${addParam(c.value)} AND ${addParam(c.value2)}`; break;
      case "isTrue":       expr = `${colRef} = 1`; break;
      case "isFalse":      expr = `${colRef} = 0`; break;
      case "before":       expr = `${colRef} < ${addParam(c.value)}`; break;
      case "after":        expr = `${colRef} > ${addParam(c.value)}`; break;
      case "onDate":       expr = `CAST(${colRef} AS date) = ${addParam(c.value)}`; break;
      case "isNull":       expr = `${colRef} IS NULL`; break;
      case "isNotNull":    expr = `${colRef} IS NOT NULL`; break;
      default: throw new Error(`Unsupported operator ${c.operator}`);
    }
    const openP = c.groupOpen ? "(" : "";
    const closeP = c.groupClose ? ")" : "";
    const conj = i === 0 ? "" : (String(c.andOr).toUpperCase() === "OR" ? " OR " : " AND ");
    whereParts.push(`${conj}${openP}${expr}${closeP}`);
  });

  const limit = spec.limit != null ? Math.max(1, Math.min(100000, Number(spec.limit))) : null;

  const hasExplicitSelect = Array.isArray(spec.selectColumns) && spec.selectColumns.length > 0;
  const selectParts = [];

  if (hasExplicitSelect) {
    for (const c of spec.selectColumns) {
      const expr = String(c.expression);
      selectParts.push(c.alias ? `${expr} AS ${qi(c.alias)}` : expr);
    }
    if (Array.isArray(spec.windowFunctions)) {
      for (const wf of spec.windowFunctions) {
        const args = wf.expression ? `(${wf.expression})` : "()";
        const part = wf.partitionBy && wf.partitionBy.length ? `PARTITION BY ${wf.partitionBy.join(", ")}` : "";
        const ord = wf.orderBy ? ` ORDER BY ${wf.orderBy}` : "";
        selectParts.push(`${wf.name}${args} OVER (${part}${ord}) AS ${qi(wf.alias)}`);
      }
    }
  } else {
    for (const t of orderedTables) {
      const cols = schemaCache.columns.filter(
        (c) => c.schema === t.schema && c.table === t.name,
      );
      for (const c of cols) {
        selectParts.push(
          `${qi(t.alias)}.${qi(c.column)} AS ${qi(`${t.alias}.${c.column}`)}`,
        );
      }
    }
  }

  const topClause = limit !== null ? `TOP (${limit}) ` : "";

  let sqlText =
    `SELECT ${spec.distinct ? "DISTINCT " : ""}${topClause}${selectParts.join(", ")} ` +
    `FROM ${fromParts.join(" ")}` +
    (whereParts.length ? ` WHERE ${whereParts.join("")}` : "");
  if (hasExplicitSelect && Array.isArray(spec.groupBy) && spec.groupBy.length) {
    sqlText += ` GROUP BY ${spec.groupBy.map((g) => g.expression).join(", ")}`;
  }
  if (Array.isArray(spec.orderBy) && spec.orderBy.length) {
    sqlText += ` ORDER BY ${spec.orderBy.map((o) => `${o.expression} ${o.direction}`).join(", ")}`;
  }

  return { sqlText, request: req };
}

/**
 * 初始化流式查询处理器。
 *
 * @param {import("electron").IpcMain} ipcMain
 * @param {() => Promise<import("mssql").ConnectionPool>} getPool
 * @param {() => any} getSchemaCache
 * @param {() => Promise<void>} loadSchema
 */
function initStreamHandler(ipcMain, getPool, getSchemaCache, loadSchema) {
  ipcMain.on("erp:dataExplorer:stream", async (event, { reqId, spec }) => {
    const send = (channel, data) =>
      event.sender.send(`erp:dataExplorer:${channel}`, { reqId, ...data });

    try {
      const pool = getPool();
      if (!pool) throw new Error("Not connected");

      let sqlToExecute;
      let request;

      if (spec.rawSql) {
        sqlToExecute = spec.rawSql.trim();
        request = pool.request();
      } else {
        const schemaCache = getSchemaCache();
        if (!schemaCache) await loadSchema();
        const built = buildSqlText(spec, getPool(), getSchemaCache(), loadSchema);
        sqlToExecute = built.sqlText;
        request = built.request;
      }

      // ✅ 开启 mssql 流式模式
      request.stream = true;

      const startedAt = Date.now();
      let columns = [];
      let batch = [];
      let totalRows = 0;

      // 列元数据 —— 第一批 row 之前就会收到
      let started = false;
      request.on("recordset", (recordset) => {
        started = true;
        columns = recordset.columns
          ? Object.keys(recordset.columns)
          : [];
        send("start", { columns, sql: sqlToExecute });
      });

      // 逐行到达
      request.on("row", (row) => {
        batch.push(row);
        totalRows++;
        if (batch.length >= BATCH_SIZE) {
          send("batch", { rows: batch, received: totalRows });
          batch = [];
        }
      });

      // 全部完成
      request.on("done", (returnValue) => {
        if (batch.length > 0) {
          send("batch", { rows: batch, received: totalRows });
          batch = [];
        }
        // 如果没有 recordset 事件（非 SELECT 查询），补发 start
        if (!started) {
          send("start", { columns: [], sql: sqlToExecute });
        }
        send("done", {
          durationMs: Date.now() - startedAt,
          totalRows,
        });
      });

      request.on("error", (err) => {
        send("error", { message: err.message });
      });

      // 执行查询
      request.query(sqlToExecute);

    } catch (err) {
      send("error", { message: err.message || String(err) });
    }
  });
}

module.exports = { initStreamHandler, BATCH_SIZE };