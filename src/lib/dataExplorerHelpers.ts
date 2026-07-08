import type { ColumnInfo } from "@/lib/erp/types";

export type ColCat = "text" | "number" | "bool" | "date" | "other";

export const TEXT = new Set(["varchar", "nvarchar", "char", "nchar", "text", "ntext"]);
export const NUM  = new Set(["int", "bigint", "smallint", "tinyint", "decimal", "numeric", "money", "smallmoney", "float", "real"]);
export const BOOL = new Set(["bit"]);
export const DATE = new Set(["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset", "time"]);

export function categoryOf(type: string): ColCat {
  const t = (type || "").toLowerCase();
  if (TEXT.has(t)) return "text";
  if (NUM.has(t)) return "number";
  if (BOOL.has(t)) return "bool";
  if (DATE.has(t)) return "date";
  return "other";
}

export const OPS: Record<ColCat, { value: string; label: string }[]> = {
  text: [
    { value: "contains", label: "Contains" },
    { value: "notContains", label: "Not Contains" },
    { value: "startsWith", label: "Starts With" },
    { value: "endsWith", label: "Ends With" },
    { value: "equals", label: "Equals" },
    { value: "notEquals", label: "Not Equals" },
    { value: "isNull", label: "Is Null" },
    { value: "isNotNull", label: "Is Not Null" },
  ],
  number: [
    { value: "=", label: "=" }, { value: "!=", label: "!=" },
    { value: ">", label: ">" }, { value: "<", label: "<" },
    { value: ">=", label: ">=" }, { value: "<=", label: "<=" },
    { value: "between", label: "Between" },
    { value: "isNull", label: "Is Null" }, { value: "isNotNull", label: "Is Not Null" },
  ],
  bool: [
    { value: "isTrue", label: "True" }, { value: "isFalse", label: "False" },
  ],
  date: [
    { value: "before", label: "Before" }, { value: "after", label: "After" },
    { value: "between", label: "Between" }, { value: "onDate", label: "On Date" },
    { value: "isNull", label: "Is Null" }, { value: "isNotNull", label: "Is Not Null" },
  ],
  other: [
    { value: "equals", label: "Equals" }, { value: "notEquals", label: "Not Equals" },
    { value: "isNull", label: "Is Null" }, { value: "isNotNull", label: "Is Not Null" },
  ],
};

export const newId = () => Math.random().toString(36).slice(2, 9);

export function aliasFor(name: string, used: Set<string>): string {
  let base = name.replace(/[^A-Za-z0-9_]/g, "");
  if (!base) base = "T";
  if (!/^[A-Za-z_]/.test(base)) base = `T${base}`;
  let i = 1;
  let alias = `${base}${i}`;
  while (used.has(alias)) alias = `${base}${++i}`;
  return alias;
}

export function cleanAlias(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "");
  if (!cleaned) return "";
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `T${cleaned}`;
}

// ---- Grouping / Aggregation ----
export type Agg = "sum" | "count" | "avg" | "min" | "max";
export const AGG_LABEL: Record<Agg, string> = { sum: "Sum", count: "Count", avg: "Avg", min: "Min", max: "Max" };
export const ALL_AGGS: Agg[] = ["sum", "count", "avg", "min", "max"];

