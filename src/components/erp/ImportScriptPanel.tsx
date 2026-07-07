/**
 * ImportScriptPanel.tsx
 * -----------------------------------------------------------------------------
 * Self-contained "Import Script → Query Builder" panel for the Data Explorer.
 *
 * - Paste a SQL script or upload a .sql file
 * - "Parse & Build" parses it (sqlScriptParser) and pushes the result into the
 *   Data Explorer Query Builder via onApplySpec(spec)
 * - Edit the parsed projection / GROUP BY / ORDER BY / window functions
 * - "Run Query" executes through the existing engine via onRunQuery()
 *
 * This component is modular & reversible: it touches no other module. It only
 * calls the two callbacks the Data Explorer passes in.
 *
 * Drop at:  src/components/erp/ImportScriptPanel.tsx
 * (shadcn ui + lucide-react — already in the project)
 * -----------------------------------------------------------------------------
 */
import React, { useRef, useState } from "react";
import {
  Upload,
  FileCode2,
  Play,
  Plus,
  X,
  Wand2,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Loader2,
  Save,
  FolderOpen,
  Trash2,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  parseSqlScript,
  buildSpecFromParsed,
} from "@/lib/sqlScriptParser";
import type {
  ParsedScript,
  ExtendedDataExplorerSpec,
  DataExplorerSelectColumn,
} from "@/lib/sqlScriptParser";

interface Props {
  onApplySpec: (spec: ExtendedDataExplorerSpec) => void;
  onRunQuery: (overrideSpec?: ExtendedDataExplorerSpec) => void | Promise<void>;
  onClearResults?: () => void;
  running?: boolean;
}

const SAVED_SCRIPTS_KEY = "erp.dataExplorer.savedScripts.v1";
interface SavedScript {
  name: string;
  sql: string;
  savedAt: number;
}

