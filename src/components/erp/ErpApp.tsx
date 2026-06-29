import { useEffect, useMemo, useRef, useState } from "react";
import {
  Database, Loader2, Plug, PlugZap, Search, X, Download, FileSpreadsheet,
  Table as TableIcon, Eye, AlertTriangle, CheckCircle2, Moon, Sun, StopCircle,
  LayoutDashboard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { getErp, isElectron } from "@/lib/erp/client";
import {
  TEXT_TYPES, NUMBER_TYPES, ID_TYPES,
  type ConnectionConfig, type SchemaSnapshot, type SearchMode,
  type SearchResultRow, type TableInfo,
} from "@/lib/erp/types";
import { Dashboard } from "./Dashboard";

type Phase = "disconnected" | "connecting" | "connected";
type View = "dashboard" | "search";

const DEFAULT_CFG: ConnectionConfig = {
  server: "localhost",
  database: "",
  user: "sa",
  password: "",
  port: 1433,
  encrypt: false,
};

export function ErpApp() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const [phase, setPhase] = useState<Phase>("disconnected");
  const [cfg, setCfg] = useState<ConnectionConfig>(DEFAULT_CFG);
  const [schema, setSchema] = useState<SchemaSnapshot | null>(null);
  const [view, setView] = useState<View>("dashboard");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster theme={dark ? "dark" : "light"} richColors closeButton />
      <TopBar
        phase={phase}
        cfg={cfg}
        dark={dark}
        view={view}
        onViewChange={setView}
        onToggleTheme={() => setDark((d) => !d)}
        onDisconnect={async () => {
          try { await getErp()?.disconnect(); } catch {}
          setPhase("disconnected");
          setSchema(null);
          setView("dashboard");
        }}
      />
      {phase !== "connected" ? (
        <ConnectionPanel
          cfg={cfg}
          setCfg={setCfg}
          phase={phase}
          onConnected={(s) => { setSchema(s); setPhase("connected"); setView("dashboard"); }}
          setPhase={setPhase}
        />
      ) : view === "dashboard" ? (
        <Dashboard dark={dark} />
      ) : (
        <Workspace schema={schema!} cfg={cfg} />
      )}
    </div>
  );
}

/* ---------------- Top bar ---------------- */

