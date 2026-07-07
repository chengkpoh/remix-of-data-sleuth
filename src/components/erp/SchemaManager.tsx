import { useEffect, useMemo, useState } from "react";
import { Loader2, Wand2, ShieldAlert, CheckCircle2, X, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { getErp } from "@/lib/erp/client";
import { TableMultiSelect } from "./TableMultiSelect";
import type {
  SchemaSnapshot, TableInfo, TableColumnInfo, ColumnDependencies,
} from "@/lib/erp/types";

const TYPE_OPTIONS = [
  "nvarchar", "varchar", "nchar", "char", "text", "ntext",
  "int", "bigint", "smallint", "tinyint", "decimal", "numeric",
  "money", "smallmoney", "float", "real",
  "bit", "date", "datetime", "datetime2", "smalldatetime", "time",
  "uniqueidentifier", "varbinary",
];

const TEXT_GROUP = new Set(["nvarchar", "varchar", "nchar", "char", "text", "ntext"]);
const NUM_GROUP = new Set(["int", "bigint", "smallint", "tinyint", "decimal", "numeric", "money", "smallmoney", "float", "real"]);
const DATE_GROUP = new Set(["date", "datetime", "datetime2", "smalldatetime", "time"]);

function groupOf(t: string) {
  if (TEXT_GROUP.has(t)) return "text";
  if (NUM_GROUP.has(t)) return "number";
  if (DATE_GROUP.has(t)) return "date";
  return "other";
}

function formatExistingType(c: TableColumnInfo): string {
  const t = c.dataType;
  if (TEXT_GROUP.has(t)) {
    const len = c.charMaxLength;
    return `${t}(${len === -1 ? "MAX" : len ?? ""})`;
  }
  if (t === "decimal" || t === "numeric") {
    return `${t}(${c.numericPrecision ?? ""},${c.numericScale ?? ""})`;
  }
  return t;
}

function quote(name: string) {
  return "[" + String(name).replace(/]/g, "]]") + "]";
}

interface NewTypeSpec {
  baseType: string;
  length: string; // for text, "" or "MAX" or number
  precision: string;
  scale: string;
  nullable: boolean;
}

function specToSql(spec: NewTypeSpec): string {
  const t = spec.baseType;
  let typeSql = t;
  if (TEXT_GROUP.has(t) && t !== "text" && t !== "ntext") {
    const len = (spec.length || "").trim();
    if (len) typeSql += `(${len.toUpperCase() === "MAX" ? "MAX" : Number(len) || 50})`;
  } else if (t === "decimal" || t === "numeric") {
    const p = Number(spec.precision) || 18;
    const s = Number(spec.scale) || 0;
    typeSql += `(${p},${s})`;
  }
  return `${typeSql} ${spec.nullable ? "NULL" : "NOT NULL"}`;
}

interface RowState {
  selected: boolean;
  spec: NewTypeSpec;
}

type TableKey = string; // `schema|name`
const tableKey = (t: TableInfo) => `${t.schema}|${t.name}`;
const rowKey = (t: TableInfo, col: string) => `${t.schema}|${t.name}|${col}`;