export function calcAgg(rows: Record<string, unknown>[], col: string, agg: Agg): number | string {
  if (agg === "count") return rows.length;
  const nums: number[] = [];
  for (const r of rows) {
    const v = r[col];
    if (v == null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isNaN(n)) nums.push(n);
  }
  if (!nums.length) return "";
  if (agg === "sum") return nums.reduce((a, b) => a + b, 0);
  if (agg === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (agg === "min") return Math.min(...nums);
  if (agg === "max") return Math.max(...nums);
  return "";
}

export function fmtAgg(v: number | string): string {
  if (typeof v !== "number") return String(v);
  if (Number.isInteger(v)) return v.toString();
  return v.toFixed(2);
}

export interface GroupNode {
  key: string;
  label: string;
  path: string;
  rows: Record<string, unknown>[];
  children?: GroupNode[];
}

export function buildGroups(rows: Record<string, unknown>[], keys: string[], parentPath = ""): GroupNode[] {
  if (!keys.length) return [];
  const [head, ...rest] = keys;
  const map = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = r[head] == null ? "(null)" : String(r[head]);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return Array.from(map.entries()).map(([k, grs]) => {
    const path = parentPath ? `${parentPath}▶${head}=${k}` : `${head}=${k}`;
    return {
      key: k,
      label: `${head}: ${k}`,
      path,
      rows: grs,
      children: rest.length ? buildGroups(grs, rest, path) : undefined,
    };
  });
}

// ---- Conditional Formatting ----
export type FmtOp =
  | "=" | "!=" | ">" | "<" | ">=" | "<="
  | "between" | "contains" | "notContains" | "startsWith" | "endsWith"
  | "isNull" | "isNotNull" | "isTrue" | "isFalse";

export const FMT_OPS: { value: FmtOp; label: string; needsValue: boolean; needsValue2?: boolean }[] = [
  { value: "=", label: "=", needsValue: true },
  { value: "!=", label: "≠", needsValue: true },
  { value: ">", label: ">", needsValue: true },
  { value: "<", label: "<", needsValue: true },
  { value: ">=", label: "≥", needsValue: true },
  { value: "<=", label: "≤", needsValue: true },
  { value: "between", label: "Between", needsValue: true, needsValue2: true },
  { value: "contains", label: "Contains", needsValue: true },
  { value: "notContains", label: "Not Contains", needsValue: true },
  { value: "startsWith", label: "Starts With", needsValue: true },
  { value: "endsWith", label: "Ends With", needsValue: true },
  { value: "isNull", label: "Is Null", needsValue: false },
  { value: "isNotNull", label: "Is Not Null", needsValue: false },
  { value: "isTrue", label: "Is True", needsValue: false },
  { value: "isFalse", label: "Is False", needsValue: false },
];

export interface FormatRule {
  id: string;
  column: string;
  op: FmtOp;
  value: string;
  value2: string;
  bg: string;
  fg: string;
  bold: boolean;
}

export const FMT_PRESETS: { label: string; bg: string; fg: string }[] = [
  { label: "None",    bg: "",        fg: "" },
  { label: "Red",     bg: "#fee2e2", fg: "#991b1b" },
  { label: "Amber",   bg: "#fef3c7", fg: "#92400e" },
  { label: "Green",   bg: "#dcfce7", fg: "#166534" },
  { label: "Blue",    bg: "#dbeafe", fg: "#1e40af" },
  { label: "Purple",  bg: "#ede9fe", fg: "#5b21b6" },
  { label: "Slate",   bg: "#e2e8f0", fg: "#1e293b" },
];

export function evalRule(rule: FormatRule, raw: unknown): boolean {
  if (rule.op === "isNull") return raw == null || raw === "";
  if (rule.op === "isNotNull") return !(raw == null || raw === "");
  if (rule.op === "isTrue") return raw === true || raw === 1 || String(raw).toLowerCase() === "true";
  if (rule.op === "isFalse") return raw === false || raw === 0 || String(raw).toLowerCase() === "false";
  if (raw == null) return false;
  const s = String(raw);
  const vs = rule.value ?? "";
  const asNum = (x: unknown) => {
    const n = typeof x === "number" ? x : Number(x);
    return Number.isNaN(n) ? null : n;
  };
  const numMode = asNum(raw) !== null && asNum(vs) !== null;
  switch (rule.op) {
    case "=":  return numMode ? asNum(raw) === asNum(vs) : s === vs;
    case "!=": return numMode ? asNum(raw) !== asNum(vs) : s !== vs;
    case ">":  return numMode ? (asNum(raw)! >  asNum(vs)!) : s >  vs;
    case "<":  return numMode ? (asNum(raw)! <  asNum(vs)!) : s <  vs;
    case ">=": return numMode ? (asNum(raw)! >= asNum(vs)!) : s >= vs;
    case "<=": return numMode ? (asNum(raw)! <= asNum(vs)!) : s <= vs;
    case "between": {
      const a = asNum(vs), b = asNum(rule.value2);
      const n = asNum(raw);
      if (a != null && b != null && n != null) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        return n >= lo && n <= hi;
      }
      return s >= vs && s <= (rule.value2 ?? "");
    }
    case "contains":    return s.toLowerCase().includes(vs.toLowerCase());
    case "notContains": return !s.toLowerCase().includes(vs.toLowerCase());
    case "startsWith":  return s.toLowerCase().startsWith(vs.toLowerCase());
    case "endsWith":    return s.toLowerCase().endsWith(vs.toLowerCase());
  }
  return false;
}

export function styleForCell(
  col: string,
  row: Record<string, unknown>,
  rules: FormatRule[],
): { style: React.CSSProperties; bold: boolean } {
  const style: React.CSSProperties = {};
  let bold = false;
  for (const r of rules) {
    if (r.column !== col) continue;
    if (!evalRule(r, row[col])) continue;
    if (r.bg) style.backgroundColor = r.bg;
    if (r.fg) style.color = r.fg;
    if (r.bold) bold = true;
  }
  return { style, bold };
}

// ---- Calculated Columns (client-side, arithmetic + comparisons) ----
export interface CalcColumn {
  id: string;
  name: string;
  expr: string;
}

type CalcValue = number | string | boolean | null;