function TopBar(props: {
  phase: Phase;
  cfg: ConnectionConfig;
  dark: boolean;
  view: View;
  onViewChange: (v: View) => void;
  onToggleTheme: () => void;
  onDisconnect: () => void;
}) {
  const { phase, cfg, dark, view, onViewChange, onToggleTheme, onDisconnect } = props;
  return (
    <header className="flex items-center justify-between border-b border-border bg-card/50 px-4 py-2.5 backdrop-blur">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Database className="h-4 w-4" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">ERP Data Finder</div>
          <div className="text-[11px] text-muted-foreground">
            Universal SQL Server diagnostic tool
          </div>
        </div>
        {phase === "connected" && (
          <nav className="ml-4 flex items-center gap-1 rounded-md border border-border bg-background/60 p-0.5">
            <button
              onClick={() => onViewChange("dashboard")}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition ${view === "dashboard" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <LayoutDashboard className="h-3.5 w-3.5" /> Dashboard
            </button>
            <button
              onClick={() => onViewChange("search")}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition ${view === "search" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <Search className="h-3.5 w-3.5" /> Data Finder
            </button>
          </nav>
        )}
      </div>
      <div className="flex items-center gap-2">
        {phase === "connected" && (
          <Badge variant="outline" className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-500">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {cfg.server} / {cfg.database}
          </Badge>
        )}
        {!isElectron() && (
          <Badge variant="outline" className="gap-1.5 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" /> Web preview (no SQL)
          </Badge>
        )}
        <Button variant="ghost" size="icon" onClick={onToggleTheme} aria-label="Toggle theme">
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        {phase === "connected" && (
          <Button variant="outline" size="sm" onClick={onDisconnect}>
            <Plug className="mr-1.5 h-3.5 w-3.5" /> Disconnect
          </Button>
        )}
      </div>
    </header>
  );
}

/* ---------------- Connection panel ---------------- */

function ConnectionPanel(props: {
  cfg: ConnectionConfig;
  setCfg: (c: ConnectionConfig) => void;
  phase: Phase;
  setPhase: (p: Phase) => void;
  onConnected: (s: SchemaSnapshot) => void;
}) {
  const { cfg, setCfg, phase, setPhase, onConnected } = props;
  const [testing, setTesting] = useState(false);

  const setField = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) =>
    setCfg({ ...cfg, [k]: v });

  const test = async () => {
    const erp = getErp();
    if (!erp) {
      toast.error("Run the Electron desktop build to connect to SQL Server.");
      return;
    }
    setTesting(true);
    try {
      const r = await erp.test(cfg);
      if (r.ok) toast.success("Connection successful");
      else toast.error(`Test failed: ${r.error}`);
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally { setTesting(false); }
  };

  const connect = async () => {
    const erp = getErp();
    if (!erp) {
      toast.error("Run the Electron desktop build to connect to SQL Server.");
      return;
    }
    setPhase("connecting");
    try {
      const r = await erp.connect(cfg);
      toast.success(`Connected. Loaded ${r.schema.tables.length} tables.`);
      onConnected(r.schema);
    } catch (e) {
      toast.error(`Connection failed: ${(e as Error).message}`);
      setPhase("disconnected");
    }
  };

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-10">
      <div className="text-center">
        <h1 className="text-xl font-semibold">Connect to SQL Server</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter your database credentials. The connection runs in the local Electron process via the <code className="rounded bg-muted px-1.5 py-0.5 text-xs">mssql</code> driver.
        </p>
      </div>
      <Card className="p-5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Server Name" className="col-span-2">
            <Input value={cfg.server} onChange={(e) => setField("server", e.target.value)} placeholder="localhost\\SQLEXPRESS or 10.0.0.5" />
          </Field>
          <Field label="Database">
            <Input value={cfg.database} onChange={(e) => setField("database", e.target.value)} placeholder="ERP_PROD" />
          </Field>
          <Field label="Port">
            <Input type="number" value={cfg.port ?? 1433} onChange={(e) => setField("port", Number(e.target.value) || 1433)} />
          </Field>
          <Field label="Username">
            <Input value={cfg.user} onChange={(e) => setField("user", e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Password">
            <Input type="password" value={cfg.password} onChange={(e) => setField("password", e.target.value)} autoComplete="off" />
          </Field>
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <Checkbox checked={!!cfg.encrypt} onCheckedChange={(v) => setField("encrypt", !!v)} />
            <span>Encrypt connection (TLS)</span>
          </label>
        </div>
        <Separator className="my-4" />
        <div className="flex gap-2">
          <Button variant="outline" onClick={test} disabled={testing || phase === "connecting"}>
            {testing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}
            Test Connection
          </Button>
          <Button onClick={connect} disabled={phase === "connecting"} className="flex-1">
            {phase === "connecting" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <PlugZap className="mr-1.5 h-3.5 w-3.5" />}
            {phase === "connecting" ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </Card>
      {!isElectron() && (
        <Card className="border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-500" />
            <div>
              <div className="font-medium">You're viewing the web preview.</div>
              <div className="mt-1 text-muted-foreground">
                Direct SQL Server connections require the Electron desktop build. Clone the repo and run:
                <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs"><code>{`npm install
npm install --save-dev electron mssql concurrently wait-on @electron/packager
npm run electron:dev`}</code></pre>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

/* ---------------- Workspace ---------------- */

function Workspace({ schema, cfg }: { schema: SchemaSnapshot; cfg: ConnectionConfig }) {
  const [selectedTables, setSelectedTables] = useState<TableInfo[]>([]);
  const [enabledCats, setEnabledCats] = useState({ text: true, number: true, id: true });
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<SearchMode>("contains");
  const [maxResults, setMaxResults] = useState(50);

  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState<{ scanned: number; total: number; currentTable: string } | null>(null);
  const [results, setResults] = useState<SearchResultRow[]>([]);
  const [viewing, setViewing] = useState<SearchResultRow | null>(null);

  const allowedTypes = useMemo(() => {
    const t: string[] = [];
    if (enabledCats.text) t.push(...TEXT_TYPES);
    if (enabledCats.number) t.push(...NUMBER_TYPES);
    if (enabledCats.id) t.push(...ID_TYPES);
    return t;
  }, [enabledCats]);

  const offRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { offRef.current?.(); }, []);

  const runSearch = async () => {
    const erp = getErp();
    if (!erp) { toast.error("SQL access requires the Electron desktop build."); return; }
    if (!value.trim()) { toast.error("Enter a search value."); return; }
    if (!allowedTypes.length) { toast.error("Enable at least one data type."); return; }

    setResults([]);
    setProgress({ scanned: 0, total: 0, currentTable: "" });
    setSearching(true);
    offRef.current?.();
    offRef.current = erp.onSearchProgress((p) => {
      setProgress(p);
      if (p.warning) console.warn(`[${p.currentTable}]`, p.warning);
    });
    try {
      const r = await erp.search({
        value: value.trim(),
        mode,
        maxResults,
        selectedTables,
        allowedTypes,
      });
      setResults(r.results);
      const tag = r.aborted ? "Cancelled" : "Complete";
      toast.success(`${tag}: ${r.results.length} match(es) in ${r.scanned}/${r.total} tables (${r.durationMs}ms)`);
    } catch (e) {
      toast.error(`Search failed: ${(e as Error).message}`);
    } finally {
      setSearching(false);
      offRef.current?.();
      offRef.current = null;
    }
  };

  const cancel = async () => { await getErp()?.cancelSearch(); };

  const exportData = async (fmt: "xlsx" | "csv") => {
    if (!results.length) { toast.error("Nothing to export."); return; }
    const XLSX = await import("xlsx");
    const rows = results.map((r) => ({
      Database: cfg.database,
      Schema: r.schema,
      Table: r.table,
      Column: r.column,
      DataType: r.dataType,
      MatchedValue: r.value,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Results");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    XLSX.writeFile(wb, `erp-data-finder-${ts}.${fmt}`, { bookType: fmt });
  };

  return (
    <div className="grid grid-cols-[320px_1fr] gap-0 min-h-[calc(100vh-49px)]">
      {/* Sidebar */}
      <aside className="border-r border-border bg-card/30 p-3">
        <TableSelector
          schema={schema}
          selected={selectedTables}
          onChange={setSelectedTables}
        />
        <Separator className="my-3" />
        <TypeFilter enabled={enabledCats} onChange={setEnabledCats} />
        <Separator className="my-3" />
        <div className="rounded-md border border-border bg-background/60 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <div className="mb-1 font-medium text-foreground">Schema cache</div>
          {schema.tables.length} tables, {schema.columns.length} columns
          <br />
          loaded {new Date(schema.fetchedAt).toLocaleTimeString()}
        </div>
      </aside>

      {/* Main */}
      <main className="flex flex-col min-w-0">
        <div className="border-b border-border bg-card/30 px-4 py-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[260px]">
              <Label className="mb-1.5 block text-xs font-medium text-muted-foreground">Search Value</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !searching) runSearch(); }}
                  placeholder="e.g. 05348, INV-2024-001, customer name…"
                  className="pl-8"
                />
              </div>
            </div>
            <div className="w-[160px]">
              <Label className="mb-1.5 block text-xs font-medium text-muted-foreground">Search Mode</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as SearchMode)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="contains">Contains</SelectItem>
                  <SelectItem value="starts">Starts With</SelectItem>
                  <SelectItem value="exact">Exact Match</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-[110px]">
              <Label className="mb-1.5 block text-xs font-medium text-muted-foreground">Max Results</Label>
              <Input type="number" min={1} max={5000} value={maxResults} onChange={(e) => setMaxResults(Math.max(1, Number(e.target.value) || 50))} />
            </div>
            {!searching ? (
              <Button onClick={runSearch}><Search className="mr-1.5 h-3.5 w-3.5" /> Search</Button>
            ) : (
              <Button variant="destructive" onClick={cancel}><StopCircle className="mr-1.5 h-3.5 w-3.5" /> Cancel</Button>
            )}
          </div>
          {searching && progress && (
            <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Scanning table <span className="font-mono text-foreground">{progress.scanned} / {progress.total || "…"}</span></span>
              {progress.currentTable && (
                <span className="truncate font-mono">→ {progress.currentTable}</span>
              )}
              <div className="ml-auto h-1 w-40 overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${progress.total ? (progress.scanned / progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-b border-border bg-background px-4 py-2 text-xs">
          <div className="text-muted-foreground">
            {results.length > 0 ? `${results.length} matching row${results.length === 1 ? "" : "s"}` : "No results yet"}
          </div>
          <div className="flex gap-1.5">
            <Button variant="ghost" size="sm" disabled={!results.length} onClick={() => exportData("csv")}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> CSV
            </Button>
            <Button variant="ghost" size="sm" disabled={!results.length} onClick={() => exportData("xlsx")}>
              <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" /> Excel
            </Button>
          </div>
        </div>

        <ResultsTable results={results} onView={setViewing} />
      </main>

      <RecordViewer record={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

/* ---------------- Table selector ---------------- */

function TableSelector(props: {
  schema: SchemaSnapshot;
  selected: TableInfo[];
  onChange: (t: TableInfo[]) => void;
}) {
  const { schema, selected, onChange } = props;
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return schema.tables.filter((t) =>
      !needle || `${t.schema}.${t.name}`.toLowerCase().includes(needle),
    );
  }, [schema.tables, q]);

  const selectedKey = (t: TableInfo) => `${t.schema}.${t.name}`;
  const isSelected = (t: TableInfo) =>
    selected.some((s) => selectedKey(s) === selectedKey(t));

  const toggle = (t: TableInfo) => {
    if (isSelected(t)) onChange(selected.filter((s) => selectedKey(s) !== selectedKey(t)));
    else onChange([...selected, t]);
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <Label className="text-xs font-medium text-muted-foreground">Tables</Label>
        {selected.length > 0 && (
          <button onClick={() => onChange([])} className="text-[11px] text-primary hover:underline">
            Clear ({selected.length})
          </button>
        )}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full justify-between text-xs font-normal">
            <span className="flex items-center gap-1.5 truncate">
              <TableIcon className="h-3.5 w-3.5" />
              {selected.length === 0 ? `All tables (${schema.tables.length})` : `${selected.length} selected`}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[340px] p-0" align="start">
          <div className="border-b border-border p-2">
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search tables…"
              className="h-8 text-xs"
            />
          </div>
          <ScrollArea className="h-[320px]">
            <div className="p-1">
              {filtered.length === 0 && (
                <div className="p-3 text-center text-xs text-muted-foreground">No tables match.</div>
              )}
              {filtered.map((t) => {
                const key = selectedKey(t);
                const checked = isSelected(t);
                return (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
                  >
                    <Checkbox checked={checked} onCheckedChange={() => toggle(t)} />
                    <span className="font-mono">
                      <span className="text-muted-foreground">{t.schema}.</span>
                      <span>{t.name}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
      {selected.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {selected.slice(0, 10).map((t) => (
            <Badge key={selectedKey(t)} variant="secondary" className="gap-1 font-mono text-[10px]">
              {t.schema}.{t.name}
              <button onClick={() => toggle(t)} className="hover:text-destructive">
                <X className="h-2.5 w-2.5" />
              </button>
            </Badge>
          ))}
          {selected.length > 10 && (
            <Badge variant="outline" className="text-[10px]">+{selected.length - 10} more</Badge>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Type filter ---------------- */

function TypeFilter(props: {
  enabled: { text: boolean; number: boolean; id: boolean };
  onChange: (v: { text: boolean; number: boolean; id: boolean }) => void;
}) {
  const { enabled, onChange } = props;
  const Row = ({ k, label, types }: { k: "text" | "number" | "id"; label: string; types: readonly string[] }) => (
    <label className="flex cursor-pointer items-start gap-2 rounded p-2 hover:bg-accent">
      <Checkbox checked={enabled[k]} onCheckedChange={(v) => onChange({ ...enabled, [k]: !!v })} />
      <div className="min-w-0">
        <div className="text-xs font-medium">{label}</div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
          {types.join(", ")}
        </div>
      </div>
    </label>
  );
  return (
    <div>
      <Label className="mb-1.5 block text-xs font-medium text-muted-foreground">Column data types</Label>
      <div className="rounded-md border border-border bg-background/60 p-1">
        <Row k="text" label="Text" types={TEXT_TYPES} />
        <Row k="number" label="Number" types={NUMBER_TYPES} />
        <Row k="id" label="ID" types={ID_TYPES} />
      </div>
    </div>
  );
}

/* ---------------- Results table ---------------- */

function ResultsTable({ results, onView }: { results: SearchResultRow[]; onView: (r: SearchResultRow) => void }) {
  if (!results.length) {
    return (
      <div className="flex flex-1 items-center justify-center p-10 text-center">
        <div>
          <Search className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            Enter a value above and run a search. Matches will appear here.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
          <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-2 font-medium">Table</th>
            <th className="px-4 py-2 font-medium">Column</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Matched Value</th>
            <th className="w-16 px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => (
            <tr key={i} className="border-b border-border/50 hover:bg-accent/50">
              <td className="px-4 py-2 font-mono text-xs">
                <span className="text-muted-foreground">{r.schema}.</span>{r.table}
              </td>
              <td className="px-4 py-2 font-mono text-xs">{r.column}</td>
              <td className="px-4 py-2">
                <Badge variant="outline" className="font-mono text-[10px]">{r.dataType}</Badge>
              </td>
              <td className="px-4 py-2 font-mono text-xs">
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">{r.value}</span>
              </td>
              <td className="px-2 py-2 text-right">
                <Button variant="ghost" size="sm" onClick={() => onView(r)}>
                  <Eye className="h-3.5 w-3.5" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- Full record viewer ---------------- */

function RecordViewer({ record, onClose }: { record: SearchResultRow | null; onClose: () => void }) {
  const [full, setFull] = useState<{ row: Record<string, unknown> | null; primaryKey: string[] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!record) { setFull(null); return; }
    const erp = getErp();
    if (!erp) { setFull({ row: record.row, primaryKey: [] }); return; }
    setLoading(true);
    erp.getRecord({ schema: record.schema, table: record.table, column: record.column, value: record.value })
      .then((r) => setFull(r.row ? r : { row: record.row, primaryKey: r.primaryKey }))
      .catch(() => setFull({ row: record.row, primaryKey: [] }))
      .finally(() => setLoading(false));
  }, [record]);

  return (
    <Dialog open={!!record} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            {record && `${record.schema}.${record.table}`}
          </DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : !full?.row ? (
          <div className="py-6 text-center text-sm text-muted-foreground">No row data available.</div>
        ) : (
          <ScrollArea className="max-h-[60vh]">
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(full.row).map(([k, v]) => {
                  const isPk = full.primaryKey.includes(k);
                  return (
                    <tr key={k} className="border-b border-border/50">
                      <td className="w-1/3 px-2 py-1.5 align-top font-mono text-xs text-muted-foreground">
                        {isPk && <Badge variant="outline" className="mr-1.5 text-[9px]">PK</Badge>}
                        {k}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-xs break-all">
                        {v == null ? <span className="text-muted-foreground italic">NULL</span> : String(v)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}