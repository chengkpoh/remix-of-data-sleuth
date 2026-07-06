import { useEffect, useMemo, useRef, useState } from "react";
import {
  Play, Save, FolderOpen, Trash2, Download, Copy, Plus, X, Table as TableIcon, Loader2, Link2, Columns, Eye, EyeOff, GripVertical, Layers, Sigma, ChevronRight, ChevronDown, Palette,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { getErp } from "@/lib/erp/client";
import type {
  SchemaSnapshot, TableInfo, ColumnInfo, ForeignKeyInfo,
  DataExplorerSpec, DataExplorerCondition, DataExplorerJoin,
} from "@/lib/erp/types";

type ColCat = "text" | "number" | "bool" | "date" | "other";

const TEXT = new Set(["varchar", "nvarchar", "char", "nchar", "text", "ntext"]);
const NUM  = new Set(["int", "bigint", "smallint", "tinyint", "decimal", "numeric", "money", "smallmoney", "float", "real"]);
const BOOL = new Set(["bit"]);
const DATE = new Set(["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset", "time"]);

function categoryOf(type: string): ColCat {
  const t = (type || "").toLowerCase();
  if (TEXT.has(t)) return "text";
  if (NUM.has(t)) return "number";
  if (BOOL.has(t)) return "bool";
  if (DATE.has(t)) return "date";
  return "other";
}

const OPS: Record<ColCat, { value: string; label: string }[]> = {
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

interface SelectedTable extends TableInfo { alias: string; instanceId: string }
interface UICondition extends DataExplorerCondition { id: string }

const newId = () => Math.random().toString(36).slice(2, 9);

function aliasFor(name: string, used: Set<string>): string {
  let base = name.replace(/[^A-Za-z0-9_]/g, "");
  if (!base) base = "T";
  if (!/^[A-Za-z_]/.test(base)) base = `T${base}`;
  let i = 1;
  let alias = `${base}${i}`;
  while (used.has(alias)) alias = `${base}${++i}`;
  return alias;
}

function cleanAlias(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "");
  if (!cleaned) return "";
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `T${cleaned}`;
}

const SAVED_KEY = "erp.dataExplorer.savedQueries.v1";
interface SavedQuery {
  name: string;
  spec: DataExplorerSpec;
  savedAt: number;
}

// ---- Grouping / Aggregation helpers ----
type Agg = "sum" | "count" | "avg" | "min" | "max";
const AGG_LABEL: Record<Agg, string> = { sum: "Sum", count: "Count", avg: "Avg", min: "Min", max: "Max" };
const ALL_AGGS: Agg[] = ["sum", "count", "avg", "min", "max"];

function calcAgg(rows: Record<string, unknown>[], col: string, agg: Agg): number | string {
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
function fmtAgg(v: number | string): string {
  if (typeof v !== "number") return String(v);
  if (Number.isInteger(v)) return v.toString();
  return v.toFixed(2);
}

interface GroupNode {
  key: string;
  label: string;
  path: string;
  rows: Record<string, unknown>[];
  children?: GroupNode[];
}
function buildGroups(rows: Record<string, unknown>[], keys: string[], parentPath = ""): GroupNode[] {
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
type FmtOp =
  | "=" | "!=" | ">" | "<" | ">=" | "<="
  | "between" | "contains" | "notContains" | "startsWith" | "endsWith"
  | "isNull" | "isNotNull" | "isTrue" | "isFalse";

const FMT_OPS: { value: FmtOp; label: string; needsValue: boolean; needsValue2?: boolean }[] = [
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

interface FormatRule {
  id: string;
  column: string;
  op: FmtOp;
  value: string;
  value2: string;
  bg: string;   // css color or ""
  fg: string;   // css color or ""
  bold: boolean;
}

const FMT_PRESETS: { label: string; bg: string; fg: string }[] = [
  { label: "None",    bg: "",        fg: "" },
  { label: "Red",     bg: "#fee2e2", fg: "#991b1b" },
  { label: "Amber",   bg: "#fef3c7", fg: "#92400e" },
  { label: "Green",   bg: "#dcfce7", fg: "#166534" },
  { label: "Blue",    bg: "#dbeafe", fg: "#1e40af" },
  { label: "Purple",  bg: "#ede9fe", fg: "#5b21b6" },
  { label: "Slate",   bg: "#e2e8f0", fg: "#1e293b" },
];

function evalRule(rule: FormatRule, raw: unknown): boolean {
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

function styleForCell(
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

export function DataExplorer({ schema }: { schema: SchemaSnapshot; dark: boolean }) {
  const [tableSearch, setTableSearch] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [selected, setSelected] = useState<SelectedTable[]>([]);
  const [conditions, setConditions] = useState<UICondition[]>([]);
  const [joins, setJoins] = useState<DataExplorerJoin[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyInfo[]>([]);

  const [queryName, setQueryName] = useState("");
  const [limit, setLimit] = useState(100);

  const [running, setRunning] = useState(false);
  const [resultCols, setResultCols] = useState<string[]>([]);
  const [resultRows, setResultRows] = useState<Record<string, unknown>[]>([]);
  const [colOrder, setColOrder] = useState<string[]>([]);
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const [columnSearch, setColumnSearch] = useState("");
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [columnFilters, setColumnFilters] = useState<Record<string, Set<string>>>({});
const [filterOpen, setFilterOpen] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<string[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [aggregates, setAggregates] = useState<Record<string, Set<Agg>>>({});
  const [formatRules, setFormatRules] = useState<FormatRule[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const dragColRef = useRef<string | null>(null);
  const resizeRef = useRef<{ col: string; startX: number; startW: number } | null>(null);

  const [loadOpen, setLoadOpen] = useState(false);
  const [savedList, setSavedList] = useState<SavedQuery[]>([]);

  // Load FKs once when component mounts (best-effort)
  useEffect(() => {
    const erp = getErp();
    if (!erp?.getForeignKeys) return;
    erp.getForeignKeys().then(setForeignKeys).catch(() => {});
  }, []);

  // Filtered table list (sidebar)
  const filteredTables = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    return schema.tables.filter((t) => {
      if (!showSystem && (t.schema === "sys" || t.schema === "INFORMATION_SCHEMA")) return false;
      if (!q) return true;
      return `${t.schema}.${t.name}`.toLowerCase().includes(q);
    });
  }, [schema.tables, tableSearch, showSystem]);

  const instanceCount = (t: TableInfo) =>
    selected.filter((s) => s.schema === t.schema && s.name === t.name).length;

  const addTableInstance = (t: TableInfo) => {
    setSelected((current) => {
      const used = new Set(current.map((s) => s.alias));
      return [...current, { ...t, alias: aliasFor(t.name, used), instanceId: newId() }];
    });
  };

  const removeInstance = (alias: string) => {
    setSelected((s) => s.filter((x) => x.alias !== alias));
    setJoins((js) => js.filter((j) => j.leftAlias !== alias && j.rightAlias !== alias));
    setConditions((cs) => cs.filter((c) => c.alias !== alias));
  };

  const clearSelectedTables = () => {
    setSelected([]);
    setJoins([]);
    setConditions([]);
  };

  const renameAlias = (oldAlias: string, rawNext: string): boolean => {
    const cleaned = cleanAlias(rawNext);
    if (!cleaned || cleaned === oldAlias) return cleaned === oldAlias;
    if (selected.some((s) => s.alias === cleaned)) {
      toast.error(`Alias "${cleaned}" is already used.`);
      return false;
    }
    setSelected((s) => s.map((x) => (x.alias === oldAlias ? { ...x, alias: cleaned } : x)));
    // Update dependent references (joins & conditions) so nothing breaks.
    setJoins((js) => js.map((j) => ({
      ...j,
      leftAlias: j.leftAlias === oldAlias ? cleaned : j.leftAlias,
      rightAlias: j.rightAlias === oldAlias ? cleaned : j.rightAlias,
    })));
    setConditions((cs) => cs.map((c) => (c.alias === oldAlias ? { ...c, alias: cleaned } : c)));
    return true;
  };

  // Columns for selected tables (with alias prefix)
  const aliasColumns = useMemo(() => {
    const out: { alias: string; column: string; type: string; cat: ColCat; full: string }[] = [];
    for (const t of selected) {
      const cols = schema.columns.filter((c) => c.schema === t.schema && c.table === t.name);
      for (const c of cols) {
        out.push({
          alias: t.alias,
          column: c.column,
          type: c.type,
          cat: categoryOf(c.type),
          full: `${t.alias}.${c.column}`,
        });
      }
    }
    return out;
  }, [selected, schema.columns]);

  const colInfo = (alias: string, column: string) =>
    aliasColumns.find((c) => c.alias === alias && c.column === column);

  // Auto-detect joins when 2+ tables are selected (preserve manual)
  useEffect(() => {
    if (selected.length < 2 || !foreignKeys.length) {
      setJoins((prev) => prev.filter((j) => j.source === "manual"));
      return;
    }
    const detected: DataExplorerJoin[] = [];
    for (let i = 0; i < selected.length - 1; i++) {
      for (let k = i + 1; k < selected.length; k++) {
        const a = selected[i];
        const b = selected[k];
        const aToB = foreignKeys.find(
          (f) => f.parentSchema === a.schema && f.parentTable === a.name && f.refSchema === b.schema && f.refTable === b.name,
        );
        if (aToB) {
          detected.push({
            leftAlias: a.alias,
            leftColumn: aToB.parentColumn,
            rightAlias: b.alias,
            rightColumn: aToB.refColumn,
            joinType: "LEFT",
            source: "auto",
          });
          continue;
        }
        const bToA = foreignKeys.find(
          (f) => f.parentSchema === b.schema && f.parentTable === b.name && f.refSchema === a.schema && f.refTable === a.name,
        );
        if (bToA) {
          detected.push({
            leftAlias: a.alias,
            leftColumn: bToA.refColumn,
            rightAlias: b.alias,
            rightColumn: bToA.parentColumn,
            joinType: "LEFT",
            source: "auto",
          });
        }
      }
    }
    setJoins((prev) => [...detected, ...prev.filter((j) => j.source === "manual")]);
  }, [selected, foreignKeys]);

  const addCondition = () => {
    const first = aliasColumns[0];
    setConditions((c) => [
      ...c,
      {
        id: newId(),
        andOr: c.length === 0 ? "AND" : "AND",
        alias: first?.alias ?? "",
        column: first?.column ?? "",
        operator: first ? OPS[first.cat][0].value : "equals",
        value: "",
      },
    ]);
  };
  const removeCondition = (id: string) =>
    setConditions((c) => c.filter((x) => x.id !== id));
  const updateCondition = (id: string, patch: Partial<UICondition>) =>
    setConditions((c) => c.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const buildSpec = (): DataExplorerSpec => ({
    tables: selected.map((s) => ({ schema: s.schema, name: s.name, alias: s.alias })),
    joins,
    conditions: conditions.map(({ id: _id, ...rest }) => rest),
    limit,
  });

  const runQuery = async () => {
    const erp = getErp();
    if (!erp?.runDataExplorerQuery) {
      toast.error("Data Explorer requires the Electron desktop build.");
      return;
    }
    if (!selected.length) { toast.error("Select at least one table."); return; }
    setRunning(true);
    try {
      const res = await erp.runDataExplorerQuery(buildSpec());
      const cols = res.columns.length
        ? res.columns
        : (res.rows[0] ? Object.keys(res.rows[0]) : []);
      setResultCols(cols);
      setColOrder(cols);
      setHiddenCols(new Set());
      setColWidths({});
      setResultRows(res.rows);
      setPage(1);
      setCollapsedGroups(new Set());
      setGroupBy((g) => g.filter((c) => cols.includes(c)));
      setAggregates((a) => {
        const next: Record<string, Set<Agg>> = {};
        for (const k of Object.keys(a)) if (cols.includes(k)) next[k] = a[k];
        return next;
      });
      setFormatRules((rs) => rs.filter((r) => cols.includes(r.column)));
      toast.success(`${res.rows.length} row(s) in ${res.durationMs}ms`);
    } catch (e) {
      toast.error(`Query failed: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  const clearAll = () => {
    clearSelectedTables();
    setResultCols([]); setResultRows([]); setQueryName("");
  };

  // ---- Save / Load ----
  const loadSaved = (): SavedQuery[] => {
    try { return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"); } catch { return []; }
  };
  const saveQuery = () => {
    const name = queryName.trim();
    if (!name) { toast.error("Enter a query name first."); return; }
    if (!selected.length) { toast.error("Select at least one table."); return; }
    const list = loadSaved().filter((q) => q.name !== name);
    list.push({ name, spec: buildSpec(), savedAt: Date.now() });
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
    toast.success(`Saved "${name}"`);
  };
  const openLoad = () => {
    setSavedList(loadSaved().sort((a, b) => b.savedAt - a.savedAt));
    setLoadOpen(true);
  };
  const applySaved = (q: SavedQuery) => {
    const used = new Set<string>();
    const aliasMap = new Map<string, string>();
    const savedTables: SelectedTable[] = q.spec.tables.map((t) => {
      const requested = cleanAlias(t.alias || t.name);
      const alias = requested && !used.has(requested) ? requested : aliasFor(t.name, used);
      used.add(alias);
      aliasMap.set(t.alias, alias);
      return { schema: t.schema, name: t.name, alias, instanceId: newId() };
    });
    setQueryName(q.name);
    setSelected(savedTables);
    setJoins(q.spec.joins.map((j) => ({
      ...j,
      leftAlias: aliasMap.get(j.leftAlias) || j.leftAlias,
      rightAlias: aliasMap.get(j.rightAlias) || j.rightAlias,
    })));
    setConditions(q.spec.conditions.map((c) => ({
      ...c,
      alias: aliasMap.get(c.alias) || c.alias,
      id: newId(),
    })));
    setLimit(q.spec.limit);
    setLoadOpen(false);
    toast.success(`Loaded "${q.name}"`);
  };
  const deleteSaved = (name: string) => {
    const list = loadSaved().filter((q) => q.name !== name);
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
    setSavedList(list);
  };

  // ---- Results: sort + paginate ----
  const sortedRows = useMemo(() => {
    if (!sortKey) return resultRows;
    const arr = [...resultRows];
    arr.sort((a, b) => {
      const av = a[sortKey] as unknown; const bv = b[sortKey] as unknown;
      if (av == null && bv == null) return 0;
      if (av == null) return -1;
      if (bv == null) return 1;
      if (typeof av === "number" && typeof bv === "number") return sortDir === "asc" ? av - bv : bv - av;
      const as = String(av), bs = String(bv);
      return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return arr;
  }, [resultRows, sortKey, sortDir]);

const filteredRows = useMemo(() => {
  let rows = sortedRows;

  Object.entries(columnFilters).forEach(([col, values]) => {
    if (values.size > 0) {
      rows = rows.filter((r) =>
        values.has(String(r[col] ?? ""))
      );
    }
  });

  return rows;
}, [sortedRows, columnFilters]);


const pageRows = useMemo(() => {
  const start = (page - 1) * pageSize;
  return filteredRows.slice(start, start + pageSize);
}, [filteredRows, page, pageSize]);


const totalPages = Math.max(
  1,
  Math.ceil(filteredRows.length / pageSize)
);

  const exportCSV = () => {
    if (!resultRows.length) { toast.error("Nothing to export."); return; }
    const esc = (v: unknown) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      resultCols.join(","),
      ...resultRows.map((r) => resultCols.map((c) => esc(r[c])).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `data-explorer-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const copyResults = async () => {
    if (!resultRows.length) { toast.error("Nothing to copy."); return; }
    const text = [
      resultCols.join("\t"),
      ...resultRows.map((r) => resultCols.map((c) => (r[c] == null ? "" : String(r[c]))).join("\t")),
    ].join("\n");
    await navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  // ---- Column customization helpers ----
  const getColumnValues = (col:string) => {
  return Array.from(
    new Set(
      resultRows.map(r => String(r[col] ?? ""))
    )
  ).sort();
};
  const hideAllCols = () => {
  setHiddenCols(new Set(resultCols));
};

const showAllCols = () => {
  setHiddenCols(new Set());
};
  const visibleCols = useMemo(
    () => colOrder.filter((c) => !hiddenCols.has(c)),
    [colOrder, hiddenCols],
  );
  const filteredResultCols = useMemo(() => {
  const q = columnSearch.trim().toLowerCase();

  if (!q) return resultCols;

  return resultCols.filter((c) =>
    c.toLowerCase().includes(q)
  );
}, [resultCols, columnSearch]);
  const hideCol = (c: string) => setHiddenCols((s) => new Set(s).add(c));
  const showCol = (c: string) => setHiddenCols((s) => {
    const n = new Set(s); n.delete(c); return n;
  });
  const onHeaderDragStart = (c: string) => (e: React.DragEvent) => {
    dragColRef.current = c;
    e.dataTransfer.effectAllowed = "move";
  };
  const onHeaderDrop = (target: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const src = dragColRef.current;
    dragColRef.current = null;
    if (!src || src === target) return;
    setColOrder((order) => {
      const next = order.filter((x) => x !== src);
      const idx = next.indexOf(target);
      next.splice(idx, 0, src);
      return next;
    });
  };
  const startResize = (c: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startW = colWidths[c] ?? 160;
    resizeRef.current = { col: c, startX: e.clientX, startW };
    const move = (ev: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const w = Math.max(60, r.startW + (ev.clientX - r.startX));
      setColWidths((cw) => ({ ...cw, [r.col]: w }));
    };
    const up = () => {
      resizeRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const toggleGroup = (path: string) =>
    setCollapsedGroups((s) => { const n = new Set(s); if (n.has(path)) n.delete(path); else n.add(path); return n; });

  const summaryCols = useMemo(() => Object.keys(aggregates), [aggregates]);
  const hasSummaries = summaryCols.length > 0;
  const isGrouped = groupBy.length > 0;

  const groupedTree = useMemo(
    () => (isGrouped ? buildGroups(filteredRows, groupBy) : []),
    [isGrouped, filteredRows, groupBy],
  );

  // Render helpers used by the results table when grouping is active.
  const renderGroupFooter = (nodePath: string, rows: Record<string, unknown>[], depth: number, visible: string[]) => (
    <tr key={`gf-${nodePath}`} className="bg-muted/20 border-b border-border">
      {visible.map((c, idx) => {
        const aggs = aggregates[c];
        const parts = aggs ? Array.from(aggs).map((a) => `${AGG_LABEL[a]}: ${fmtAgg(calcAgg(rows, c, a))}`) : [];
        return (
          <td
            key={c}
            style={{ width: colWidths[c] ?? 160, paddingLeft: idx === 0 ? 12 + (depth + 1) * 14 : undefined }}
            className="px-3 py-1 text-[11px] font-medium text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis"
          >
            {idx === 0 && !parts.length ? "Subtotal" : parts.join("  ·  ")}
          </td>
        );
      })}
    </tr>
  );

  const renderNodes = (nodes: GroupNode[], depth: number, visible: string[]): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    for (const node of nodes) {
      const isCollapsed = collapsedGroups.has(node.path);
      out.push(
        <tr key={`gh-${node.path}`} className="bg-muted/40 border-b border-border">
          <td colSpan={visible.length} className="px-3 py-1.5 text-xs" style={{ paddingLeft: 12 + depth * 14 }}>
            <button
              onClick={() => toggleGroup(node.path)}
              className="flex items-center gap-1 font-semibold text-foreground hover:text-primary"
            >
              {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              <span className="font-mono">{node.label}</span>
              <Badge variant="secondary" className="ml-1.5 text-[10px]">{node.rows.length}</Badge>
            </button>
          </td>
        </tr>,
      );
      if (isCollapsed) continue;
      if (node.children && node.children.length) {
        out.push(...renderNodes(node.children, depth + 1, visible));
      } else {
        node.rows.forEach((r, i) => {
          out.push(
            <tr key={`gr-${node.path}-${i}`} className="border-b border-border/50 hover:bg-accent/30">
              {visible.map((c, idx) => {
                const fmt = styleForCell(c, r, formatRules);
                return (
                  <td
                    key={c}
                    style={{ width: colWidths[c] ?? 160, paddingLeft: idx === 0 ? 12 + (depth + 1) * 14 : undefined, ...fmt.style }}
                    className={`px-3 py-1.5 font-mono whitespace-nowrap overflow-hidden text-ellipsis ${fmt.bold ? "font-bold" : ""}`}
                  >
                    {r[c] == null ? <span className="text-muted-foreground italic">NULL</span> : String(r[c])}
                  </td>
                );
              })}
            </tr>,
          );
        });
      }
      if (hasSummaries) out.push(renderGroupFooter(node.path, node.rows, depth, visible));
    }
    return out;
  };

  // ===== render =====
  return (
    <div className="grid grid-cols-[360px_1fr] min-h-[calc(100vh-49px)]">
      {/* ---------- Sidebar ---------- */}
      <aside className="flex flex-col border-r border-border bg-card/30">
        <div className="border-b border-border p-3">
          <Label className="mb-1.5 block text-xs font-medium text-muted-foreground">Database</Label>
          <div className="rounded-md border border-border bg-background/60 px-2.5 py-2 text-xs font-mono">
            {schema.tables[0]?.schema ? "Connected DB" : "—"}
          </div>
        </div>
        <div className="border-b border-border p-3">
          <div className="relative">
            <Input
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              placeholder="Search tables…"
              className="h-8 text-xs"
            />
          </div>
          <label className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <Checkbox checked={showSystem} onCheckedChange={(v) => setShowSystem(!!v)} />
            Show system tables
          </label>
        </div>
        <div className="flex-1 overflow-hidden">
          <Label className="block px-3 pt-2 text-xs font-medium text-muted-foreground">Add Tables</Label>
          <ScrollArea className="h-[calc(100vh-380px)] px-1">
            <div className="p-1">
              {filteredTables.map((t) => {
                const count = instanceCount(t);
                return (
                  <div
                    key={`${t.schema}.${t.name}`}
                    className="group flex w-full items-center gap-1 rounded border border-transparent px-2 py-1.5 text-xs hover:border-border hover:bg-accent"
                  >
                    <TableIcon className="h-3 w-3 text-muted-foreground" />
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="truncate font-mono"title={t.name}>{t.name}</div>
                      <div className="truncate text-[10px] text-muted-foreground">{t.schema}</div>
                    </div>
                    {count > 0 && (
                      <Badge variant="secondary" className="h-4 px-1 text-[10px]">×{count}</Badge>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => addTableInstance(t)}
                      className="h-6 w-6 shrink-0 p-0"
                    >
                      <Plus className="h-3 w-3" /> 
                    </Button>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>
        <div className="border-t border-border p-3">
          <div className="mb-2 flex items-center justify-between">
            <Label className="text-xs font-medium">Selected Tables ({selected.length})</Label>
            {selected.length > 0 && (
              <button onClick={clearSelectedTables} className="text-[11px] text-primary hover:underline">
                Clear All
              </button>
            )}
          </div>
          <div className="space-y-1.5 max-h-48 overflow-auto">
            {selected.map((t) => (
              <div key={t.instanceId} className="rounded border border-border bg-background/60 px-2 py-1.5 text-xs">
                <div className="mb-1 flex items-center gap-1.5">
                  <TableIcon className="h-3 w-3 text-muted-foreground" />
                  <span className="truncate font-mono font-medium flex-1" title={`${t.schema}.${t.name}`}>{t.name}</span>
                  <button onClick={() => removeInstance(t.alias)} className="text-muted-foreground hover:text-destructive" title="Remove instance">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">Alias</span>
                  <Input
                    key={t.alias}
                    defaultValue={t.alias}
                    onBlur={(e) => {
                      if (!renameAlias(t.alias, e.target.value)) e.currentTarget.value = t.alias;
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    className="h-6 flex-1 px-1.5 py-0 text-xs font-mono"
                  />
                </div>
              </div>
            ))}
            {!selected.length && (
              <div className="text-[11px] text-muted-foreground italic">No tables selected</div>
            )}
          </div>
        </div>
      </aside>


      {/* ---------- Main ---------- */}
      <main className="flex flex-col min-w-0">
        {/* Header: Query Builder toolbar */}
        <div className="border-b border-border bg-card/30 px-4 py-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="mr-3 text-sm font-semibold">Query Builder</h2>
            <div className="flex flex-1 items-center gap-2 min-w-[260px]">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Query name (optional)</Label>
              <Input
                value={queryName}
                onChange={(e) => setQueryName(e.target.value)}
                placeholder="Enter query name…"
                className="h-8 text-xs max-w-sm"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Button onClick={runQuery} disabled={running} size="sm">
                {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                Run Query
              </Button>
              <Button variant="outline" size="sm" onClick={saveQuery}>
                <Save className="mr-1.5 h-3.5 w-3.5" /> Save Query
              </Button>
              <Button variant="outline" size="sm" onClick={openLoad}>
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" /> Load Query
              </Button>
              <Button variant="outline" size="sm" onClick={clearAll}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Clear
              </Button>
            </div>
          </div>

          {/* Conditions grid */}
          <div className="rounded-md border border-border bg-background/60">
            <div className="grid grid-cols-[80px_100px_1fr_180px_1fr_70px_60px] items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-medium uppercase text-muted-foreground">
              <div /><div>And/Or</div><div>Field</div><div>Operator</div><div>Value</div><div className="text-center">( Group )</div><div className="text-right">Actions</div>
            </div>
            <div className="divide-y divide-border">
              {conditions.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No conditions. Click "Add new condition" below to start.
                </div>
              )}
              {conditions.map((c, i) => {
                const ci = colInfo(c.alias, c.column);
                const cat: ColCat = ci?.cat ?? "other";
                const ops = OPS[cat];
                const needsValue = !["isTrue", "isFalse", "isNull", "isNotNull"].includes(c.operator);
                const needsValue2 = c.operator === "between";
                const inputType =
                  cat === "number" ? "number" :
                  cat === "date" ? (c.operator === "onDate" || ["before", "after"].includes(c.operator) ? "date" : "date") :
                  "text";
                return (
                  <div key={c.id} className="grid grid-cols-[80px_100px_1fr_180px_1fr_70px_60px] items-center gap-2 px-3 py-1.5 text-xs">
                    <div className="flex items-center gap-1">
                      <button onClick={addCondition} className="text-emerald-500 hover:text-emerald-400"><Plus className="h-3.5 w-3.5" /></button>
                      <button onClick={() => removeCondition(c.id)} className="text-destructive hover:opacity-80"><X className="h-3.5 w-3.5" /></button>
                    </div>
                    {i === 0 ? (
                      <div className="text-muted-foreground" />
                    ) : (
                      <Select value={c.andOr} onValueChange={(v) => updateCondition(c.id, { andOr: v as "AND" | "OR" })}>
                        <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="AND">And</SelectItem>
                          <SelectItem value="OR">Or</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    <Select
                      value={c.alias && c.column ? `${c.alias}|${c.column}` : ""}
                      onValueChange={(v) => {
                        const [alias, column] = v.split("|");
                        const info = colInfo(alias, column);
                        const firstOp = info ? OPS[info.cat][0].value : "equals";
                        updateCondition(c.id, { alias, column, operator: firstOp, value: "" });
                      }}
                    >
                      <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Select field…" /></SelectTrigger>
                      <SelectContent>
                        {aliasColumns.map((ac) => (
                          <SelectItem key={ac.full} value={`${ac.alias}|${ac.column}`}>
                            <span className="font-mono">{ac.full}</span>
                            <span className="ml-2 text-[10px] text-muted-foreground">{ac.type}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={c.operator} onValueChange={(v) => updateCondition(c.id, { operator: v })}>
                      <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ops.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-1">
                      {cat === "bool" || !needsValue ? (
                        <span className="text-[11px] text-muted-foreground italic">—</span>
                      ) : (
                        <>
                          <Input
                            type={inputType}
                            value={String(c.value ?? "")}
                            onChange={(e) => updateCondition(c.id, { value: e.target.value })}
                            className="h-7 text-xs"
                          />
                          {needsValue2 && (
                            <Input
                              type={inputType}
                              value={String(c.value2 ?? "")}
                              onChange={(e) => updateCondition(c.id, { value2: e.target.value })}
                              className="h-7 text-xs"
                              placeholder="and"
                            />
                          )}
                        </>
                      )}
                    </div>
                    <div className="flex items-center justify-center gap-1">
                      <button
                        onClick={() => updateCondition(c.id, { groupOpen: !c.groupOpen })}
                        className={`rounded px-1 text-[11px] ${c.groupOpen ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      >(</button>
                      <button
                        onClick={() => updateCondition(c.id, { groupClose: !c.groupClose })}
                        className={`rounded px-1 text-[11px] ${c.groupClose ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      >)</button>
                    </div>
                    <div className="text-right">
                      <button onClick={() => removeCondition(c.id)} className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-border px-3 py-1.5">
              <button onClick={addCondition} disabled={!selected.length} className="flex items-center gap-1 text-xs text-emerald-500 hover:text-emerald-400 disabled:opacity-50">
                <Plus className="h-3.5 w-3.5" /> Add new condition
              </button>
            </div>
          </div>

          {/* Join builder */}
          {selected.length >= 1 && (
            <div className="mt-3 rounded-md border border-border bg-background/60 p-3">
              <div className="mb-2 flex items-center gap-2">
                <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">Join Builder</span>
                <Badge variant="outline" className="text-[10px]">Auto Detect Joins</Badge>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7 text-xs"
                  disabled={selected.length < 2}
                  onClick={() => {
                    const l = selected[0], r = selected[1];
                    if (!l || !r) return;
                    setJoins((js) => [
                      ...js,
                      {
                        leftAlias: l.alias, leftColumn: "",
                        rightAlias: r.alias, rightColumn: "",
                        joinType: "INNER", source: "manual",
                      },
                    ]);
                  }}
                >
                  <Plus className="mr-1 h-3 w-3" /> Add Manual Join
                </Button>
              </div>
              {joins.length === 0 && (
                <div className="text-[11px] text-muted-foreground italic">
                  No joins yet. Auto-detected joins appear here when tables share foreign keys.
                </div>
              )}
              <div className="space-y-1.5">
                {joins.map((j, i) => {
                  const isManual = j.source === "manual";
                  const leftCols = aliasColumns.filter((c) => c.alias === j.leftAlias);
                  const rightCols = aliasColumns.filter((c) => c.alias === j.rightAlias);
                  const patch = (p: Partial<DataExplorerJoin>) =>
                    setJoins((js) => js.map((x, idx) => (idx === i ? { ...x, ...p } : x)));
                  return (
                    <div key={i} className="flex flex-wrap items-center gap-1.5 rounded border border-border/60 bg-background/40 px-2 py-1.5 text-xs">
                      <Badge variant={isManual ? "default" : "secondary"} className="text-[10px]">
                        {isManual ? "MANUAL" : "AUTO"}
                      </Badge>
                      {isManual ? (
                        <>
                          <Select value={j.leftAlias} onValueChange={(v) => patch({ leftAlias: v, leftColumn: "" })}>
                            <SelectTrigger className="h-7 w-[90px] text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {selected.map((s) => (
                                <SelectItem key={s.alias} value={s.alias}>{s.alias}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select value={j.leftColumn} onValueChange={(v) => patch({ leftColumn: v })}>
                            <SelectTrigger className="h-7 w-[140px] text-xs"><SelectValue placeholder="col" /></SelectTrigger>
                            <SelectContent>
                              {leftCols.map((c) => (
                                <SelectItem key={c.column} value={c.column}>{c.column}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select value={j.joinType || "INNER"} onValueChange={(v) => patch({ joinType: v as DataExplorerJoin["joinType"] })}>
                            <SelectTrigger className="h-7 w-[110px] text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="INNER">INNER JOIN</SelectItem>
                              <SelectItem value="LEFT">LEFT JOIN</SelectItem>
                              <SelectItem value="RIGHT">RIGHT JOIN</SelectItem>
                              <SelectItem value="FULL">FULL OUTER</SelectItem>
                              <SelectItem value="CROSS">CROSS JOIN</SelectItem>
                            </SelectContent>
                          </Select>
                          <Select value={j.rightAlias} onValueChange={(v) => patch({ rightAlias: v, rightColumn: "" })}>
                            <SelectTrigger className="h-7 w-[90px] text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {selected.map((s) => (
                                <SelectItem key={s.alias} value={s.alias}>{s.alias}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {j.joinType !== "CROSS" && (
                            <Select value={j.rightColumn} onValueChange={(v) => patch({ rightColumn: v })}>
                              <SelectTrigger className="h-7 w-[140px] text-xs"><SelectValue placeholder="col" /></SelectTrigger>
                              <SelectContent>
                                {rightCols.map((c) => (
                                  <SelectItem key={c.column} value={c.column}>{c.column}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </>
                      ) : (
                        <>
                          <Badge variant="secondary" className="font-mono">{j.leftAlias}.{j.leftColumn}</Badge>
                          <Select value={j.joinType || "LEFT"} onValueChange={(v) => patch({ joinType: v as DataExplorerJoin["joinType"] })}>
                            <SelectTrigger className="h-7 w-[110px] text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="INNER">INNER JOIN</SelectItem>
                              <SelectItem value="LEFT">LEFT JOIN</SelectItem>
                              <SelectItem value="RIGHT">RIGHT JOIN</SelectItem>
                              <SelectItem value="FULL">FULL OUTER</SelectItem>
                            </SelectContent>
                          </Select>
                          <Badge variant="secondary" className="font-mono">{j.rightAlias}.{j.rightColumn}</Badge>
                        </>
                      )}
                      <button
                        onClick={() => setJoins((js) => js.filter((_, idx) => idx !== i))}
                        className="ml-auto text-muted-foreground hover:text-destructive"
                        title="Delete join"
                      ><X className="h-3.5 w-3.5" /></button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>


        {/* Results */}
        <div className="flex items-center justify-between border-b border-border bg-background px-4 py-2 text-xs">
          <div className="flex items-center gap-3">
            <span className="font-semibold">Results</span>
            <Button variant="ghost" size="sm" onClick={exportCSV} disabled={!resultRows.length}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export
            </Button>
            <Button variant="ghost" size="sm" onClick={copyResults} disabled={!resultRows.length}>
              <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy
            </Button>

            {/* Group By */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" disabled={!resultCols.length}>
                  <Layers className="mr-1.5 h-3.5 w-3.5" /> Group By
                  {groupBy.length > 0 && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">{groupBy.length}</Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-2">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold">Group by columns (in order)</span>
                  {groupBy.length > 0 && (
                    <button className="text-[11px] text-primary hover:underline" onClick={() => setGroupBy([])}>Clear</button>
                  )}
                </div>
                {groupBy.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {groupBy.map((c, i) => (
                      <div key={c} className="flex items-center gap-1 rounded border border-border bg-background/60 px-2 py-1 text-xs">
                        <span className="w-4 text-[10px] text-muted-foreground">{i + 1}.</span>
                        <span className="flex-1 truncate font-mono">{c}</span>
                        <button
                          disabled={i === 0}
                          onClick={() => setGroupBy((g) => { const n = [...g]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                          title="Move up"
                        >↑</button>
                        <button
                          disabled={i === groupBy.length - 1}
                          onClick={() => setGroupBy((g) => { const n = [...g]; [n[i], n[i + 1]] = [n[i + 1], n[i]]; return n; })}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                          title="Move down"
                        >↓</button>
                        <button onClick={() => setGroupBy((g) => g.filter((x) => x !== c))} className="text-muted-foreground hover:text-destructive">
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <Select value="" onValueChange={(v) => setGroupBy((g) => (g.includes(v) ? g : [...g, v]))}>
                  <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Add column…" /></SelectTrigger>
                  <SelectContent>
                    {resultCols.filter((c) => !groupBy.includes(c)).map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="mt-2 text-[10px] text-muted-foreground">
                  Group headers are collapsible. Group footers show summaries configured under "Summaries".
                </div>
              </PopoverContent>
            </Popover>

            {/* Summaries */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" disabled={!resultCols.length}>
                  <Sigma className="mr-1.5 h-3.5 w-3.5" /> Summaries
                  {Object.keys(aggregates).length > 0 && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">{Object.keys(aggregates).length}</Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 p-2">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold">Column summaries</span>
                  {Object.keys(aggregates).length > 0 && (
                    <button className="text-[11px] text-primary hover:underline" onClick={() => setAggregates({})}>Clear all</button>
                  )}
                </div>
                <div className="mb-2 text-[10px] text-muted-foreground">
                  Applied to each group footer and the grand total footer.
                </div>
                <ScrollArea className="h-64">
                  <div className="space-y-1.5 pr-2">
                    {resultCols.map((c) => {
                      const set = aggregates[c] ?? new Set<Agg>();
                      return (
                        <div key={c} className="rounded border border-border/60 bg-background/40 px-2 py-1.5">
                          <div className="mb-1 truncate font-mono text-[11px]">{c}</div>
                          <div className="flex flex-wrap gap-1">
                            {ALL_AGGS.map((a) => {
                              const on = set.has(a);
                              return (
                                <button
                                  key={a}
                                  onClick={() => setAggregates((prev) => {
                                    const cur = new Set(prev[c] ?? []);
                                    if (on) cur.delete(a); else cur.add(a);
                                    const next = { ...prev };
                                    if (cur.size) next[c] = cur; else delete next[c];
                                    return next;
                                  })}
                                  className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
                                >{AGG_LABEL[a]}</button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              </PopoverContent>
            </Popover>

            {/* Conditional Formatting */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" disabled={!resultCols.length}>
                  <Palette className="mr-1.5 h-3.5 w-3.5" /> Format
                  {formatRules.length > 0 && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">{formatRules.length}</Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[420px] p-2">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold">Conditional Formatting</span>
                  <div className="flex items-center gap-2">
                    {formatRules.length > 0 && (
                      <button className="text-[11px] text-primary hover:underline" onClick={() => setFormatRules([])}>Clear all</button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[11px]"
                      onClick={() => setFormatRules((rs) => [
                        ...rs,
                        {
                          id: newId(),
                          column: resultCols[0] ?? "",
                          op: ">",
                          value: "",
                          value2: "",
                          bg: FMT_PRESETS[3].bg,
                          fg: FMT_PRESETS[3].fg,
                          bold: false,
                        },
                      ])}
                    >
                      <Plus className="mr-1 h-3 w-3" /> Add rule
                    </Button>
                  </div>
                </div>
                <div className="mb-2 text-[10px] text-muted-foreground">
                  Rules highlight matching cells. Later rules override earlier ones. Client-side only.
                </div>
                <ScrollArea className="max-h-[360px]">
                  <div className="space-y-2 pr-2">
                    {formatRules.length === 0 && (
                      <div className="rounded border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
                        No rules yet. Click "Add rule" to highlight cells by condition.
                      </div>
                    )}
                    {formatRules.map((r) => {
                      const opDef = FMT_OPS.find((o) => o.value === r.op) ?? FMT_OPS[0];
                      const patch = (p: Partial<FormatRule>) =>
                        setFormatRules((all) => all.map((x) => (x.id === r.id ? { ...x, ...p } : x)));
                      const currentPresetIdx = FMT_PRESETS.findIndex((p) => p.bg === r.bg && p.fg === r.fg);
                      return (
                        <div key={r.id} className="rounded border border-border/60 bg-background/40 p-2">
                          <div className="mb-1.5 grid grid-cols-[1fr_120px_24px] items-center gap-1.5">
                            <Select value={r.column} onValueChange={(v) => patch({ column: v })}>
                              <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Column" /></SelectTrigger>
                              <SelectContent>
                                {resultCols.map((c) => (
                                  <SelectItem key={c} value={c}>{c}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Select value={r.op} onValueChange={(v) => patch({ op: v as FmtOp })}>
                              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {FMT_OPS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            <button
                              onClick={() => setFormatRules((all) => all.filter((x) => x.id !== r.id))}
                              className="text-muted-foreground hover:text-destructive"
                              title="Delete rule"
                            ><X className="h-3.5 w-3.5" /></button>
                          </div>
                          {opDef.needsValue && (
                            <div className="mb-1.5 flex items-center gap-1.5">
                              <Input
                                value={r.value}
                                onChange={(e) => patch({ value: e.target.value })}
                                placeholder="Value"
                                className="h-7 flex-1 text-xs"
                              />
                              {opDef.needsValue2 && (
                                <Input
                                  value={r.value2}
                                  onChange={(e) => patch({ value2: e.target.value })}
                                  placeholder="and"
                                  className="h-7 flex-1 text-xs"
                                />
                              )}
                            </div>
                          )}
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-muted-foreground">Style</span>
                            <div className="flex flex-wrap gap-1">
                              {FMT_PRESETS.map((p, idx) => {
                                const active = idx === currentPresetIdx;
                                return (
                                  <button
                                    key={p.label}
                                    onClick={() => patch({ bg: p.bg, fg: p.fg })}
                                    title={p.label}
                                    className={`h-5 w-8 rounded border text-[9px] font-semibold ${active ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : "border-border"}`}
                                    style={{ background: p.bg || "transparent", color: p.fg || undefined }}
                                  >{p.label === "None" ? "—" : "Aa"}</button>
                                );
                              })}
                            </div>
                            <label className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
                              <Checkbox checked={r.bold} onCheckedChange={(v) => patch({ bold: !!v })} />
                              Bold
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              </PopoverContent>
            </Popover>



            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" disabled={!resultCols.length}>
                  <Columns className="mr-1.5 h-3.5 w-3.5" /> Columns
                  {hiddenCols.size > 0 && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">{hiddenCols.size} hidden</Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-2">
<div className="mb-2">

  <div className="mb-2 flex items-center justify-between">
    <span className="text-xs font-semibold">
      Column Chooser
    </span>

    <button
      className="text-[11px] text-primary hover:underline"
      onClick={() => {
        setHiddenCols(new Set());
        setColOrder(resultCols);
        setColumnSearch("");
      }}
    >
      Reset
    </button>
  </div>


  <Input
    value={columnSearch}
    onChange={(e) => setColumnSearch(e.target.value)}
    placeholder="Search columns..."
    className="h-7 text-xs mb-2"
  />


  <div className="flex gap-1">
    <Button
      size="sm"
      variant="outline"
      className="h-6 text-[11px]"
      onClick={hideAllCols}
    >
      Hide All
    </Button>

    <Button
      size="sm"
      variant="outline"
      className="h-6 text-[11px]"
      onClick={showAllCols}
    >
      Show All
    </Button>
  </div>
</div>
                <ScrollArea className="h-64">
                  <div className="space-y-1">
                    {filteredResultCols.map((c) => {
                      const hidden = hiddenCols.has(c);
                      return (
                        <div
                          key={c}
                          className="flex items-center justify-between gap-2 rounded border border-border/50 bg-background/60 px-2 py-1 text-xs"
                          draggable={hidden}
                          onDragStart={hidden ? onHeaderDragStart(c) : undefined}
                        >
                          <span className="truncate font-mono">{c}</span>
                          <button
                            onClick={() => (hidden ? showCol(c) : hideCol(c))}
                            className="text-muted-foreground hover:text-foreground"
                            title={hidden ? "Show column" : "Hide column"}
                          >
                            {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
                <div className="mt-2 text-[10px] text-muted-foreground">
                  Drag hidden columns onto a grid header to restore. Drag grid headers to reorder.
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>Show</span>
            <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}>
              <SelectTrigger className="h-7 w-[80px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[25, 50, 100, 250, 500].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
              </SelectContent>
            </Select>
            <span>rows</span>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {resultRows.length === 0 ? (
            <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
              No results yet — build conditions and click "Run Query".
            </div>
          ) : (
            <table className="w-full border-collapse text-xs" style={{ tableLayout: "fixed" }}>
              <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                <tr className="border-b border-border text-left">
                  {visibleCols.map((c) => (
                    <th
                      key={c}
                      draggable
                      onDragStart={onHeaderDragStart(c)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={onHeaderDrop(c)}
                      style={{ width: colWidths[c] ?? 160, position: "relative" }}
                      className="group px-3 py-2 font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground select-none"
                    >
                      <div className="flex items-center gap-1">
                        <GripVertical className="h-3 w-3 opacity-40 group-hover:opacity-100 cursor-grab" />
                        <button
className="flex-1 text-left"
onClick={() => {
 if (sortKey === c)
   setSortDir(d=>d==="asc"?"desc":"asc");
 else {
   setSortKey(c);
   setSortDir("asc");
 }
}}
>
{c}
</button>
                        <Popover
open={filterOpen===c}
onOpenChange={(v)=>setFilterOpen(v?c:null)}
>

<PopoverTrigger asChild>

<button
className="text-muted-foreground hover:text-primary"
>
▼
</button>

</PopoverTrigger>


<PopoverContent
className="w-48 p-2"
>

<div className="max-h-60 overflow-auto">

{
getColumnValues(c).map(v=>{

const checked =
columnFilters[c]?.has(v) ?? true;


return (

<label
key={v}
className="flex gap-2 text-xs"
>

<Checkbox

checked={checked}

onCheckedChange={(x)=>{

setColumnFilters(prev=>{

const next =
new Set(
 prev[c] ??
 getColumnValues(c)
);


if(x)
 next.add(v);
else
 next.delete(v);


return {
 ...prev,
 [c]:next
};

});

}}

 />

<span>{v}</span>


</label>

)

})
}

</div>


<Button

size="sm"

className="mt-2 w-full"

onClick={()=>setFilterOpen(null)}

>
Apply
</Button>


</PopoverContent>

</Popover>


</div>
                      <span
                        onMouseDown={startResize(c)}
                        className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/40"
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isGrouped
                  ? renderNodes(groupedTree, 0, visibleCols)
                  : pageRows.map((r, i) => (
                      <tr key={i} className="border-b border-border/50 hover:bg-accent/30">
                        {visibleCols.map((c) => {
                          const fmt = styleForCell(c, r, formatRules);
                          return (
                            <td
                              key={c}
                              style={{ width: colWidths[c] ?? 160, ...fmt.style }}
                              className={`px-3 py-1.5 font-mono whitespace-nowrap overflow-hidden text-ellipsis ${fmt.bold ? "font-bold" : ""}`}
                            >
                              {r[c] == null ? <span className="text-muted-foreground italic">NULL</span> : String(r[c])}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
              </tbody>
              {hasSummaries && (
                <tfoot className="sticky bottom-0 z-10 bg-card/95 backdrop-blur">
                  <tr className="border-t-2 border-border font-semibold">
                    {visibleCols.map((c, idx) => {
                      const aggs = aggregates[c];
                      const parts = aggs
                        ? Array.from(aggs).map((a) => `${AGG_LABEL[a]}: ${fmtAgg(calcAgg(filteredRows, c, a))}`)
                        : [];
                      return (
                        <td
                          key={c}
                          style={{ width: colWidths[c] ?? 160 }}
                          className="px-3 py-1.5 text-[11px] whitespace-nowrap overflow-hidden text-ellipsis"
                        >
                          {idx === 0 && !parts.length ? "Grand Total" : parts.join("  ·  ")}
                        </td>
                      );
                    })}
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>


        {resultRows.length > 0 && (
          <div className="flex items-center justify-between border-t border-border bg-card/30 px-4 py-2 text-xs">
            <span className="text-muted-foreground">
              Total rows: {resultRows.length}
              {isGrouped && <> · Grouped by {groupBy.join(" → ")}</>}
            </span>
            {!isGrouped && (
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹</Button>
                <span className="px-2">{page} / {totalPages}</span>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>›</Button>
              </div>
            )}
          </div>
        )}

      </main>

      {/* Load dialog */}
      <Dialog open={loadOpen} onOpenChange={setLoadOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Saved Queries</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto">
            {savedList.length === 0 && (
              <div className="py-6 text-center text-sm text-muted-foreground">No saved queries.</div>
            )}
            {savedList.map((q) => (
              <div key={q.name} className="flex items-center justify-between rounded border border-border bg-background/60 px-3 py-2 mb-1.5">
                <div>
                  <div className="text-sm font-medium">{q.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {q.spec.tables.length} table(s), {q.spec.conditions.length} condition(s) ·{" "}
                    {new Date(q.savedAt).toLocaleString()}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" onClick={() => applySaved(q)}>Load</Button>
                  <Button size="sm" variant="outline" onClick={() => deleteSaved(q.name)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLoadOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Unused import guard so eslint doesn't complain about ColumnInfo type.
export type _ColumnInfo = ColumnInfo;
