import { useEffect, useRef, useState } from "react";
import {
  Server, HardDrive, Wrench, Loader2, AlertTriangle, RefreshCw,
  Database as DatabaseIcon, StopCircle, CheckCircle2, XCircle, FileText,
} from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { getErp } from "@/lib/erp/client";
import type {
  ServerInfo, DatabaseSize, MaintenanceProgress,
} from "@/lib/erp/types";

const USED_COLOR = "#eab308"; // yellow
const FREE_COLOR = "#3b82f6"; // blue


type MaintLogEntry = MaintenanceProgress & { ts: number };

export function Dashboard({ dark }: { dark: boolean }) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [size, setSize] = useState<DatabaseSize | null>(null);
  const [loading, setLoading] = useState(false);

  const [shrinking, setShrinking] = useState(false);
  const [askShrink, setAskShrink] = useState(false);

  const [maintRunning, setMaintRunning] = useState(false);
  const [maintCurrent, setMaintCurrent] = useState<MaintenanceProgress | null>(null);
  const [maintLog, setMaintLog] = useState<MaintLogEntry[]>([]);
  const [askMaint, setAskMaint] = useState(false);
  const offRef = useRef<(() => void) | null>(null);

  const refresh = async () => {
    const erp = getErp();
    if (!erp) return;
    setLoading(true);
    try {
      const [i, s] = await Promise.all([erp.getServerInfo(), erp.getDatabaseSize()]);
      setInfo(i);
      setSize(s);
    } catch (e) {
      toast.error(`Dashboard load failed: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    return () => { offRef.current?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runShrink = async () => {
    const erp = getErp();
    if (!erp) return;
    setShrinking(true);
    try {
      const r = await erp.shrinkDatabase();
      toast.success(`Database [${r.database}] shrunk in ${r.durationMs}ms`);
      await refresh();
    } catch (e) {
      toast.error(`Shrink failed: ${(e as Error).message}`);
    } finally {
      setShrinking(false);
    }
  };

  const runMaintenance = async () => {
    const erp = getErp();
    if (!erp) return;
    setMaintLog([]);
    setMaintCurrent(null);
    setMaintRunning(true);
    offRef.current?.();
    offRef.current = erp.onMaintenanceProgress((p) => {
      setMaintCurrent(p);
      setMaintLog((prev) => [...prev, { ...p, ts: Date.now() }]);
    });
    try {
      const r = await erp.runIndexMaintenance({ threshold: 5 });
      const ok = r.processed.filter((x) => x.ok).length;
      const errs = r.processed.length - ok;
      const tag = r.aborted ? "Cancelled" : "Complete";
      toast.success(`${tag}: ${ok} index(es) maintained${errs ? `, ${errs} error(s)` : ""} in ${r.durationMs}ms`);
    } catch (e) {
      toast.error(`Maintenance failed: ${(e as Error).message}`);
    } finally {
      setMaintRunning(false);
      offRef.current?.();
      offRef.current = null;
    }
  };

  const cancelMaintenance = async () => { await getErp()?.cancelMaintenance(); };

  const used = size?.usedMB ?? 0;
  const free = size?.freeMB ?? 0;
  const total = size?.totalMB ?? 0;
  const usedPct = total ? (used / total) * 100 : 0;
  const freePct = total ? (free / total) * 100 : 0;

  const pieData = [
    { name: "Used", value: Math.max(used, 0.0001), color: USED_COLOR },
    { name: "Free", value: Math.max(free, 0.0001), color: FREE_COLOR },
  ];

  return (
    <div className="min-h-[calc(100vh-49px)] overflow-auto p-4">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        {/* SQL Server Info */}
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">SQL Server Information</h2>
            </div>
            <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <InfoCell label="Server Name" value={info?.ServerName} />
            <InfoCell label="Database Name" value={info?.DatabaseName} />
            <InfoCell label="SQL Version" value={info?.Version} sub={info?.Level} />
            <InfoCell label="SQL Edition" value={info?.Edition} />
          </div>
        </Card>

        {/* Storage */}
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Database Storage</h2>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
            <div className="relative h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={2}
                    stroke="none"
                  >
                    {pieData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: number) => `${v.toFixed(2)} MB`}
                    contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }}
                    itemStyle={{ color: dark ? "#ffffff" : "#000000" }}
                    labelStyle={{ color: dark ? "#ffffff" : "#000000" }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <div className="text-xs text-muted-foreground">Used</div>
                <div className="text-xl font-semibold">{usedPct.toFixed(1)}%</div>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-4 text-xs">
                <LegendDot color={USED_COLOR} label={`Used ${usedPct.toFixed(1)}%`} />
                <LegendDot color={FREE_COLOR} label={`Unused ${freePct.toFixed(1)}%`} />
              </div>
              <Separator />
              <div className="grid grid-cols-3 gap-3">
                <SizeStat label="Total" mb={total} />
                <SizeStat label="Used" mb={used} accent />
                <SizeStat label="Free" mb={free} />
              </div>
            </div>
          </div>
        </Card>

        {/* Maintenance */}
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <Wrench className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Database Maintenance</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setAskShrink(true)} disabled={shrinking || maintRunning}>
              {shrinking ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <DatabaseIcon className="mr-1.5 h-3.5 w-3.5" />}
              Shrink Database
            </Button>
            {!maintRunning ? (
              <Button onClick={() => setAskMaint(true)} disabled={shrinking}>
                <Wrench className="mr-1.5 h-3.5 w-3.5" /> Index Maintenance
              </Button>
            ) : (
              <Button variant="destructive" onClick={cancelMaintenance}>
                <StopCircle className="mr-1.5 h-3.5 w-3.5" /> Cancel Maintenance
              </Button>
            )}
          </div>

          {(maintRunning || maintLog.length > 0) && (
            <div className="mt-4">
              {maintCurrent && (
                <div className="mb-2 flex items-center gap-3 text-xs">
                  {maintRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
                  <span className="font-mono">{maintCurrent.index} / {maintCurrent.total}</span>
                  <span className="font-mono text-muted-foreground truncate">{maintCurrent.tableName}</span>
                  <Badge variant="outline" className="font-mono text-[10px]">{maintCurrent.indexName}</Badge>
                  <Badge variant="outline" className="font-mono text-[10px]">{maintCurrent.fragmentation.toFixed(2)}%</Badge>
                  <Badge className="font-mono text-[10px]">{maintCurrent.action}</Badge>
                  <div className="ml-auto h-1 w-40 overflow-hidden rounded bg-muted">
                    <div className="h-full bg-primary transition-all" style={{ width: `${maintCurrent.total ? (maintCurrent.index / maintCurrent.total) * 100 : 0}%` }} />
                  </div>
                </div>
              )}
              <ScrollArea className="h-[220px] rounded-md border border-border bg-background/60">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card/95 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="px-2 py-1.5 font-medium">#</th>
                      <th className="px-2 py-1.5 font-medium">Table</th>
                      <th className="px-2 py-1.5 font-medium">Index</th>
                      <th className="px-2 py-1.5 font-medium">Frag %</th>
                      <th className="px-2 py-1.5 font-medium">Action</th>
                      <th className="px-2 py-1.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {maintLog.filter((e) => e.status !== "running").map((e, i) => (
                      <tr key={i} className="border-b border-border/40">
                        <td className="px-2 py-1 font-mono text-muted-foreground">{e.index}</td>
                        <td className="px-2 py-1 font-mono">{e.tableName}</td>
                        <td className="px-2 py-1 font-mono">{e.indexName}</td>
                        <td className="px-2 py-1 font-mono">{e.fragmentation.toFixed(2)}</td>
                        <td className="px-2 py-1"><Badge variant="outline" className="font-mono text-[10px]">{e.action}</Badge></td>
                        <td className="px-2 py-1">
                          {e.status === "done" ? (
                            <span className="inline-flex items-center gap-1 text-emerald-500"><CheckCircle2 className="h-3 w-3" /> done</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-destructive" title={e.error}><XCircle className="h-3 w-3" /> error</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollArea>
            </div>
          )}
        </Card>
      </div>

      <AlertDialog open={askShrink} onOpenChange={setAskShrink}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Shrink database?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Shrinking the database may increase index fragmentation. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runShrink}>Shrink</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={askMaint} onOpenChange={setAskMaint}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-primary" />
              Run index maintenance?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Scans <span className="font-mono">sys.dm_db_index_physical_stats</span> and applies
              REORGANIZE (fragmentation ≤ 30%) or REBUILD (&gt; 30%) on every affected index.
              This may take a while on large databases.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runMaintenance}>Run</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function InfoCell({ label, value, sub }: { label: string; value?: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-background/60 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-mono text-sm font-medium" title={value}>
        {value ?? <span className="text-muted-foreground">—</span>}
      </div>
      {sub && <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

function SizeStat({ label, mb, accent }: { label: string; mb: number; accent?: boolean }) {
  const gb = mb / 1024;
  return (
    <div className={`rounded-md border border-border p-2.5 ${accent ? "bg-primary/5" : "bg-background/60"}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold">{mb.toFixed(2)} MB</div>
      <div className="font-mono text-[11px] text-muted-foreground">{gb.toFixed(3)} GB</div>
    </div>
  );
}