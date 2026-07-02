import { useEffect, useMemo, useRef, useState } from "react";
import {
  Play, Save, FolderOpen, Trash2, Download, Copy, Plus, X, Table as TableIcon, Loader2, Link2, Columns, Eye, EyeOff, GripVertical,
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
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
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

  const renameAlias = (oldAlias: string, rawNext: string) => {
    const cleaned = cleanAlias(rawNext);
    if (!cleaned || cleaned === oldAlias) return;
    if (selected.some((s) => s.alias === cleaned)) {
      toast.error(`Alias "${cleaned}" is already used.`);
      return;
    }
    setSelected((s) => s.map((x) => (x.alias === oldAlias ? { ...x, alias: cleaned } : x)));
    // Update dependent references (joins & conditions) so nothing breaks.
    setJoins((js) => js.map((j) => ({
      ...j,
      leftAlias: j.leftAlias === oldAlias ? cleaned : j.leftAlias,
      rightAlias: j.rightAlias === oldAlias ? cleaned : j.rightAlias,
    })));
    setConditions((cs) => cs.map((c) => (c.alias === oldAlias ? { ...c, alias: cleaned } : c)));
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
    for (const a of selected) {
      for (const b of selected) {
        if (a.alias === b.alias) continue;
        const fk = foreignKeys.find(
          (f) =>
            f.parentSchema === a.schema && f.parentTable === a.name &&
            f.refSchema === b.schema && f.refTable === b.name,
        );
        if (fk) {
          const exists = detected.some(
            (d) =>
              (d.leftAlias === a.alias && d.rightAlias === b.alias) ||
              (d.leftAlias === b.alias && d.rightAlias === a.alias),
          );
          if (!exists) detected.push({
            leftAlias: a.alias, leftColumn: fk.parentColumn,
            rightAlias: b.alias, rightColumn: fk.refColumn,
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
    const savedTables: SelectedTable[] = q.spec.tables.map((t) => {
      const requested = cleanAlias(t.alias || t.name);
      const alias = requested && !used.has(requested) ? requested : aliasFor(t.name, used);
      used.add(alias);
      return { schema: t.schema, name: t.name, alias, instanceId: newId() };
    });
    setQueryName(q.name);
    setSelected(savedTables);
    setJoins(q.spec.joins);
    setConditions(q.spec.conditions.map((c) => ({ ...c, id: newId() })));
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

  const pageRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sortedRows.slice(start, start + pageSize);
  }, [sortedRows, page, pageSize]);
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));

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
  const visibleCols = useMemo(
    () => colOrder.filter((c) => !hiddenCols.has(c)),
    [colOrder, hiddenCols],
  );
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

  // ===== render =====
  return (
    <div className="grid grid-cols-[280px_1fr] min-h-[calc(100vh-49px)]">
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
          <Label className="block px-3 pt-2 text-xs font-medium text-muted-foreground">Tables</Label>
          <ScrollArea className="h-[calc(100vh-380px)] px-1">
            <div className="p-1">
              {filteredTables.map((t) => {
                const count = instanceCount(t);
                return (
                  <div
                    key={`${t.schema}.${t.name}`}
                    className="group flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
                  >
                    <TableIcon className="h-3 w-3 text-muted-foreground" />
                    <span className="flex-1 truncate font-mono">{t.name}</span>
                    {count > 0 && (
                      <Badge variant="secondary" className="h-4 px-1 text-[10px]">×{count}</Badge>
                    )}
                    <button
                      onClick={() => addTableInstance(t)}
                      className="rounded p-0.5 text-emerald-500 opacity-0 hover:bg-emerald-500/10 group-hover:opacity-100"
                      title="Add instance"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
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
              <button onClick={() => setSelected([])} className="text-[11px] text-primary hover:underline">
                Clear All
              </button>
            )}
          </div>
          <div className="space-y-1 max-h-40 overflow-auto">
            {selected.map((t) => (
              <div key={t.alias} className="flex items-center gap-1.5 rounded border border-border bg-background/60 px-2 py-1 text-xs">
                <span className="truncate font-mono flex-1" title={`${t.schema}.${t.name}`}>{t.name}</span>
                <span className="text-muted-foreground">as</span>
                <Input
                  defaultValue={t.alias}
                  onBlur={(e) => renameAlias(t.alias, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  className="h-6 w-16 px-1 py-0 text-xs font-mono"
                />
                <button onClick={() => removeInstance(t.alias)} className="text-muted-foreground hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
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
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold">Column Chooser</span>
                  <button
                    className="text-[11px] text-primary hover:underline"
                    onClick={() => { setHiddenCols(new Set()); setColOrder(resultCols); }}
                  >Reset</button>
                </div>
                <ScrollArea className="max-h-64">
                  <div className="space-y-1">
                    {resultCols.map((c) => {
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
                            if (sortKey === c) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                            else { setSortKey(c); setSortDir("asc"); }
                          }}
                        >
                          {c}{sortKey === c ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                        </button>
                        <button
                          onClick={() => hideCol(c)}
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                          title="Hide column"
                        >
                          <EyeOff className="h-3 w-3" />
                        </button>
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
                {pageRows.map((r, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-accent/30">
                    {visibleCols.map((c) => (
                      <td
                        key={c}
                        style={{ width: colWidths[c] ?? 160 }}
                        className="px-3 py-1.5 font-mono whitespace-nowrap overflow-hidden text-ellipsis"
                      >
                        {r[c] == null ? <span className="text-muted-foreground italic">NULL</span> : String(r[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>


        {resultRows.length > 0 && (
          <div className="flex items-center justify-between border-t border-border bg-card/30 px-4 py-2 text-xs">
            <span className="text-muted-foreground">Total rows: {resultRows.length}</span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹</Button>
              <span className="px-2">{page} / {totalPages}</span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>›</Button>
            </div>
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
