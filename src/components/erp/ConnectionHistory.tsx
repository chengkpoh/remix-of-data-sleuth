import { useEffect, useMemo, useState } from "react";
import { History, Plus, Pencil, Trash2, Check, X, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { PasswordInput } from "./PasswordInput";
import type { ConnectionConfig } from "@/lib/erp/types";

export interface ConnectionHistoryRecord {
  dbCode: string;
  cfg: ConnectionConfig;
  updatedAt: number;
}

const STORAGE_KEY = "erp:connection-history";

export function loadHistory(): ConnectionHistoryRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as ConnectionHistoryRecord[];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveHistory(records: ConnectionHistoryRecord[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

export function upsertHistoryRecord(rec: ConnectionHistoryRecord): { ok: boolean; error?: string } {
  const code = rec.dbCode.trim();
  if (!code) return { ok: false, error: "DB Code is required." };
  const all = loadHistory();
  const idx = all.findIndex((r) => r.dbCode.toLowerCase() === code.toLowerCase());
  if (idx >= 0) {
    all[idx] = { ...rec, dbCode: code, updatedAt: Date.now() };
  } else {
    all.push({ ...rec, dbCode: code, updatedAt: Date.now() });
  }
  saveHistory(all);
  return { ok: true };
}

const EMPTY_CFG: ConnectionConfig = {
  server: "", database: "", user: "", password: "", port: 1433, encrypt: false,
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentCfg: ConnectionConfig;
  onSelect: (cfg: ConnectionConfig) => void;
}

export function ConnectionHistoryDialog({ open, onOpenChange, currentCfg, onSelect }: Props) {
  const [records, setRecords] = useState<ConnectionHistoryRecord[]>([]);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [draft, setDraft] = useState<ConnectionHistoryRecord>({
    dbCode: "", cfg: EMPTY_CFG, updatedAt: 0,
  });
  const [search, setSearch] = useState("");

  useEffect(() => { if (open) setRecords(loadHistory()); }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...records]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((r) => !q ||
        r.dbCode.toLowerCase().includes(q) ||
        r.cfg.server.toLowerCase().includes(q) ||
        r.cfg.database.toLowerCase().includes(q));
  }, [records, search]);

  const beginAdd = () => {
    setIsNew(true);
    setEditingCode("");
    setDraft({ dbCode: "", cfg: { ...currentCfg }, updatedAt: 0 });
  };
  const beginEdit = (r: ConnectionHistoryRecord) => {
    setIsNew(false);
    setEditingCode(r.dbCode);
    setDraft({ ...r, cfg: { ...r.cfg } });
  };
  const cancelEdit = () => { setEditingCode(null); setIsNew(false); };

  const persistDraft = () => {
    const code = draft.dbCode.trim();
    if (!code) { toast.error("DB Code is required."); return; }
    const existing = records.find(
      (r) => r.dbCode.toLowerCase() === code.toLowerCase() &&
        (isNew || r.dbCode.toLowerCase() !== (editingCode ?? "").toLowerCase()),
    );
    if (existing) { toast.error(`A record with DB Code "${code}" already exists.`); return; }
    let next = [...records];
    if (!isNew && editingCode != null) {
      next = next.filter((r) => r.dbCode.toLowerCase() !== editingCode.toLowerCase());
    }
    next.push({ ...draft, dbCode: code, updatedAt: Date.now() });
    saveHistory(next);
    setRecords(next);
    cancelEdit();
    toast.success(isNew ? "Connection saved" : "Connection updated");
  };

  const removeRecord = (code: string) => {
    const next = records.filter((r) => r.dbCode.toLowerCase() !== code.toLowerCase());
    saveHistory(next);
    setRecords(next);
    toast.success("Connection deleted");
  };

  const useRecord = (r: ConnectionHistoryRecord) => {
    onSelect({ ...r.cfg });
    onOpenChange(false);
    toast.success(`Loaded "${r.dbCode}"`);
  };

  const setField = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) =>
    setDraft((d) => ({ ...d, cfg: { ...d.cfg, [k]: v } }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> Connection History
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by DB code, server, database…"
            className="h-8 text-xs"
          />
          <Button size="sm" onClick={beginAdd} disabled={editingCode !== null}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add
          </Button>
        </div>

        <ScrollArea className="max-h-[55vh] rounded-md border border-border">
          {filtered.length === 0 && editingCode === null && (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No saved connections. Click <span className="font-medium">Add</span> to save the current form, or
              connect once and re-open this dialog.
            </div>
          )}

          {editingCode !== null && (
            <DraftEditor
              isNew={isNew}
              draft={draft}
              setDbCode={(v) => setDraft((d) => ({ ...d, dbCode: v }))}
              setField={setField}
              onCancel={cancelEdit}
              onSave={persistDraft}
            />
          )}

          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card text-left text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-medium">DB Code</th>
                <th className="px-3 py-2 font-medium">Server</th>
                <th className="px-3 py-2 font-medium">Database</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="w-[200px] px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.dbCode} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="px-3 py-1.5 font-mono">
                    <Badge variant="outline">{r.dbCode}</Badge>
                  </td>
                  <td className="px-3 py-1.5 font-mono">{r.cfg.server}</td>
                  <td className="px-3 py-1.5 font-mono">{r.cfg.database}</td>
                  <td className="px-3 py-1.5 font-mono">{r.cfg.user}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {new Date(r.updatedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => useRecord(r)} title="Use">
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => beginEdit(r)} title="Edit">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost"
                        onClick={() => removeRecord(r.dbCode)} title="Delete">
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DraftEditor(props: {
  isNew: boolean;
  draft: ConnectionHistoryRecord;
  setDbCode: (v: string) => void;
  setField: <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { isNew, draft, setDbCode, setField, onCancel, onSave } = props;
  return (
    <div className="space-y-3 border-b border-border bg-muted/30 p-3">
      <div className="text-xs font-medium">{isNew ? "Add Connection" : `Edit "${draft.dbCode}"`}</div>
      <div className="grid grid-cols-2 gap-2">
        <Tiny label="DB Code (unique)">
          <Input
            value={draft.dbCode}
            onChange={(e) => setDbCode(e.target.value)}
            placeholder="PROD-01"
            className="h-8 text-xs"
          />
        </Tiny>
        <Tiny label="Server">
          <Input
            value={draft.cfg.server}
            onChange={(e) => setField("server", e.target.value)}
            placeholder="localhost\SQLEXPRESS"
            className="h-8 text-xs"
          />
        </Tiny>
        <Tiny label="Database">
          <Input
            value={draft.cfg.database}
            onChange={(e) => setField("database", e.target.value)}
            className="h-8 text-xs"
          />
        </Tiny>
        <Tiny label="Port">
          <Input
            type="number"
            value={draft.cfg.port ?? 1433}
            onChange={(e) => setField("port", Number(e.target.value) || 1433)}
            className="h-8 text-xs"
          />
        </Tiny>
        <Tiny label="Username">
          <Input
            value={draft.cfg.user}
            onChange={(e) => setField("user", e.target.value)}
            className="h-8 text-xs"
            autoComplete="off"
          />
        </Tiny>
        <Tiny label="Password">
          <PasswordInput
            value={draft.cfg.password}
            onChange={(e) => setField("password", e.target.value)}
            className="h-8 text-xs"
            autoComplete="off"
          />
        </Tiny>
        <label className="col-span-2 flex items-center gap-2 text-xs">
          <Checkbox
            checked={!!draft.cfg.encrypt}
            onCheckedChange={(v) => setField("encrypt", !!v)}
          />
          <span>Encrypt connection (TLS)</span>
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onCancel}>
          <X className="mr-1.5 h-3.5 w-3.5" /> Cancel
        </Button>
        <Button size="sm" onClick={onSave}>
          <Save className="mr-1.5 h-3.5 w-3.5" /> Save
        </Button>
      </div>
    </div>
  );
}

function Tiny({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