export default function ImportScriptPanel({ onApplySpec, onRunQuery, onClearResults, running }: Props) {
  const [rawSql, setRawSql] = useState("");
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedScript | null>(null);
  const [spec, setSpec] = useState<ExtendedDataExplorerSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scriptName, setScriptName] = useState("");
  const [loadScriptOpen, setLoadScriptOpen] = useState(false);
  const [savedScripts, setSavedScripts] = useState<SavedScript[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const loadSavedScripts = (): SavedScript[] => {
    try { return JSON.parse(localStorage.getItem(SAVED_SCRIPTS_KEY) || "[]"); } catch { return []; }
  };

  const handleSqlChange = (value: string) => {
    setRawSql(value);
    if (!value.trim()) {
      setParsed(null);
      setSpec(null);
      setError(null);
      setFileName("");
      onClearResults?.();
    }
  };

  const saveScript = () => {
    const name = scriptName.trim();
    if (!name) { toast.error("Enter a script name first."); return; }
    if (!rawSql.trim()) { toast.error("Nothing to save — paste a script first."); return; }
    const list = loadSavedScripts().filter((s) => s.name !== name);
    list.push({ name, sql: rawSql, savedAt: Date.now() });
    localStorage.setItem(SAVED_SCRIPTS_KEY, JSON.stringify(list));
    toast.success(`Saved script "${name}"`);
  };

  const openLoadScripts = () => {
    setSavedScripts(loadSavedScripts().sort((a, b) => b.savedAt - a.savedAt));
    setLoadScriptOpen(true);
  };

  const applySavedScript = (s: SavedScript) => {
    setRawSql(s.sql);
    setScriptName(s.name);
    setFileName("");
    setParsed(null);
    setSpec(null);
    setError(null);
    setLoadScriptOpen(false);
    toast.success(`Loaded script "${s.name}"`);
  };

  const deleteSavedScript = (name: string) => {
    const list = loadSavedScripts().filter((s) => s.name !== name);
    localStorage.setItem(SAVED_SCRIPTS_KEY, JSON.stringify(list));
    setSavedScripts(list);
  };

  const commit = (next: ExtendedDataExplorerSpec) => {
    setSpec(next);
    onApplySpec(next);
  };

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setRawSql(String(reader.result || ""));
      setFileName(file.name);
    };
    reader.onerror = () => setError("Failed to read file.");
    reader.readAsText(file);
  };

  const runRawQuery = () => {
    setError(null);
    if (!rawSql.trim()) {
      setError("Paste a SQL script or upload a .sql file first.");
      return;
    }
    const s: ExtendedDataExplorerSpec = {
      tables: [], joins: [], conditions: [], limit: 100, rawSql: rawSql.trim(),
    };
    setParsed(null);
    commit(s);
    onRunQuery(s);
  };

  const doParse = () => {
    setError(null);
    if (!rawSql.trim()) {
      setError("Paste a SQL script or upload a .sql file first.");
      return;
    }
    try {
      const p = parseSqlScript(rawSql);
      const s = buildSpecFromParsed(p, 100);
      setParsed(p);
      commit(s);
      if (p.warnings.length) toast.warning(`Parsed with ${p.warnings.length} note(s).`);
      else toast.success("Script parsed → Query Builder populated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Parse failed.");
      setParsed(null);
      setSpec(null);
    }
  };

  // ---- editing helpers ----
  const updateSelectCol = (i: number, patch: Partial<DataExplorerSelectColumn>) => {
    if (!spec?.selectColumns) return;
    const next = { ...spec, selectColumns: spec.selectColumns.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) };
    commit(next);
  };
  const addSelectCol = () => {
    if (!spec) return;
    const next = { ...spec, selectColumns: [...(spec.selectColumns || []), { expression: "" }] };
    commit(next);
  };
  const removeSelectCol = (i: number) => {
    if (!spec?.selectColumns) return;
    const next = { ...spec, selectColumns: spec.selectColumns.filter((_, idx) => idx !== i) };
    commit(next);
  };
  const updateGroupBy = (i: number, expression: string) => {
    if (!spec?.groupBy) return;
    const next = { ...spec, groupBy: spec.groupBy.map((g, idx) => (idx === i ? { expression } : g)) };
    commit(next);
  };
  const addGroupBy = () => {
    if (!spec) return;
    const next = { ...spec, groupBy: [...(spec.groupBy || []), { expression: "" }] };
    commit(next);
  };
  const removeGroupBy = (i: number) => {
    if (!spec?.groupBy) return;
    const next = { ...spec, groupBy: spec.groupBy.filter((_, idx) => idx !== i) };
    commit(next);
  };
  const toggleOrderDir = (i: number) => {
    if (!spec?.orderBy) return;
    const next = {
      ...spec,
      orderBy: spec.orderBy.map((o, idx) =>
        idx === i ? { ...o, direction: (o.direction === "ASC" ? "DESC" : "ASC") as "ASC" | "DESC" } : o
      ),
    };
    commit(next);
  };
  const updateOrderExpr = (i: number, expression: string) => {
    if (!spec?.orderBy) return;
    const next = { ...spec, orderBy: spec.orderBy.map((o, idx) => (idx === i ? { ...o, expression } : o)) };
    commit(next);
  };
  const addOrderBy = () => {
    if (!spec) return;
    const next = { ...spec, orderBy: [...(spec.orderBy || []), { expression: "", direction: "ASC" as "ASC" | "DESC" }] };
    commit(next);
  };
  const removeOrderBy = (i: number) => {
    if (!spec?.orderBy) return;
    const next = { ...spec, orderBy: spec.orderBy.filter((_, idx) => idx !== i) };
    commit(next);
  };

  const hasParsed = !!parsed && !!spec;

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ---- Input ---- */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <FileCode2 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Import SQL Script</h3>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".sql,.txt"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <Upload className="h-4 w-4 mr-1.5" /> Upload .sql
          </Button>
        </div>
        {fileName && (
          <p className="text-xs text-muted-foreground mb-2">Loaded: {fileName}</p>
        )}
        <Textarea
          value={rawSql}
          onChange={(e) => handleSqlChange(e.target.value)}
          placeholder="Paste a T-SQL SELECT script here…"
          className="font-mono text-xs min-h-[160px]"
        />
        <div className="flex items-center gap-2 mt-3">
          <Button onClick={runRawQuery} size="sm" disabled={running || !rawSql.trim()}>
            {running ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Play className="h-4 w-4 mr-1.5" />}
            Run Query
          </Button>
          <Button onClick={doParse} size="sm" variant="outline">
            <Wand2 className="h-4 w-4 mr-1.5" /> Parse &amp; Build
          </Button>
          <Button onClick={() => { setRawSql(""); setFileName(""); setParsed(null); setSpec(null); setError(null); onClearResults?.(); }} size="sm" variant="outline" disabled={!rawSql.trim()}>
            <X className="h-4 w-4 mr-1.5" /> Clear
          </Button>
          <div className="flex flex-1 items-center gap-1.5 ml-2">
            <Input
              value={scriptName}
              onChange={(e) => setScriptName(e.target.value)}
              placeholder="Script name…"
              className="h-8 text-xs max-w-[180px]"
            />
            <Button onClick={saveScript} size="sm" variant="outline" disabled={!rawSql.trim()}>
              <Save className="h-3.5 w-3.5 mr-1" /> Save
            </Button>
            <Button onClick={openLoadScripts} size="sm" variant="outline">
              <FolderOpen className="h-3.5 w-3.5 mr-1" /> Load
            </Button>
          </div>
        </div>
        {error && (
          <p className="text-xs text-destructive mt-2 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" /> {error}
          </p>
        )}
      </div>

      {/* ---- Parsed structured view ---- */}
      {hasParsed && parsed && spec && (
        <div className="rounded-lg border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <h3 className="text-sm font-semibold">Parsed Query Builder</h3>
            <Badge variant="secondary">{spec.tables.length} table(s)</Badge>
            <Badge variant="secondary">{spec.joins.length} join(s)</Badge>
            <Badge variant="secondary">{spec.conditions.length} condition(s)</Badge>
            {spec.distinct && <Badge>DISTINCT</Badge>}
          </div>

          {parsed.warnings.length > 0 && (
            <div className="mb-3 rounded-md border border-amber-300/40 bg-amber-50 dark:bg-amber-950/30 p-2">
              {parsed.warnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {w}
                </p>
              ))}
            </div>
          )}

          <ScrollArea className="h-[420px] pr-3">
            <div className="flex flex-col gap-4">
              {/* SELECT columns */}
              <section>
                <div className="flex items-center justify-between mb-1.5">
                  <Label className="text-xs font-semibold uppercase text-muted-foreground">Select Columns</Label>
                  <Button variant="ghost" size="sm" className="h-6 px-2" onClick={addSelectCol}>
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {(spec.selectColumns || []).map((c, i) => {
                    const pc = parsed.selectColumns[i];
                    return (
                      <div key={i} className="flex items-center gap-1.5">
                        <Input
                          value={c.expression}
                          onChange={(e) => updateSelectCol(i, { expression: e.target.value })}
                          className="font-mono text-xs h-8 flex-1"
                          placeholder="e.g. t1.Name"
                        />
                        <Input
                          value={c.alias || ""}
                          onChange={(e) => updateSelectCol(i, { alias: e.target.value })}
                          className="text-xs h-8 w-28"
                          placeholder="alias"
                        />
                        <div className="flex items-center gap-0.5">
                          {pc?.hasWindowFunction && <Badge variant="outline" className="h-6 text-[10px]">WIN</Badge>}
                          {pc?.hasCase && <Badge variant="outline" className="h-6 text-[10px]">CASE</Badge>}
                          {pc?.hasConvert && <Badge variant="outline" className="h-6 text-[10px]">CONV</Badge>}
                          {pc?.hasIsNull && <Badge variant="outline" className="h-6 text-[10px]">ISNULL</Badge>}
                        </div>
                        <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => removeSelectCol(i)}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                  {(!spec.selectColumns || spec.selectColumns.length === 0) && (
                    <p className="text-xs text-muted-foreground">No explicit projection — all columns will be returned.</p>
                  )}
                </div>
              </section>

              <Separator />

              {/* Window functions */}
              {parsed.windowFunctions.length > 0 && (
                <section>
                  <Label className="text-xs font-semibold uppercase text-muted-foreground mb-1.5 block">
                    Window Functions
                  </Label>
                  <div className="flex flex-col gap-1.5">
                    {parsed.windowFunctions.map((w, i) => (
                      <div key={i} className="rounded-md border p-2 text-xs font-mono bg-muted/40">
                        <div className="font-semibold">
                          {w.name}({w.expression || ""}) OVER (…)
                          {w.alias && <span className="text-muted-foreground"> AS {w.alias}</span>}
                        </div>
                        {w.partitionBy.length > 0 && (
                          <div className="text-muted-foreground mt-1">PARTITION BY: {w.partitionBy.join(", ")}</div>
                        )}
                        {w.orderBy && <div className="text-muted-foreground">ORDER BY: {w.orderBy}</div>}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <Separator />

              {/* GROUP BY */}
              <section>
                <div className="flex items-center justify-between mb-1.5">
                  <Label className="text-xs font-semibold uppercase text-muted-foreground">Group By</Label>
                  <Button variant="ghost" size="sm" className="h-6 px-2" onClick={addGroupBy}>
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {(spec.groupBy || []).map((g, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <Input
                        value={g.expression}
                        onChange={(e) => updateGroupBy(i, e.target.value)}
                        className="font-mono text-xs h-8 flex-1"
                        placeholder="e.g. t1.Category"
                      />
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => removeGroupBy(i)}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  {(!spec.groupBy || spec.groupBy.length === 0) && (
                    <p className="text-xs text-muted-foreground">None.</p>
                  )}
                </div>
              </section>

              <Separator />

              {/* ORDER BY */}
              <section>
                <div className="flex items-center justify-between mb-1.5">
                  <Label className="text-xs font-semibold uppercase text-muted-foreground">Order By</Label>
                  <Button variant="ghost" size="sm" className="h-6 px-2" onClick={addOrderBy}>
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {(spec.orderBy || []).map((o, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <Input
                        value={o.expression}
                        onChange={(e) => updateOrderExpr(i, e.target.value)}
                        className="font-mono text-xs h-8 flex-1"
                        placeholder="e.g. t1.CreatedAt"
                      />
                      <Button variant="outline" size="sm" className="h-8 px-2" onClick={() => toggleOrderDir(i)}>
                        {o.direction === "ASC" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                        <span className="ml-1 text-xs">{o.direction}</span>
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => removeOrderBy(i)}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  {(!spec.orderBy || spec.orderBy.length === 0) && (
                    <p className="text-xs text-muted-foreground">None.</p>
                  )}
                </div>
              </section>

              <Separator />

              {/* WHERE conditions (read-only summary — edit in the Query Builder) */}
              <section>
                <Label className="text-xs font-semibold uppercase text-muted-foreground mb-1.5 block">
                  Where Conditions
                </Label>
                <div className="flex flex-col gap-1">
                  {parsed.conditions.map((c, i) => (
                    <div key={i} className="text-xs font-mono rounded border px-2 py-1 bg-muted/40">
                      {c.operator === "raw" ? (
                        <span>{c.raw}</span>
                      ) : (
                        <span>
                          <Badge variant="outline" className="mr-1.5 text-[10px]">{c.operator}</Badge>
                          {c.alias}.{c.column}
                          {c.value !== undefined && c.value !== null ? ` = ${c.value}` : ""}
                        </span>
                      )}
                    </div>
                  ))}
                  {parsed.conditions.length === 0 && <p className="text-xs text-muted-foreground">None.</p>}
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">
                  Tables, joins &amp; conditions were pushed to the Query Builder — switch to it to edit them.
                </p>
              </section>
            </div>
          </ScrollArea>
        </div>
      )}

      {/* ---- Saved Scripts dialog ---- */}
      <Dialog open={loadScriptOpen} onOpenChange={setLoadScriptOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Saved SQL Scripts</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto">
            {savedScripts.length === 0 && (
              <div className="py-6 text-center text-sm text-muted-foreground">No saved scripts.</div>
            )}
            {savedScripts.map((s) => (
              <div key={s.name} className="flex items-center justify-between rounded border border-border bg-background/60 px-3 py-2 mb-1.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{s.name}</div>
                  <div className="text-[11px] text-muted-foreground truncate font-mono">{s.sql.slice(0, 80)}{s.sql.length > 80 ? "…" : ""}</div>
                  <div className="text-[10px] text-muted-foreground">{new Date(s.savedAt).toLocaleString()}</div>
                </div>
                <div className="flex gap-1 ml-2">
                  <Button size="sm" onClick={() => applySavedScript(s)}>Load</Button>
                  <Button size="sm" variant="outline" onClick={() => deleteSavedScript(s.name)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLoadScriptOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}