import { useEffect, useRef, useState } from "react";
import { Loader2, ShieldCheck, StopCircle, Download, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { getErp } from "@/lib/erp/client";
import { TableMultiSelect } from "./TableMultiSelect";
import type { SchemaSnapshot, HealthCheckViolation, TableInfo } from "@/lib/erp/types";

export function DataHealthChecker({ schema }: { schema: SchemaSnapshot; dark?: boolean }) {
  const [selectedTables, setSelectedTables] = useState<TableInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [progress, setProgress] = useState<{
    index: number; total: number; currentTable: string;
    outerIndex: number; outerTotal: number;
  } | null>(null);
  const [violations, setViolations] = useState<HealthCheckViolation[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSummary, setLastSummary] = useState<string>("");

  const offRef = useRef<(() => void) | null>(null);
  const cancelRef = useRef(false);
  useEffect(() => () => { offRef.current?.(); }, []);

  const keyOf = (v: HealthCheckViolation, i: number) =>
    `${v.schema}.${v.table}.${v.column}.${v.recordId}.${i}`;

  const runScan = async () => {
    const erp = getErp();
    if (!erp) { toast.error("SQL access requires the Electron desktop build."); return; }

    setViolations([]);
    setSelected(new Set());
    setScanning(true);
    setCancelled(false);
    cancelRef.current = false;

    // Targets: empty multi-selection means All Tables (single run).
    const targets: Array<{ schema?: string; table?: string; label: string }> =
      selectedTables.length === 0
        ? [{ label: "(all tables)" }]
        : selectedTables.map((t) => ({ schema: t.schema, table: t.name, label: `${t.schema}.${t.name}` }));

    setProgress({ index: 0, total: 0, currentTable: "", outerIndex: 0, outerTotal: targets.length });

    offRef.current?.();
    offRef.current = erp.onHealthCheckProgress((p) => {
      setProgress((prev) => ({
        index: p.index,
        total: p.total,
        currentTable: p.currentTable,
        outerIndex: prev?.outerIndex ?? 0,
        outerTotal: prev?.outerTotal ?? targets.length,
      }));
      if (p.warning) console.warn(`[${p.currentTable}]`, p.warning);
    });

    const allViolations: HealthCheckViolation[] = [];
    let scannedSum = 0;
    let totalSum = 0;
    let durationSum = 0;
    let aborted = false;
    const started = Date.now();

    try {
      for (let i = 0; i < targets.length; i++) {
        if (cancelRef.current) { aborted = true; break; }
        const t = targets[i];
        setProgress((prev) => ({
          index: 0, total: 0, currentTable: t.label,
          outerIndex: i + 1, outerTotal: targets.length,
        }));
        const r = await erp.runHealthCheck({ schema: t.schema, table: t.table });
        allViolations.push(...r.violations);
        scannedSum += r.scanned;
        totalSum += r.total;
        durationSum += r.durationMs;
        if (r.aborted) { aborted = true; break; }
      }
      setViolations(allViolations);
      const tag = aborted ? "Cancelled" : "Complete";
      const ms = durationSum || (Date.now() - started);
      setLastSummary(
        `${tag}: ${allViolations.length} violation(s) across ${scannedSum}/${totalSum} table-scan(s) ` +
        `over ${targets.length} target(s) (${ms}ms)`,
      );
      toast.success(`${tag}: ${allViolations.length} violation(s) found`);
    } catch (e) {
      toast.error(`Health check failed: ${(e as Error).message}`);
    } finally {
      setScanning(false);
      offRef.current?.();
      offRef.current = null;
    }
  };

  const cancel = async () => {
    cancelRef.current = true;
    setCancelled(true);
    await getErp()?.cancelHealthCheck();
  };

  const toggleAll = (checked: boolean) => {
    if (!checked) { setSelected(new Set()); return; }
    setSelected(new Set(violations.map((v, i) => keyOf(v, i))));
  };

  const toggleOne = (key: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  };

  const exportCsv = () => {
    const rows = violations.filter((v, i) => selected.has(keyOf(v, i)));
    if (!rows.length) { toast.error("Select at least one row to export."); return; }
    const headers = ["Schema", "Table", "Column", "DataType", "AllowedLength", "ActualLength", "PrimaryKey", "RecordId"];
    const esc = (s: unknown) => {
      const v = s == null ? "" : String(s);
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const lines = [
      headers.join(","),
      ...rows.map((r) =>
        [r.schema, r.table, r.column, r.dataType, r.allowedLength, r.actualLength, r.primaryKey, r.recordId]
          .map(esc).join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url; a.download = `data-health-violations-${ts}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const allChecked = violations.length > 0 && selected.size === violations.length;
  const someChecked = selected.size > 0 && !allChecked;

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[320px] flex-1">
            <Label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Table Filter (empty = all tables)
            </Label>
            <TableMultiSelect
              tables={schema.tables}
              selected={selectedTables}
              onChange={setSelectedTables}
              triggerClassName="w-full"
              contentWidth={380}
            />
          </div>
          {!scanning ? (
            <Button onClick={runScan}>
              <ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> Run Health Check
            </Button>
          ) : (
            <Button variant="destructive" onClick={cancel} disabled={cancelled}>
              <StopCircle className="mr-1.5 h-3.5 w-3.5" /> {cancelled ? "Cancelling…" : "Cancel"}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={exportCsv}
            disabled={!selected.size}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV ({selected.size})
          </Button>
        </div>
        {scanning && progress && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {progress.outerTotal > 1 && (
              <span>
                Target <span className="font-mono text-foreground">{progress.outerIndex} / {progress.outerTotal}</span>
              </span>
            )}
            <span>Scanning <span className="font-mono text-foreground">{progress.index} / {progress.total || "…"}</span></span>
            {progress.currentTable && (
              <span className="truncate font-mono">→ {progress.currentTable}</span>
            )}
          </div>
        )}
        {!scanning && lastSummary && (
          <div className="mt-3 text-xs text-muted-foreground">{lastSummary}</div>
        )}
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            Read-only scan. Detects existing rows whose <code className="rounded bg-muted px-1 py-0.5">LEN(column)</code> exceeds the declared
            <code className="rounded bg-muted px-1 py-0.5">varchar / nvarchar / char / nchar</code> length. No data is modified.
          </div>
        </div>
      </Card>

      <Card className="p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">Violations</h2>
            <Badge variant="outline">{violations.length}</Badge>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Selected: {selected.size}</span>
          </div>
        </div>
        <ScrollArea className="h-[calc(100vh-340px)]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-card text-left text-muted-foreground">
              <tr className="border-b border-border">
                <th className="w-10 px-3 py-2">
                  <Checkbox
                    checked={allChecked ? true : someChecked ? "indeterminate" : false}
                    onCheckedChange={(v) => toggleAll(!!v)}
                    disabled={!violations.length}
                  />
                </th>
                <th className="px-3 py-2 font-medium">Table</th>
                <th className="px-3 py-2 font-medium">Column</th>
                <th className="px-3 py-2 font-medium">Data Type</th>
                <th className="px-3 py-2 font-medium text-right">Allowed</th>
                <th className="px-3 py-2 font-medium text-right">Actual</th>
                <th className="px-3 py-2 font-medium">Record Identifier</th>
              </tr>
            </thead>
            <tbody>
              {violations.length === 0 && !scanning && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">
                    No violations to display. Run a health check to scan.
                  </td>
                </tr>
              )}
              {violations.map((v, i) => {
                const k = keyOf(v, i);
                const checked = selected.has(k);
                return (
                  <tr key={k} className="border-b border-border/50 hover:bg-muted/30">
                    <td className="px-3 py-1.5">
                      <Checkbox checked={checked} onCheckedChange={(c) => toggleOne(k, !!c)} />
                    </td>
                    <td className="px-3 py-1.5 font-mono">{v.schema}.{v.table}</td>
                    <td className="px-3 py-1.5 font-mono">{v.column}</td>
                    <td className="px-3 py-1.5">
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {v.dataType}({v.allowedLength})
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">{v.allowedLength}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-destructive">{v.actualLength}</td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">
                      {v.primaryKey ? `${v.primaryKey}=${v.recordId}` : <span className="italic">no PK</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollArea>
      </Card>
    </div>
  );
}
