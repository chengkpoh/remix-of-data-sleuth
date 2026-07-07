/**
 * sqlScriptParser.ts
 * -----------------------------------------------------------------------------
 * Pure, zero-dependency T-SQL → structured-components parser for the
 * Data Explorer "Import Script → Query Builder" flow.
 *
 * It splits a pasted/uploaded SQL script into the same shape used by the
 * (additively extended) DataExplorerSpec and recognises:
 *   SELECT, FROM, JOIN ... ON, WHERE, GROUP BY, ORDER BY,
 *   PARTITION BY, ROW_NUMBER() OVER (...), RANK/DENSE_RANK/SUM OVER,
 *   CONVERT, CASE WHEN, ISNULL.
 *
 * Everything new here is additive and self-contained — it does not touch any
 * existing module. Drop this file at:  src/lib/sqlScriptParser.ts
 * -----------------------------------------------------------------------------
 */

// ---- Extended spec types (mirror the repo's DataExplorer* types exactly) ----

export interface DataExplorerSelectColumn {
  expression: string;
  alias?: string;
}

export interface DataExplorerOrderBy {
  expression: string;
  direction: "ASC" | "DESC";
}

export interface DataExplorerGroupBy {
  expression: string;
}

export interface DataExplorerWindowFunction {
  name: string;
  expression?: string;
  partitionBy: string[];
  orderBy: string;
  alias: string;
}

export interface SpecTable {
  schema: string;
  name: string;
  alias: string;
}

export interface SpecJoin {
  leftAlias: string;
  leftColumn: string;
  rightAlias: string;
  rightColumn: string;
  joinType?: "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS";
  source?: "auto" | "manual";
}

export interface SpecCondition {
  andOr: "AND" | "OR";
  alias: string;
  column: string;
  operator: string;
  value?: string | number | boolean | null;
  value2?: string | number | boolean | null;
  raw?: string;
}

export interface ExtendedDataExplorerSpec {
  tables: SpecTable[];
  joins: SpecJoin[];
  conditions: SpecCondition[];
  limit: number;
  selectColumns?: DataExplorerSelectColumn[];
  groupBy?: DataExplorerGroupBy[];
  orderBy?: DataExplorerOrderBy[];
  windowFunctions?: DataExplorerWindowFunction[];
  distinct?: boolean;
  rawSql?: string;
}

// ---- Parsed-script model (richer than the spec — drives the UI) ----

export interface ParsedSelectColumn {
  expression: string;
  alias?: string;
  hasWindowFunction: boolean;
  hasCase: boolean;
  hasConvert: boolean;
  hasIsNull: boolean;
}

export interface ParsedTableRef {
  schema?: string;
  name: string;
  alias?: string;
}

export interface ParsedJoin {
  joinType: string;
  table: ParsedTableRef;
  onRaw?: string;
  leftAlias?: string;
  leftColumn?: string;
  rightAlias?: string;
  rightColumn?: string;
}

export interface ParsedCondition {
  raw: string;
  alias?: string;
  column?: string;
  operator?: string;
  value?: string;
}

export interface ParsedOrderBy {
  expression: string;
  direction: "ASC" | "DESC";
}

export interface ParsedWindowFunction {
  name: string;
  expression?: string;
  partitionBy: string[];
  orderBy: string;
  alias?: string;
}

export interface ParsedScript {
  selectColumns: ParsedSelectColumn[];
  tables: ParsedTableRef[];
  joins: ParsedJoin[];
  conditions: ParsedCondition[];
  groupBy: string[];
  orderBy: ParsedOrderBy[];
  windowFunctions: ParsedWindowFunction[];
  distinct: boolean;
  warnings: string[];
  rawSql?: string;
}

// ===========================================================================
//  Low-level helpers
// ===========================================================================

function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (inStr) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { out += "'"; i += 2; continue; }
        inStr = false;
      }
      i++;
      continue;
    }
    if (ch === "'") { inStr = true; out += ch; i++; continue; }
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