export function tokenizeExpr(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "!=" || two === "<=" || two === ">=") {
      out.push(two); i += 2; continue;
    }
    if (ch === "=" || ch === "<" || ch === ">") { out.push(ch); i++; continue; }
    if ("+-*/()".includes(ch)) { out.push(ch); i++; continue; }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push(src.slice(i, j)); i = j; continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1; let s = "";
      while (j < src.length) {
        if (src[j] === quote) {
          if (src[j + 1] === quote) { s += quote; j += 2; continue; }
          break;
        }
        s += src[j]; j++;
      }
      if (j >= src.length) throw new Error(`Unclosed string`);
      out.push("#" + s); i = j + 1; continue;
    }
    if (ch === "[") {
      const end = src.indexOf("]", i + 1);
      if (end < 0) throw new Error("Unclosed [ in expression");
      out.push("$" + src.slice(i + 1, end).trim());
      i = end + 1; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      out.push("$" + src.slice(i, j)); i = j; continue;
    }
    throw new Error(`Unexpected character "${ch}"`);
  }
  return out;
}

const COMPARE_OPS = new Set(["=", "<>", "!=", "<", ">", "<=", ">="]);

function coerceCompare(a: CalcValue, b: CalcValue): [number | string | null, number | string | null] {
  if (a === null || b === null || a === undefined || b === undefined) return [null, null];
  const na = typeof a === "number" ? a : Number(a);
  const nb = typeof b === "number" ? b : Number(b);
  if (typeof a !== "boolean" && typeof b !== "boolean" &&
      Number.isFinite(na) && Number.isFinite(nb) &&
      String(a).trim() !== "" && String(b).trim() !== "") {
    return [na, nb];
  }
  return [String(a), String(b)];
}

function applyCompare(op: string, a: CalcValue, b: CalcValue): boolean | null {
  const [x, y] = coerceCompare(a, b);
  if (x === null || y === null) return null;
  switch (op) {
    case "=": return x === y;
    case "<>":
    case "!=": return x !== y;
    case "<": return x < y;
    case ">": return x > y;
    case "<=": return x <= y;
    case ">=": return x >= y;
  }
  return null;
}

export function evalCalc(expr: string, row: Record<string, unknown>): CalcValue {
  if (!expr.trim()) return null;
  let tokens: string[];
  try { tokens = tokenizeExpr(expr); } catch { return null; }
  if (!tokens.length) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];

  const parseAtom = (): CalcValue => {
    const t = eat();
    if (t === undefined) throw new Error("Unexpected end");
    if (t === "(") {
      const v = parseCompare();
      if (eat() !== ")") throw new Error("Missing )");
      return v;
    }
    if (t === "-") { const v = parseAtom(); return typeof v === "number" ? -v : (v == null ? null : -Number(v)); }
    if (t === "+") return parseAtom();
    if (t.startsWith("$")) {
      const name = t.slice(1);
      if (!(name in row)) return null;
      const raw = row[name];
      if (raw === null || raw === undefined) return null;
      if (typeof raw === "number" || typeof raw === "boolean") return raw;
      return String(raw);
    }
    if (t.startsWith("#")) return t.slice(1);
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(`Bad number: ${t}`);
    return n;
  };
  const parseMulDiv = (): CalcValue => {
    let left = parseAtom();
    while (peek() === "*" || peek() === "/") {
      const op = eat();
      const right = parseAtom();
      const a = Number(left); const b = Number(right);
      if (!Number.isFinite(a) || !Number.isFinite(b)) { left = null; continue; }
      left = op === "*" ? a * b : (b === 0 ? null : a / b);
    }
    return left;
  };
  const parseAddSub = (): CalcValue => {
    let left = parseMulDiv();
    while (peek() === "+" || peek() === "-") {
      const op = eat();
      const right = parseMulDiv();
      const a = Number(left); const b = Number(right);
      if (!Number.isFinite(a) || !Number.isFinite(b)) { left = null; continue; }
      left = op === "+" ? a + b : a - b;
    }
    return left;
  };
  const parseCompare = (): CalcValue => {
    const left = parseAddSub();
    if (peek() && COMPARE_OPS.has(peek())) {
      const op = eat();
      const right = parseAddSub();
      return applyCompare(op, left, right);
    }
    return left;
  };

  try {
    const v = parseCompare();
    if (pos !== tokens.length) return null;
    return v;
  } catch {
    return null;
  }
}

export function validateCalcExpr(expr: string, availableCols: string[]): { ok: boolean; error?: string } {
  if (!expr.trim()) return { ok: false, error: "Empty expression" };
  let tokens: string[];
  try { tokens = tokenizeExpr(expr); } catch (e) { return { ok: false, error: (e as Error).message }; }
  const missing = tokens
    .filter((t) => t.startsWith("$"))
    .map((t) => t.slice(1))
    .filter((n) => !availableCols.includes(n));
  if (missing.length) return { ok: false, error: `Unknown column(s): ${Array.from(new Set(missing)).join(", ")}` };
  const sample: Record<string, unknown> = {};
  for (const c of availableCols) sample[c] = 1;
  try {
    const _ = evalCalc(expr, sample);
    void _;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true };
}

export const SAVED_KEY = "erp.dataExplorer.savedQueries.v1";

export interface SavedQuery {
  name: string;
  spec: import("@/lib/erp/types").DataExplorerSpec;
  savedAt: number;
}

export type _ColumnInfo = ColumnInfo;