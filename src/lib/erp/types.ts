export interface ConnectionConfig {
  server: string;
  database: string;
  user: string;
  password: string;
  port?: number;
  encrypt?: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
}

export interface ColumnInfo {
  schema: string;
  table: string;
  column: string;
  type: string;
}

export interface SchemaSnapshot {
  tables: TableInfo[];
  columns: ColumnInfo[];
  fetchedAt: number;
}

export type SearchMode = "contains" | "starts" | "exact";

export interface SearchParams {
  value: string;
  mode: SearchMode;
  maxResults: number;
  selectedTables: TableInfo[];
  allowedTypes: string[];
}

export interface SearchResultRow {
  schema: string;
  table: string;
  column: string;
  dataType: string;
  value: string;
  row: Record<string, unknown>;
}

export interface SearchResponse {
  results: SearchResultRow[];
  scanned: number;
  total: number;
  durationMs?: number;
  aborted?: boolean;
}

export interface SearchProgress {
  scanned: number;
  total: number;
  currentTable: string;
  warning?: string;
}

export interface ErpApi {
  isElectron: boolean;
  test: (cfg: ConnectionConfig) => Promise<{ ok: boolean; error?: string }>;
  connect: (cfg: ConnectionConfig) => Promise<{ ok: boolean; schema: SchemaSnapshot }>;
  disconnect: () => Promise<{ ok: boolean }>;
  getSchema: () => Promise<SchemaSnapshot>;
  search: (params: SearchParams) => Promise<SearchResponse>;
  cancelSearch: () => Promise<{ ok: boolean }>;
  getRecord: (p: { schema: string; table: string; column: string; value: string }) => Promise<{
    row: Record<string, unknown> | null;
    primaryKey: string[];
  }>;
  onSearchProgress: (cb: (p: SearchProgress) => void) => () => void;
  getServerInfo: () => Promise<ServerInfo>;
  getDatabaseSize: () => Promise<DatabaseSize>;
  getLogSize: () => Promise<DatabaseSize>;
  shrinkDatabase: () => Promise<{ ok: boolean; database: string; durationMs: number }>;
  getFragmentation: (p?: { threshold?: number }) => Promise<FragmentationRow[]>;
  runIndexMaintenance: (p?: { threshold?: number }) => Promise<{
    total: number;
    processed: Array<FragmentationRow & { action: "REBUILD" | "REORGANIZE"; ok: boolean; error?: string }>;
    aborted: boolean;
    durationMs: number;
  }>;
  cancelMaintenance: () => Promise<{ ok: boolean }>;
  onMaintenanceProgress: (cb: (p: MaintenanceProgress) => void) => () => void;
  getTableColumns: (p: { schema: string; table: string }) => Promise<TableColumnInfo[]>;
  getColumnDependencies: (p: { schema: string; table: string; column: string }) => Promise<ColumnDependencies>;
  executeAlterStatements: (p: { statements: string[] }) => Promise<{
    ok: boolean;
    error?: string;
    executed: string[];
  }>;
  getForeignKeys: () => Promise<ForeignKeyInfo[]>;
  runDataExplorerQuery: (spec: DataExplorerSpec) => Promise<DataExplorerResult>;
}

export interface ForeignKeyInfo {
  parentSchema: string;
  parentTable: string;
  parentColumn: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
}

export interface DataExplorerTable {
  schema: string;
  name: string;
  alias: string;
}

export interface DataExplorerJoin {
  leftAlias: string;
  leftColumn: string;
  rightAlias: string;
  rightColumn: string;
  joinType?: "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS";
  source?: "auto" | "manual";
}

export interface DataExplorerCondition {
  andOr: "AND" | "OR";
  alias: string;
  column: string;
  operator: string;
  value?: string | number | boolean | null;
  value2?: string | number | boolean | null;
  groupOpen?: boolean;
  groupClose?: boolean;
  /** Additive: raw SQL predicate for conditions the builder can't model. */
  raw?: string;
}

export interface DataExplorerSelectColumn {
  expression: string;
  alias?: string;
}
export interface DataExplorerGroupBy { expression: string; }
export interface DataExplorerOrderBy { expression: string; direction: "ASC" | "DESC"; }
export interface DataExplorerWindowFunction {
  name: string;
  expression?: string;
  partitionBy: string[];
  orderBy: string;
  alias: string;
}

export interface DataExplorerSpec {
  tables: DataExplorerTable[];
  joins: DataExplorerJoin[];
  conditions: DataExplorerCondition[];
  limit?: number;
  /** Additive (Import Script flow) — all optional, omitted = original behaviour. */
  selectColumns?: DataExplorerSelectColumn[];
  groupBy?: DataExplorerGroupBy[];
  orderBy?: DataExplorerOrderBy[];
  windowFunctions?: DataExplorerWindowFunction[];
  distinct?: boolean;
  rawSql?: string; 
}

export interface DataExplorerResult {
  columns: string[];
  rows: Record<string, unknown>[];
  sql: string;
  durationMs: number;
}




export interface TableColumnInfo {
  columnName: string;
  dataType: string;
  charMaxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  isNullable: "YES" | "NO";
  ordinal: number;
  isPrimaryKey: boolean;
  fkRefSchema: string | null;
  fkRefTable: string | null;
  fkRefColumn: string | null;
}

export interface ColumnDependencies {
  foreignKeys: Array<{
    fkName: string;
    parentSchema: string;
    parentTable: string;
    parentColumn: string;
    refSchema: string;
    refTable: string;
    refColumn: string;
  }>;
  indexes: Array<{
    indexName: string;
    isPrimaryKey: boolean;
    isUniqueConstraint: boolean;
    indexType: string;
  }>;
}



export interface ServerInfo {
  ServerName?: string;
  DatabaseName?: string;
  Version?: string;
  Edition?: string;
  Level?: string;
}

export interface DatabaseSize {
  totalMB: number;
  usedMB: number;
  freeMB: number;
}

export interface FragmentationRow {
  TableName: string;
  IndexName: string;
  IndexType: string;
  Fragmentation: number;
}

export interface MaintenanceProgress {
  index: number;
  total: number;
  tableName: string;
  indexName: string;
  fragmentation: number;
  action: "REBUILD" | "REORGANIZE";
  status: "running" | "done" | "error";
  error?: string;
}

declare global {
  interface Window {
    erp?: ErpApi;
  }
}

export const TEXT_TYPES = [
  "varchar", "nvarchar", "char", "nchar", "text", "ntext",
] as const;
export const NUMBER_TYPES = [
  "int", "bigint", "smallint", "tinyint", "decimal", "numeric", "money", "smallmoney",
] as const;
export const ID_TYPES = ["uniqueidentifier"] as const;