type Tok = { v: string; kind: "word" | "str" | "punct"; depth: number; pos: number };

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let depth = 0;
  const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'") {
      let j = i + 1;
      let v = "'";
      while (j < s.length) {
        if (s[j] === "'") {
          if (s[j + 1] === "'") { v += "''"; j += 2; continue; }
          v += "'"; j++; break;
        }
        v += s[j]; j++;
      }
      toks.push({ v, kind: "str", depth, pos: i });
      i = j; continue;
    }
    if (ch === "[") {
      let j = i + 1;
      let v = "[";
      while (j < s.length) {
        if (s[j] === "]") {
          if (s[j + 1] === "]") { v += "]]"; j += 2; continue; }
          v += "]"; j++; break;
        }
        v += s[j]; j++;
      }
      toks.push({ v, kind: "word", depth, pos: i });
      i = j; continue;
    }
    if (ch === "(") { toks.push({ v: "(", kind: "punct", depth, pos: i }); depth++; i++; continue; }
    if (ch === ")") { depth--; toks.push({ v: ")", kind: "punct", depth, pos: i }); i++; continue; }
    if (isWord(ch)) {
      let j = i;
      let v = "";
      while (j < s.length && isWord(s[j])) { v += s[j]; j++; }
      toks.push({ v, kind: "word", depth, pos: i });
      i = j; continue;
    }
    toks.push({ v: ch, kind: "punct", depth, pos: i });
    i++;
  }
  return toks;
}

function stripIdent(x: string): string {
  let v = x.trim();
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1).replace(/]]/g, "]");
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v;
}

function findBalanced(s: string, openIdx: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (ch === "'") inStr = false; continue; }
    if (ch === "'") { inStr = true; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findBalancedBack(s: string, closeIdx: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = closeIdx; i >= 0; i--) {
    const ch = s[i];
    if (inStr) { if (ch === "'") inStr = false; continue; }
    if (ch === "'") { inStr = true; continue; }
    if (ch === ")") depth++;
    else if (ch === "(") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let inBrk = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (ch === "'") { if (s[i + 1] === "'") { i++; } else inStr = false; } continue; }
    if (ch === "'") { inStr = true; continue; }
    if (ch === "[") { inBrk = true; continue; }
    if (ch === "]" && inBrk) { inBrk = false; continue; }
    if (inBrk) continue;
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth--; continue; }
    if (ch === "," && depth === 0) { parts.push(s.slice(start, i).trim()); start = i + 1; }
  }
  const last = s.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

// ===========================================================================
//  Clause extraction
// ===========================================================================

interface Clause {
  name: "select" | "from" | "where" | "groupBy" | "orderBy" | "having";
  kwPos: number;
  contentStart: number;
}

function nextWordTok(toks: Tok[], k: number): Tok | null {
  for (let j = k; j < toks.length; j++) {
    if (toks[j].kind === "word") return toks[j];
  }
  return null;
}

function extractClauses(s: string): { distinct: boolean; clauses: Clause[]; unionAt: number } {
  const toks = tokenize(s);
  const clauses: Clause[] = [];
  let distinct = false;
  let unionAt = -1;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.depth !== 0 || t.kind !== "word") continue;
    const up = t.v.toUpperCase();
    if (up === "SELECT") {
      clauses.push({ name: "select", kwPos: t.pos, contentStart: t.pos + t.v.length });
    } else if (up === "DISTINCT") {
      distinct = true;
    } else if (up === "FROM") {
      clauses.push({ name: "from", kwPos: t.pos, contentStart: t.pos + t.v.length });
    } else if (up === "WHERE") {
      clauses.push({ name: "where", kwPos: t.pos, contentStart: t.pos + t.v.length });
    } else if (up === "HAVING") {
      clauses.push({ name: "having", kwPos: t.pos, contentStart: t.pos + t.v.length });
    } else if (up === "GROUP" || up === "ORDER") {
      const nxt = nextWordTok(toks, k + 1);
      if (nxt && nxt.v.toUpperCase() === "BY") {
        clauses.push({
          name: up === "GROUP" ? "groupBy" : "orderBy",
          kwPos: t.pos,
          contentStart: nxt.pos + nxt.v.length,
        });
        // skip the BY token
        for (let j = k + 1; j < toks.length; j++) {
          if (toks[j] === nxt) { k = j; break; }
        }
      }
    } else if (up === "UNION") {
      unionAt = t.pos;
      break;
    }
  }
  return { distinct, clauses, unionAt };
}

