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

const ALL_TABLES = "__all__";

export function DataHealthChecker({ schema }: { schema: SchemaSnapshot; dark?: boolean }) {
  const [target, setTarget] = useState<string>(ALL_TABLES);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number; currentTable: string } | null>(null);
  const [violations, setViolations] = useState<HealthCheckViolation[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSummary, setLastSummary] = useState<string>("");

  const offRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { offRef.current?.(); }, []);

  const tableOptions = useMemo(() => {
    return schema.tables.map((t) => ({
      value: `${t.schema}.${t.name}`,
      label: `${t.schema}.${t.name}`,
      schema: t.schema,
      name: t.name,
    }));
  }, [schema]);

  const keyOf = (v: HealthCheckViolation, i: number) =>
    `${v.schema}.${v.table}.${v.column}.${v.recordId}.${i}`;

  const runScan = async () => {
    const erp = getErp();
    if (!erp) { toast.error("SQL access requires the Electron desktop build."); return; }

    setViolations([]);
    setSelected(new Set());
    setProgress({ index: 0, total: 0, currentTable: "" });
    setScanning(true);

    offRef.current?.();
    offRef.current = erp.onHealthCheckProgress((p) => {
      setProgress({ index: p.index, total: p.total, currentTable: p.currentTable });
      if (p.warning) console.warn(`[${p.currentTable}]`, p.warning);
    });

    let params: { schema?: string; table?: string } = {};
    if (target !== ALL_TABLES) {
      const opt = tableOptions.find((o) => o.value === target);
      if (opt) params = { schema: opt.schema, table: opt.name };
    }

    try {
      const r = await erp.runHealthCheck(params);
      setViolations(r.violations);
      const tag = r.aborted ? "Cancelled" : "Complete";
      setLastSummary(`${tag}: ${r.violations.length} violation(s) across ${r.scanned}/${r.total} tables (${r.durationMs}ms)`);
      toast.success(`${tag}: ${r.violations.length} violation(s) found`);
    } catch (e) {
      toast.error(`Health check failed: ${(e as Error).message}`);
    } finally {
      setScanning(false);
      offRef.current?.();
      offRef.current = null;
    }
  };

  const cancel = async () => { await getErp()?.cancelHealthCheck(); };

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
          <div className="min-w-[280px] flex-1">
            <Label className="mb-1.5 block text-xs font-medium text-muted-foreground">Table Filter</Label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_TABLES}>All Tables</SelectItem>
                {tableOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!scanning ? (
            <Button onClick={runScan}>
              <ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> Run Health Check
            </Button>
          ) : (
            <Button variant="destructive" onClick={cancel}>
              <StopCircle className="mr-1.5 h-3.5 w-3.5" /> Cancel
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
          <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
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
