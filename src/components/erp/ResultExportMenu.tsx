/**
 * ResultExportMenu.tsx
 * -----------------------------------------------------------------------------
 * A dropdown menu for exporting query results in multiple formats:
 *   - CSV (single file)
 *   - XLSX / Excel (XML SpreadsheetML — opens in Excel, no library needed)
 *   - Split CSV (one file per N rows, default 1000 — for systems that accept
 *     limited rows per import)
 *
 * Usage in DataExplorer.tsx:
 *   <ResultExportMenu rows={resultRows} cols={resultCols} baseName="query_result" />
 *
 * `rows` = array of objects (key = column name).
 * `cols` = ordered list of column names. If omitted, derived from first row.
 * -----------------------------------------------------------------------------
 */
import React, { useState } from "react";
import { Download, FileSpreadsheet, FileText, Scissors } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

interface Props {
  rows: Record<string, any>[];
  cols?: string[];
  baseName?: string;
  disabled?: boolean;
}

/** Escape a value for CSV output. */
function csvEscape(value: any): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Build CSV text from rows + cols. */
function toCsv(rows: Record<string, any>[], cols: string[]): string {
  const header = cols.map(csvEscape).join(",");
  const body = rows.map((r) => cols.map((c) => csvEscape(r[c])).join(","));
  return [header, ...body].join("\r\n");
}

/** Trigger a browser download for the given content. */
function downloadBlob(content: string, fileName: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Build an Excel XML SpreadsheetML 2003 document.
 * Opens natively in Microsoft Excel (no third-party library required).
 */
function toExcelXml(rows: Record<string, any>[], cols: string[], sheetName: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const cellType = (v: any): string => {
    if (v === null || v === undefined || v === "") return "String";
    if (typeof v === "number" && !isNaN(v)) return "Number";
    return "String";
  };

  const cellValue = (v: any): string => {
    if (v === null || v === undefined) return "";
    return esc(typeof v === "string" ? v : String(v));
  };

  const headerRow = `<Row>${cols
    .map((c) => `<Cell><Data ss:Type="String">${esc(c)}</Data></Cell>`)
    .join("")}</Row>`;

  const dataRows = rows
    .map(
      (r) =>
        `<Row>${cols
          .map((c) => {
            const t = cellType(r[c]);
            return `<Cell><Data ss:Type="${t}">${cellValue(r[c])}</Data></Cell>`;
          })
          .join("")}</Row>`
    )
    .join("");

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="${esc(sheetName)}">
  <Table>
   ${headerRow}
   ${dataRows}
  </Table>
 </Worksheet>
</Workbook>`;
}

export default function ResultExportMenu({
  rows,
  cols,
  baseName = "query_result",
  disabled,
}: Props) {
  const [splitSize, setSplitSize] = useState(1000);

  const effectiveCols = cols || (rows.length > 0 ? Object.keys(rows[0]) : []);
  const hasData = rows.length > 0;

  const exportCsv = () => {
    if (!hasData) return toast.error("No rows to export.");
    downloadBlob(toCsv(rows, effectiveCols), `${baseName}.csv`, "text/csv;charset=utf-8");
    toast.success(`Exported ${rows.length} row(s) to CSV.`);
  };

  const exportXlsx = () => {
    if (!hasData) return toast.error("No rows to export.");
    const xml = toExcelXml(rows, effectiveCols, baseName.slice(0, 31) || "Sheet1");
    downloadBlob(xml, `${baseName}.xls`, "application/vnd.ms-excel");
    toast.success(`Exported ${rows.length} row(s) to Excel.`);
  };

  const exportSplitCsv = async () => {
    if (!hasData) return toast.error("No rows to export.");
    const size = Math.max(1, splitSize);
    const totalFiles = Math.ceil(rows.length / size);

    // Try File System Access API (Chromium browsers) — pick folder once, write all files silently.
    const fsAccess = (window as any).showDirectoryPicker;
    if (typeof fsAccess === "function") {
      try {
        const dirHandle = await fsAccess({ mode: "readwrite" });
        const t = toast.loading(`Exporting ${totalFiles} file(s) to folder…`);
        for (let i = 0; i < totalFiles; i++) {
          const chunk = rows.slice(i * size, (i + 1) * size);
          const fileName = `${baseName}_${i + 1}_of_${totalFiles}.csv`;
          const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(toCsv(chunk, effectiveCols));
          await writable.close();
        }
        toast.success(`Exported ${rows.length} row(s) → ${totalFiles} file(s) in selected folder.`, { id: t });
        return;
      } catch (e: any) {
        if (e?.name === "AbortError") return; // user cancelled folder picker
        // Fall through to multi-download fallback
        toast.error("Folder export failed, falling back to individual downloads.");
      }
    }

    // Fallback: multi-download (each file triggers a save prompt)
    for (let i = 0; i < totalFiles; i++) {
      const chunk = rows.slice(i * size, (i + 1) * size);
      const fileName = `${baseName}_${i + 1}_of_${totalFiles}.csv`;
      downloadBlob(toCsv(chunk, effectiveCols), fileName, "text/csv;charset=utf-8");
    }
    toast.success(`Exported ${rows.length} row(s) in ${totalFiles} file(s) (~${size} rows each).`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled || !hasData}>
          <Download className="h-4 w-4 mr-1.5" /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Export Results ({rows.length} rows)</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={exportCsv}>
          <FileText className="h-4 w-4 mr-2" /> CSV (single file)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={exportXlsx}>
          <FileSpreadsheet className="h-4 w-4 mr-2" /> Excel (.xls)
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <Label className="text-xs font-semibold uppercase text-muted-foreground">
            Split CSV (rows per file)
          </Label>
          <div className="flex items-center gap-2 mt-1.5">
            <Input
              type="number"
              min={1}
              value={splitSize}
              onChange={(e) => setSplitSize(parseInt(e.target.value) || 1)}
              className="h-8 text-xs"
            />
            <Button size="sm" variant="outline" onClick={exportSplitCsv} className="h-8">
              <Scissors className="h-3.5 w-3.5 mr-1" /> Split
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            {rows.length > 0
              ? `${Math.ceil(rows.length / Math.max(1, splitSize))} file(s) at ${splitSize} rows each.`
              : "No data."}
          </p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}