export function SchemaManager({ schema, dark }: { schema: SchemaSnapshot; dark: boolean }) {
  const tables = schema.tables;
  const [selectedTables, setSelectedTables] = useState<TableInfo[]>([]);
  const [tableColumns, setTableColumns] = useState<Record<TableKey, TableColumnInfo[]>>({});
  const [loadingKeys, setLoadingKeys] = useState<Set<TableKey>>(new Set());
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [searchTerms, setSearchTerms] = useState<Record<TableKey, string>>({});

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewStmts, setPreviewStmts] = useState<string[]>([]);
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [depWarnings, setDepWarnings] = useState<string[]>([]);
  const [checkingDeps, setCheckingDeps] = useState(false);
  const [executing, setExecuting] = useState(false);

  // Fetch columns for any newly-selected table.
  useEffect(() => {
    const erp = getErp();
    if (!erp) return;
    const missing = selectedTables.filter(
      (t) => !tableColumns[tableKey(t)] && !loadingKeys.has(tableKey(t)),
    );
    if (!missing.length) return;
    setLoadingKeys((prev) => {
      const next = new Set(prev);
      missing.forEach((t) => next.add(tableKey(t)));
      return next;
    });
    missing.forEach((t) => {
      erp.getTableColumns({ schema: t.schema, table: t.name })
        .then((cols) => {
          setTableColumns((prev) => ({ ...prev, [tableKey(t)]: cols }));
          setRows((prev) => {
            const next = { ...prev };
            cols.forEach((c) => {
              const k = rowKey(t, c.columnName);
              if (!next[k]) {
                next[k] = {
                  selected: false,
                  spec: {
                    baseType: c.dataType,
                    length: c.charMaxLength === -1 ? "MAX" : String(c.charMaxLength ?? ""),
                    precision: String(c.numericPrecision ?? ""),
                    scale: String(c.numericScale ?? ""),
                    nullable: c.isNullable === "YES",
                  },
                };
              }
            });
            return next;
          });
        })
        .catch((e) => toast.error(`Failed to load ${t.schema}.${t.name}: ${(e as Error).message}`))
        .finally(() => {
          setLoadingKeys((prev) => {
            const next = new Set(prev);
            next.delete(tableKey(t));
            return next;
          });
        });
    });
  }, [selectedTables, tableColumns, loadingKeys]);

  const updateRow = (k: string, patch: Partial<RowState> | ((r: RowState) => RowState)) => {
    setRows((prev) => {
      const cur = prev[k];
      if (!cur) return prev;
      const next = typeof patch === "function" ? patch(cur) : { ...cur, ...patch };
      return { ...prev, [k]: next };
    });
  };
  const updateSpec = (k: string, patch: Partial<NewTypeSpec>) =>
    updateRow(k, (r) => ({ ...r, spec: { ...r.spec, ...patch } }));

  const setSearchTerm = (t: TableInfo, value: string) =>
    setSearchTerms((prev) => ({ ...prev, [tableKey(t)]: value }));

  const selectedCount = useMemo(
    () => Object.values(rows).filter((r) => r.selected).length,
    [rows],
  );

  const buildPreview = async () => {
    const erp = getErp();
    if (!erp) { toast.error("SQL access requires the Electron desktop build."); return; }
    if (!selectedTables.length) { toast.error("Select at least one table."); return; }

    const stmts: string[] = [];
    const warns: string[] = [];
    const depMsgs: string[] = [];
    setCheckingDeps(true);

    try {
      for (const t of selectedTables) {
        const cols = tableColumns[tableKey(t)] || [];
        const picked = cols.filter((c) => rows[rowKey(t, c.columnName)]?.selected);
        if (!picked.length) continue;
        const tableRef = `${quote(t.schema)}.${quote(t.name)}`;

        for (const c of picked) {
          const spec = rows[rowKey(t, c.columnName)].spec;
          const newSql = specToSql(spec);
          const before = formatExistingType(c) + (c.isNullable === "YES" ? " NULL" : " NOT NULL");
          const cur = formatExistingType(c) + " " + (c.isNullable === "YES" ? "NULL" : "NOT NULL");
          const label = `${t.schema}.${t.name}.${c.columnName}`;
          if (newSql.toLowerCase() === cur.toLowerCase()) {
            warns.push(`${label}: no change detected (${before}).`);
          }
          if (groupOf(c.dataType) !== groupOf(spec.baseType)) {
            warns.push(`${label}: incompatible type change ${c.dataType} → ${spec.baseType}. Data conversion may fail or lose precision.`);
          }
          if (TEXT_GROUP.has(c.dataType) && TEXT_GROUP.has(spec.baseType)) {
            const oldLen = c.charMaxLength ?? 0;
            const newLen = spec.length.toUpperCase() === "MAX" ? Number.MAX_SAFE_INTEGER : Number(spec.length) || 0;
            if (oldLen === -1 && newLen !== Number.MAX_SAFE_INTEGER) {
              warns.push(`${label}: shrinking MAX → ${spec.length} may truncate existing data.`);
            } else if (newLen < oldLen) {
              warns.push(`${label}: shrinking length ${oldLen} → ${newLen} may truncate existing data.`);
            }
          }
          if (c.isPrimaryKey) {
            warns.push(`${label}: column is part of the primary key. ALTER may fail without dropping the PK first.`);
          }
          stmts.push(`ALTER TABLE ${tableRef} ALTER COLUMN ${quote(c.columnName)} ${newSql};`);

          try {
            const dep = await erp.getColumnDependencies({
              schema: t.schema, table: t.name, column: c.columnName,
            }) as ColumnDependencies;
            const refs: string[] = [];
            if (dep.foreignKeys.length) refs.push(`${dep.foreignKeys.length} foreign key(s)`);
            const nonPkIdx = dep.indexes.filter((i) => !i.isPrimaryKey);
            if (nonPkIdx.length) refs.push(`${nonPkIdx.length} index(es)`);
            if (refs.length) depMsgs.push(`${label} is referenced by ${refs.join(", ")}.`);
          } catch (e) {
            depMsgs.push(`${label}: dependency check failed: ${(e as Error).message}`);
          }
        }
      }
    } finally {
      setCheckingDeps(false);
    }

    if (!stmts.length) { toast.error("Select at least one column."); return; }
    setPreviewStmts(stmts);
    setPreviewWarnings(warns);
    setDepWarnings(depMsgs);
    setPreviewOpen(true);
  };

  const executeStatements = async () => {
    const erp = getErp();
    if (!erp) return;
    setExecuting(true);
    try {
      const r = await erp.executeAlterStatements({ statements: previewStmts });
      if (r.ok) {
        toast.success(`Applied ${r.executed.length} statement(s) successfully.`);
        setPreviewOpen(false);
        // Reload columns for all selected tables.
        for (const t of selectedTables) {
          try {
            const cols = await erp.getTableColumns({ schema: t.schema, table: t.name });
            setTableColumns((prev) => ({ ...prev, [tableKey(t)]: cols }));
            setRows((prev) => {
              const next = { ...prev };
              cols.forEach((c) => {
                const k = rowKey(t, c.columnName);
                if (next[k]) next[k] = { ...next[k], selected: false };
              });
              return next;
            });
          } catch { /* ignore */ }
        }
      } else {
        toast.error(`Execution failed: ${r.error}`);
      }
    } catch (e) {
      toast.error(`Execution failed: ${(e as Error).message}`);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Schema Manager</h2>
          <p className="text-xs text-muted-foreground">
            Inspect table structure and safely alter column data types. Multiple tables can be selected.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-[360px]">
            <Label className="mb-1.5 block text-xs font-medium text-muted-foreground">Tables</Label>
            <TableMultiSelect
              tables={tables}
              selected={selectedTables}
              onChange={setSelectedTables}
              triggerClassName="w-full"
              contentWidth={380}
            />
          </div>
          <Button
            onClick={buildPreview}
            disabled={!selectedTables.length || !selectedCount || checkingDeps}
          >
            {checkingDeps ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1.5 h-3.5 w-3.5" />}
            Apply Changes {selectedCount > 0 && `(${selectedCount})`}
          </Button>
        </div>
      </div>

      {selectedTables.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          Select one or more tables from the filter above to view their columns.
        </Card>
      ) : (
        <div className="space-y-4">
          {selectedTables.map((t) => {
            const k = tableKey(t);
            const cols = tableColumns[k];
            const isLoading = loadingKeys.has(k);
            const term = (searchTerms[k] || "").toLowerCase();
            const filteredCols = cols ? cols.filter((c) => c.columnName.toLowerCase().includes(term)) : [];
            return (
              <Card key={k} className="overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-3 py-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Badge variant="outline" className="font-mono text-[10px]">{t.schema}</Badge>
                    <span className="font-mono">{t.name}</span>
                    {cols && <span className="text-xs text-muted-foreground">{filteredCols.length} of {cols.length} columns</span>}
                  </div>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={searchTerms[k] || ""}
                      onChange={(e) => setSearchTerm(t, e.target.value)}
                      placeholder="Search column..."
                      className="h-8 w-[220px] pl-8 pr-7 text-xs"
                    />
                    {searchTerms[k] && (
                      <button
                        type="button"
                        onClick={() => setSearchTerm(t, "")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label="Clear search"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                {isLoading || !cols ? (
                  <div className="flex items-center justify-center p-6 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                ) : cols.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">No columns found.</div>
                ) : (
                  <div className="overflow-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                        <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                          <th className="w-10 px-3 py-2"></th>
                          <th className="px-3 py-2 font-medium">Column Name</th>
                          <th className="px-3 py-2 font-medium">Current Data Type</th>
                          <th className="px-3 py-2 font-medium">Relationship / Reference</th>
                          <th className="px-3 py-2 font-medium">New Data Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cols.map((c) => {
                          const rk = rowKey(t, c.columnName);
                          const row = rows[rk];
                          if (!row) return null;
                          const fk = c.fkRefTable
                            ? `${c.columnName} → ${c.fkRefSchema}.${c.fkRefTable}.${c.fkRefColumn}`
                            : "Same Table";
                          const isText = TEXT_GROUP.has(row.spec.baseType) && row.spec.baseType !== "text" && row.spec.baseType !== "ntext";
                          const isDecimal = row.spec.baseType === "decimal" || row.spec.baseType === "numeric";
                          return (
                            <tr key={rk} className="border-b border-border/50 hover:bg-accent/40">
                              <td className="px-3 py-2 align-middle">
                                <Checkbox
                                  checked={row.selected}
                                  onCheckedChange={(v) => updateRow(rk, { selected: !!v })}
                                />
                              </td>
                              <td className="px-3 py-2 font-mono text-xs">
                                {c.isPrimaryKey && <Badge variant="outline" className="mr-1.5 text-[9px]">PK</Badge>}
                                {c.columnName}
                              </td>
                              <td className="px-3 py-2">
                                <Badge variant="outline" className="font-mono text-[10px]">
                                  {formatExistingType(c)}{c.isNullable === "YES" ? "" : " NOT NULL"}
                                </Badge>
                              </td>
                              <td className="px-3 py-2 font-mono text-xs">
                                {c.fkRefTable ? (
                                  <span className="text-primary">{fk}</span>
                                ) : (
                                  <span className="text-muted-foreground">Same Table</span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Select
                                    value={row.spec.baseType}
                                    onValueChange={(v) => updateSpec(rk, { baseType: v })}
                                  >
                                    <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue /></SelectTrigger>
                                    <SelectContent className="max-h-[280px]">
                                      {TYPE_OPTIONS.map((opt) => (
                                        <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  {isText && (
                                    <Input
                                      value={row.spec.length}
                                      onChange={(e) => updateSpec(rk, { length: e.target.value })}
                                      placeholder="length / MAX"
                                      className="h-8 w-[100px] text-xs"
                                    />
                                  )}
                                  {isDecimal && (
                                    <>
                                      <Input
                                        value={row.spec.precision}
                                        onChange={(e) => updateSpec(rk, { precision: e.target.value })}
                                        placeholder="prec"
                                        className="h-8 w-[70px] text-xs"
                                      />
                                      <Input
                                        value={row.spec.scale}
                                        onChange={(e) => updateSpec(rk, { scale: e.target.value })}
                                        placeholder="scale"
                                        className="h-8 w-[70px] text-xs"
                                      />
                                    </>
                                  )}
                                  <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                                    <Checkbox
                                      checked={row.spec.nullable}
                                      onCheckedChange={(v) => updateSpec(rk, { nullable: !!v })}
                                    />
                                    NULL
                                  </label>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>SQL Preview</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {(previewWarnings.length > 0 || depWarnings.length > 0) && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                <div className={`mb-1.5 flex items-center gap-1.5 font-medium ${dark ? "text-amber-300" : "text-amber-700"}`}>
                  <ShieldAlert className="h-3.5 w-3.5" /> Warnings
                </div>
                <ul className={`list-disc space-y-0.5 pl-5 ${dark ? "text-amber-100" : "text-amber-900"}`}>
                  {previewWarnings.map((w, i) => <li key={`w${i}`}>{w}</li>)}
                  {depWarnings.map((w, i) => (
                    <li key={`d${i}`}>{w} This column is referenced by other database objects. Continue?</li>
                  ))}
                </ul>
              </div>
            )}
            <ScrollArea className="max-h-[40vh] rounded-md border border-border bg-muted/40 p-3">
              <pre className="whitespace-pre-wrap font-mono text-xs">
                {previewStmts.join("\n")}
              </pre>
            </ScrollArea>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)} disabled={executing}>
              <X className="mr-1.5 h-3.5 w-3.5" /> Cancel
            </Button>
            <Button onClick={executeStatements} disabled={executing}>
              {executing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}
              Confirm & Execute
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
