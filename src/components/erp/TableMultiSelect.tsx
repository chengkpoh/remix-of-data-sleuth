import { useMemo, useState } from "react";
import { Table as TableIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { TableInfo } from "@/lib/erp/types";

interface Props {
  tables: TableInfo[];
  selected: TableInfo[];
  onChange: (t: TableInfo[]) => void;
  placeholderAll?: string;
  triggerClassName?: string;
  contentWidth?: number;
  align?: "start" | "end" | "center";
}

const keyOf = (t: TableInfo) => `${t.schema}.${t.name}`;

export function TableMultiSelect({
  tables, selected, onChange,
  placeholderAll = "All Tables",
  triggerClassName = "",
  contentWidth = 360,
  align = "start",
}: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tables.filter((t) => !needle || keyOf(t).toLowerCase().includes(needle));
  }, [tables, q]);

  const isSelected = (t: TableInfo) => selected.some((s) => keyOf(s) === keyOf(t));
  const toggle = (t: TableInfo) => {
    if (isSelected(t)) onChange(selected.filter((s) => keyOf(s) !== keyOf(t)));
    else onChange([...selected, t]);
  };
  const selectAllFiltered = () => {
    const map = new Map(selected.map((s) => [keyOf(s), s]));
    filtered.forEach((t) => map.set(keyOf(t), t));
    onChange(Array.from(map.values()));
  };
  const clearAll = () => onChange([]);

  return (
    <div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={`justify-between text-xs font-normal ${triggerClassName}`}
          >
            <span className="flex items-center gap-1.5 truncate">
              <TableIcon className="h-3.5 w-3.5" />
              {selected.length === 0
                ? `${placeholderAll} (${tables.length})`
                : `${selected.length} of ${tables.length} selected`}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0" style={{ width: contentWidth }} align={align}>
          <div className="border-b border-border p-2">
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search tables…"
              className="h-8 text-xs"
            />
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <button
                onClick={selectAllFiltered}
                className="text-primary hover:underline"
                disabled={!filtered.length}
              >
                Select {q ? "filtered" : "all"} ({filtered.length})
              </button>
              <button
                onClick={clearAll}
                className="text-muted-foreground hover:text-destructive"
                disabled={!selected.length}
              >
                Clear ({selected.length})
              </button>
            </div>
          </div>
          <ScrollArea className="h-[320px]">
            <div className="p-1">
              {filtered.length === 0 && (
                <div className="p-3 text-center text-xs text-muted-foreground">No tables match.</div>
              )}
              {filtered.map((t) => {
                const checked = isSelected(t);
                return (
                  <label
                    key={keyOf(t)}
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
          {selected.slice(0, 12).map((t) => (
            <Badge key={keyOf(t)} variant="secondary" className="gap-1 font-mono text-[10px]">
              {t.schema}.{t.name}
              <button onClick={() => toggle(t)} className="hover:text-destructive">
                <X className="h-2.5 w-2.5" />
              </button>
            </Badge>
          ))}
          {selected.length > 12 && (
            <Badge variant="outline" className="text-[10px]">+{selected.length - 12} more</Badge>
          )}
        </div>
      )}
    </div>
  );
}