function clauseText(s: string, clauses: Clause[], name: Clause["name"], unionAt: number): string {
  const c = clauses.find((x) => x.name === name);
  if (!c) return "";
  const ends = clauses
    .filter((x) => x.kwPos > c.kwPos)
    .map((x) => x.kwPos)
    .concat(unionAt > 0 ? [unionAt] : [])
    .concat([s.length]);
  const end = Math.min(...ends);
  return s.slice(c.contentStart, end).trim();
}

// ===========================================================================
//  SELECT
// ===========================================================================

function splitAlias(item: string): { expr: string; alias?: string } {
  const m = item.match(/\s+AS\s+("[^"]+"|\[[^\]]+\]|[A-Za-z_]\w*)\s*$/i);
  if (m) return { expr: item.slice(0, m.index).trim(), alias: stripIdent(m[1]) };
  const m2 = item.match(/\s+("[^"]+"|\[[^\]]+\]|[A-Za-z_]\w*)\s*$/);
  if (m2 && m2.index !== undefined) {
    const before = item.slice(0, m2.index).trimEnd();
    const last = before[before.length - 1];
    const looksComplete = last && (")]*\"'".includes(last) || /[A-Za-z0-9_\]]$/.test(before));
    const simpleDotted = !/\s/.test(before) && /^[\w.\[\]]+$/.test(before);
    if (looksComplete && !simpleDotted) {
      return { expr: before, alias: stripIdent(m2[1]) };
    }
  }
  return { expr: item.trim() };
}

function parsePartition(over: string): string[] {
  const m = over.match(/\bPARTITION\s+BY\b(.+?)(\bORDER\s+BY\b|$)/is);
  if (!m) return [];
  return splitTopLevelCommas(m[1].trim());
}

function parseOverOrderBy(over: string): string {
  const m = over.match(/\bORDER\s+BY\b(.+)$/is);
  return m ? m[1].trim() : "";
}

function extractWindow(item: string): { wf: ParsedWindowFunction | null } {
  const m = item.match(/\bOVER\s*\(/i);
  if (!m || m.index === undefined) return { wf: null };
  const overParenStart = m.index + m[0].length - 1;
  const overClose = findBalanced(item, overParenStart);
  if (overClose < 0) return { wf: null };
  const overContent = item.slice(overParenStart + 1, overClose);

  let j = m.index - 1;
  while (j >= 0 && /\s/.test(item[j])) j--;
  let name = "";
  let expression: string | undefined;
  if (item[j] === ")") {
    const funcOpen = findBalancedBack(item, j);
    if (funcOpen >= 0) {
      const before = item.slice(0, funcOpen);
      const nm = before.match(/([A-Za-z_]\w*)\s*$/);
      if (nm) name = nm[1].toUpperCase();
      expression = item.slice(funcOpen + 1, j).trim() || undefined;
    }
  }

  let alias: string | undefined;
  const after = item.slice(overClose + 1).trim();
  const am = after.match(/^(?:AS\s+)?("[^"]+"|\[[^\]]+\]|[A-Za-z_]\w*)\s*$/i);
  if (am) alias = stripIdent(am[1]);

  return {
    wf: {
      name,
      expression,
      partitionBy: parsePartition(overContent),
      orderBy: parseOverOrderBy(overContent),
      alias,
    },
  };
}

function parseSelect(text: string, warnings: string[]): {
  columns: ParsedSelectColumn[];
  windows: ParsedWindowFunction[];
} {
  const items = splitTopLevelCommas(text);
  const columns: ParsedSelectColumn[] = [];
  const windows: ParsedWindowFunction[] = [];
  for (const item of items) {
    const { expr, alias } = splitAlias(item);
    const { wf } = extractWindow(item);
    if (wf) {
      windows.push({ ...wf, alias: wf.alias || alias });
      warnings.push(`Window function ${wf.name || "(unknown)"}() OVER(...) detected.`);
    }
    columns.push({
      expression: expr,
      alias,
      hasWindowFunction: !!wf,
      hasCase: /\bCASE\b/i.test(expr) && /\bWHEN\b/i.test(expr),
      hasConvert: /\bCONVERT\s*\(/i.test(expr),
      hasIsNull: /\bISNULL\s*\(/i.test(expr),
    });
  }
  return { columns, windows };
}

// ===========================================================================
//  FROM / JOIN
// ===========================================================================

const JOIN_TYPE_WORDS = new Set(["INNER", "LEFT", "RIGHT", "FULL", "CROSS", "OUTER"]);

function parseFrom(text: string, warnings: string[]): { tables: ParsedTableRef[]; joins: ParsedJoin[] } {
  const toks = tokenize(text);
  const tables: ParsedTableRef[] = [];
  const joins: ParsedJoin[] = [];
  let k = 0;
  const n = toks.length;

  const readTableRef = (): ParsedTableRef | null => {
    while (k < n && toks[k].kind === "punct" && toks[k].v === ",") k++;
    if (k >= n || toks[k].kind !== "word") return null;
    let name = stripIdent(toks[k].v);
    let schema: string | undefined;
    k++;
    if (k < n && toks[k].v === ".") {
      k++;
      schema = name;
      if (k < n && toks[k].kind === "word") { name = stripIdent(toks[k].v); k++; }
    }
    // WITH (NOLOCK) hint
    if (k < n && toks[k].kind === "word" && toks[k].v.toUpperCase() === "WITH" && toks[k + 1] && toks[k + 1].v === "(") {
      const open = toks[k + 1].pos;
      const close = findBalanced(text, open);
      if (close >= 0) {
        // advance k past the WITH(...) group
        k += 2;
        while (k < n && toks[k].pos <= close) k++;
      }
    }
    let alias: string | undefined;
    if (k < n && toks[k].kind === "word" && toks[k].v.toUpperCase() === "AS") {
      k++;
      if (k < n && toks[k].kind === "word") { alias = stripIdent(toks[k].v); k++; }
    } else if (
      k < n && toks[k].kind === "word" &&
      !JOIN_TYPE_WORDS.has(toks[k].v.toUpperCase()) &&
      toks[k].v.toUpperCase() !== "JOIN" &&
      toks[k].v.toUpperCase() !== "ON"
    ) {
      alias = stripIdent(toks[k].v);
      k++;
    }
    return { schema, name, alias };
  };

  // first table refs (comma separated) before any JOIN
  const first = readTableRef();
  if (first) {
    tables.push(first);
    while (k < n && toks[k].kind === "punct" && toks[k].v === ",") {
      k++;
      const nxt = readTableRef();
      if (nxt) tables.push(nxt); else break;
    }
  }

  // process all JOINs
  while (k < n) {
    const up = toks[k].kind === "word" ? toks[k].v.toUpperCase() : "";
    if (!JOIN_TYPE_WORDS.has(up) && up !== "JOIN") break;

    // read join type words (LEFT, OUTER, etc.)
    let joinType = "LEFT";
    while (k < n && toks[k].kind === "word" && JOIN_TYPE_WORDS.has(toks[k].v.toUpperCase())) {
      joinType = toks[k].v.toUpperCase();
      k++;
    }
    if (k < n && toks[k].kind === "word" && toks[k].v.toUpperCase() === "JOIN") k++;
    else { warnings.push("Malformed JOIN skipped."); break; }

    const tbl = readTableRef();
    if (!tbl) break;

    let onRaw: string | undefined;
    let leftAlias: string | undefined, leftColumn: string | undefined;
    let rightAlias: string | undefined, rightColumn: string | undefined;

    if (k < n && toks[k].kind === "word" && toks[k].v.toUpperCase() === "ON") {
      k++;
      const onStart = k < n ? toks[k].pos : text.length;
      let onEnd = text.length;
      for (let j = k; j < n; j++) {
        const up2 = toks[j].v.toUpperCase();
        if (toks[j].depth === 0 && (JOIN_TYPE_WORDS.has(up2) || up2 === "JOIN")) {
          onEnd = toks[j].pos;
          break;
        }
        if (toks[j].depth === 0 && toks[j].v === ",") {
          onEnd = toks[j].pos;
          break;
        }
      }
      onRaw = text.slice(onStart, onEnd).trim();
      const om = onRaw.match(/(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/);
      if (om) {
        leftAlias = om[1]; leftColumn = om[2];
        rightAlias = om[3]; rightColumn = om[4];
      }
      while (k < n && toks[k].pos < onEnd) k++;
    }

    joins.push({ joinType, table: tbl, onRaw, leftAlias, leftColumn, rightAlias, rightColumn });
  }

  return { tables, joins };
}

// ===========================================================================
//  WHERE
// ===========================================================================

function splitWhere(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let inBrk = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (ch === "'") { if (text[i + 1] === "'") { i++; } else inStr = false; } continue; }
    if (ch === "'") { inStr = true; continue; }
    if (ch === "[") { inBrk = true; continue; }
    if (ch === "]" && inBrk) { inBrk = false; continue; }
    if (inBrk) continue;
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth--; continue; }
    if (depth === 0) {
      const rest = text.slice(i);
      const m = rest.match(/^(AND|OR)\b/i);
      if (m && (i === start || /\W/.test(text[i - 1]))) {
        if (i > start) parts.push(text.slice(start, i).trim());
        start = i + m[0].length;
        i += m[0].length - 1;
      }
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function unquote(v: string): string {
  let s = v.trim();
  if (/^N?'/i.test(s) && s.endsWith("'")) {
    s = s.replace(/^N?'/i, "").replace(/'$/, "").replace(/''/g, "'");
  }
  return s;
}

function unwrapParens(s: string): string {
  let v = s.trim();
  while (v.startsWith("(") && v.endsWith(")")) {
    // Only strip if the leading "(" and trailing ")" form a balanced pair
    let depth = 0;
    let balanced = true;
    let inStr = false;
    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      if (inStr) { if (ch === "'") { if (v[i + 1] === "'") { i++; } else inStr = false; } continue; }
      if (ch === "'") { inStr = true; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0 && i !== v.length - 1) { balanced = false; break; }
      }
    }
    if (balanced) v = v.slice(1, -1).trim();
    else break;
  }
  return v;
}

function mapCondition(raw: string): ParsedCondition {
  const r = unwrapParens(raw);
  let m = r.match(/^(\w+)\.(\w+)\s+(IS\s+NOT\s+NULL|IS\s+NULL)$/i);
  if (m) {
    return {
      raw: r,
      alias: m[1],
      column: m[2],
      operator: /NOT/i.test(m[3]) ? "isNotNull" : "isNull",
    };
  }
  m = r.match(/^(\w+)\.(\w+)\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/i);
  if (m) {
    const map: Record<string, string> = { "=": "=", "!=": "!=", "<>": "!=", ">": ">", "<": "<", ">=": ">=", "<=": "<=" };
    return {
      raw: r,
      alias: m[1],
      column: m[2],
      operator: map[m[3]] || m[3],
      value: unquote(m[4]),
    };
  }
  m = r.match(/^(\w+)\.(\w+)\s+LIKE\s+(.+)$/i);
  if (m) {
    return { raw: r, alias: m[1], column: m[2], operator: "contains", value: unquote(m[3]) };
  }
  return { raw: r, operator: "raw" };
}

function parseWhere(text: string, warnings: string[]): ParsedCondition[] {
  if (!text) return [];
  const conds = splitWhere(text);
  const out = conds.map(mapCondition);
  const rawCount = out.filter((c) => c.operator === "raw").length;
  if (rawCount) warnings.push(`${rawCount} WHERE condition(s) kept as raw SQL (complex predicates).`);
  return out;
}

// ===========================================================================
//  GROUP BY / ORDER BY
// ===========================================================================

function parseGroupBy(text: string): string[] {
  if (!text) return [];
  return splitTopLevelCommas(text);
}

function parseOrderBy(text: string): ParsedOrderBy[] {
  if (!text) return [];
  return splitTopLevelCommas(text).map((part) => {
    const m = part.match(/^(.*?)\s+(ASC|DESC)\s*$/i);
    if (m) return { expression: m[1].trim(), direction: m[2].toUpperCase() as "ASC" | "DESC" };
    return { expression: part.trim(), direction: "ASC" as const };
  });
}

// ===========================================================================
//  CTE (WITH ... AS) extraction
// ===========================================================================

interface CteBlock {
  name: string;
  innerSql: string; // the SELECT inside the parentheses
}

function extractCTEs(sql: string): { ctes: CteBlock[]; mainQuery: string } {
  // Check if the script starts with WITH
  const withMatch = sql.match(/^\s*WITH\s+/i);
  if (!withMatch) return { ctes: [], mainQuery: sql };

  const ctes: CteBlock[] = [];
  let i = withMatch[0].length;
  const n = sql.length;

  while (i < n) {
    // Skip whitespace
    while (i < n && /\s/.test(sql[i])) i++;
    if (i >= n) break;

    // Read CTE name
    let name = "";
    while (i < n && /[A-Za-z0-9_]/.test(sql[i])) {
      name += sql[i];
      i++;
    }
    if (!name) break;

    // Skip whitespace
    while (i < n && /\s/.test(sql[i])) i++;

    // Expect AS
    const asMatch = sql.slice(i).match(/^AS\s*/i);
    if (!asMatch) break;
    i += asMatch[0].length;

    // Skip whitespace
    while (i < n && /\s/.test(sql[i])) i++;

    // Expect (
    if (sql[i] !== "(") break;
    const openIdx = i;
    const closeIdx = findBalanced(sql, openIdx);
    if (closeIdx < 0) break;

    const innerSql = sql.slice(openIdx + 1, closeIdx).trim();
    ctes.push({ name, innerSql });
    i = closeIdx + 1;

    // Skip whitespace
    while (i < n && /\s/.test(sql[i])) i++;

    // If next char is a comma, there's another CTE; otherwise the rest is the main query
    if (sql[i] === ",") {
      i++;
      continue;
    }
    break;
  }

  const mainQuery = sql.slice(i).trim();
  return { ctes, mainQuery };
}

// ===========================================================================
//  Public API
// ===========================================================================

function emptyParsed(): ParsedScript {
  return {
    selectColumns: [], tables: [], joins: [], conditions: [],
    groupBy: [], orderBy: [], windowFunctions: [], distinct: false, warnings: [],
  };
}

function parseSingleSelect(cleaned: string, warnings: string[]): ParsedScript {
  const { distinct, clauses, unionAt } = extractClauses(cleaned);
  if (unionAt > 0) warnings.push("UNION detected — only the first SELECT statement was parsed.");

  const selectText = clauseText(cleaned, clauses, "select", unionAt);
  const fromText = clauseText(cleaned, clauses, "from", unionAt);
  const whereText = clauseText(cleaned, clauses, "where", unionAt);
  const groupText = clauseText(cleaned, clauses, "groupBy", unionAt);
  const orderText = clauseText(cleaned, clauses, "orderBy", unionAt);

  if (!selectText && !fromText) {
    warnings.push("No SELECT/FROM found — is this a valid SELECT query?");
  }

  const { columns, windows } = parseSelect(selectText, warnings);
  const { tables, joins } = parseFrom(fromText, warnings);
  const conditions = parseWhere(whereText, warnings);
  const groupBy = parseGroupBy(groupText);
  const orderBy = parseOrderBy(orderText);

  return {
    selectColumns: columns,
    tables,
    joins,
    conditions,
    groupBy,
    orderBy,
    windowFunctions: windows,
    distinct,
    warnings,
  };
}

export function parseSqlScript(input: string): ParsedScript {
  const warnings: string[] = [];
  const trimmed = input.trim().replace(/;\s*$/, "").trim();
  if (!trimmed) return emptyParsed();
  const cleaned = stripComments(trimmed);

  // ---- CTE handling ----
  const { ctes, mainQuery } = extractCTEs(cleaned);

  if (ctes.length > 0) {
    warnings.push(`${ctes.length} CTE(s) detected (WITH ... AS). Tables/joins/conditions extracted from CTE inner queries; projection from the final SELECT.`);

    // Parse each CTE's inner query for tables/joins/conditions/window functions
    const cteResults: ParsedScript[] = ctes.map((cte) => {
      const innerCleaned = stripComments(cte.innerSql.trim());
      return parseSingleSelect(innerCleaned, warnings);
    });

    // Parse the main query (final SELECT) for projection columns
    const mainCleaned = mainQuery.trim();
    const mainResult = mainCleaned ? parseSingleSelect(mainCleaned, warnings) : emptyParsed();

    // Merge: CTEs provide the real table structure; main query provides the projection
    const merged: ParsedScript = {
      selectColumns: mainResult.selectColumns,
      tables: cteResults.flatMap((r) => r.tables),
      joins: cteResults.flatMap((r) => r.joins),
      conditions: cteResults.flatMap((r) => r.conditions),
      groupBy: [...mainResult.groupBy, ...cteResults.flatMap((r) => r.groupBy)],
      orderBy: [...mainResult.orderBy, ...cteResults.flatMap((r) => r.orderBy)],
      windowFunctions: [...mainResult.windowFunctions, ...cteResults.flatMap((r) => r.windowFunctions)],
      distinct: mainResult.distinct,
      warnings,
      rawSql: cleaned,
    };

    return merged;
  }

  // ---- No CTE — normal path ----
  return parseSingleSelect(cleaned, warnings);
}

export function buildSpecFromParsed(parsed: ParsedScript, limit = 100): ExtendedDataExplorerSpec {
  // Collect ALL tables: both the base FROM tables AND tables referenced in JOINs
  const allTableRefs = [...parsed.tables];
  for (const j of parsed.joins) {
    if (j.table) allTableRefs.push(j.table);
  }
  // Deduplicate by alias (falls back to name) to avoid duplicates
  const seen = new Set<string>();
  const tables: SpecTable[] = [];
  for (const t of allTableRefs) {
    const alias = (t.alias || t.name).replace(/[^A-Za-z0-9_]/g, "");
    const key = alias || t.name;
    if (seen.has(key)) continue;
    seen.add(key);
    tables.push({
      schema: t.schema || "dbo",
      name: t.name,
      alias,
    });
  }

  const joins: SpecJoin[] = parsed.joins
    .filter((j) => j.leftAlias && j.leftColumn && j.rightAlias && j.rightColumn)
    .map((j) => ({
      leftAlias: j.leftAlias!,
      leftColumn: j.leftColumn!,
      rightAlias: j.rightAlias!,
      rightColumn: j.rightColumn!,
      joinType: (j.joinType || "LEFT") as SpecJoin["joinType"],
      source: "manual" as const,
    }));

  const conditions: SpecCondition[] = parsed.conditions.map((c) => ({
    andOr: "AND" as const,
    alias: c.alias || "",
    column: c.column || "",
    operator: c.operator || "raw",
    value: c.value ?? null,
    raw: c.raw,
  }));

  const spec: ExtendedDataExplorerSpec = {
    tables,
    joins,
    conditions,
    limit,
  };

  if (parsed.selectColumns.length) {
    spec.selectColumns = parsed.selectColumns.map((c) => ({ expression: c.expression, alias: c.alias }));
  }
  if (parsed.groupBy.length) spec.groupBy = parsed.groupBy.map((expression) => ({ expression }));
  if (parsed.orderBy.length) spec.orderBy = parsed.orderBy.map((o) => ({ expression: o.expression, direction: o.direction }));
  if (parsed.windowFunctions.length) {
    spec.windowFunctions = parsed.windowFunctions.map((w) => ({
      name: w.name,
      expression: w.expression,
      partitionBy: w.partitionBy,
      orderBy: w.orderBy,
      alias: w.alias || `${w.name.toLowerCase()}_col`,
    }));
  }
  if (parsed.distinct) spec.distinct = true;
  if (parsed.rawSql) spec.rawSql = parsed.rawSql;

  return spec;
}