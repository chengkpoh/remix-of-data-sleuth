
# Data Explorer — Option B Implementation Plan

Goal: stable, responsive for 50k–200k rows. Keep every existing feature. Leave a clean seam for a later server-side (Option C) mode.

## Files to modify

1. `src/lib/erp/types.ts`
   Expose the streaming IPC surface already present in `preload.cjs`:
   - `streamDataExplorerQuery(reqId, spec)`
   - `onDataExplorerStart / Batch / Done / Error` (each returns an unsubscribe fn)
   - Add `DataExplorerStreamEvent` types (`start | batch | done | error`).
   Keep `runDataExplorerQuery` for backward compatibility (used as fallback in browser/dev).

2. `src/lib/erp/queryRunner.ts` (new)
   New thin abstraction — the single seam that Option C will later swap:
   ```ts
   type QuerySource = {
     run(spec, handlers: { onStart, onBatch, onDone, onError }): Cancel;
   };
   ```
   Implementations:
   - `streamingElectronSource` — uses the new stream IPC (default when `erp.streamDataExplorerQuery` exists).
   - `bufferedElectronSource` — wraps existing `runDataExplorerQuery` and emits one synthetic batch (fallback).
   - Future `serverPagedSource` (Option C) will implement the same interface but request windows on demand.
   All rendering code depends on this interface, never on `erp.*` directly.

3. `src/components/erp/DataExplorer.tsx` (enhance, no rebuild)
   - Replace the current `runQuery` internals with `queryRunner.run(spec, …)`; keep the same public button/UX and the same call site for both Raw SQL and Query Builder.
   - Streaming state: `columns`, `rowsRef` (mutable array, avoid re-alloc), `receivedCount`, `status: idle|running|done|error|cancelled`, `Cancel` button.
   - Progress toast/inline status: `Received X rows…` updated via `startTransition` on each batch; commit rows into React state on a throttled interval (rAF or every ~250ms / 5k rows) so the grid stays smooth.
   - **Row virtualization**: add `@tanstack/react-virtual` and virtualize the result table body only (header/column-chooser/formatting UI unchanged). Row height fixed; overscan ~10.
   - **Column chooser default for `SELECT *`**: after `start` event, if columns > 25 and query is `SELECT *`-shaped (no explicit `selectColumns`), pre-select the first 20 and show a dismissible banner: *"Query returned N columns — showing first 20. Open Column Chooser to change."* Nothing is dropped from data; only the render/format/calc path skips hidden columns.
   - **Large-result warning**: when `receivedCount` crosses a threshold (default 25k), show a non-blocking banner offering *Cancel* / *Continue* / *Add a filter*. Threshold is a constant so it can become a user setting later.

4. Client-side processing hot paths (same file, targeted refactors)
   - `distinctValues` / `columnValuesCache`: convert to **lazy per-column memo** — compute only when a filter/group popover opens for that column, cache by `(columnId, rowsVersion)`. Cap at e.g. 1000 distinct values with an "…and N more" affordance.
   - `augmentedRows` (calc + display coercion): split into (a) raw rows (from stream) and (b) a memoized derived array keyed by `(rowsVersion, calcColsSignature)`. Only recompute when calc definitions change; new streamed batches append rather than remap.
   - Filtering & sorting: memoize by `(rowsVersion, filterSpec)` / `(…, sortSpec)`; use typed comparators built once per sort key. Sort/filter run in a `startTransition` so typing/scroll stays interactive.
   - Grouping & summary rows: compute lazily only when grouping is enabled; store group index (Map<key, number[]>) separately from row data so toggling group expand/collapse doesn't retouch rows. Aggregations iterate the group index, not full rows.
   - Calculated columns: keep current parser/evaluator; evaluate **per visible virtual row** during render for boolean/simple exprs, and cache heavy expressions per (rowIndex, calcId) in a WeakMap-like LRU. Recompute on calc-definition change only.
   - CSV / clipboard export: chunk the join (e.g. 5k rows per tick) and build via array push + `join("\n")` at the end; keep it off the main-thread critical path with `requestIdleCallback` where available.

5. Seam for Option C (no behavior change now)
   - `DataExplorerSpec` gains optional fields (typed but ignored server-side today): `serverSort?`, `serverFilter?`, `serverGroupBy?`, `page?: { offset, limit }`. Streaming source ignores them; a future `serverPagedSource` will honor them.
   - Sort/filter/group state in the UI is already spec-shaped; we route it through a single `applyClientOps(rows, ops)` helper. Option C will later branch: if the source advertises `capabilities.serverOps`, push `ops` into the spec instead of running `applyClientOps`.
   - Row access in the grid goes through a `RowProvider` (`getRow(i)`, `rowCount`, `isLoaded(i)`) — trivially backed by the in-memory array today, swappable for a windowed provider later.

## What stays exactly the same
- Column chooser UI, drag/drop reorder, conditional formatting rules, grouping UI, summary row config, calculated column editor & expression grammar (incl. the boolean comparison work).
- Existing IPC handlers, SQL builder, schema loading, connection logic.
- Raw SQL panel behavior — it just runs through the same streaming source.

## Dependencies
- Add `@tanstack/react-virtual` (small, MIT). No other new deps.

## Test checklist (post-implementation)
- Raw SQL `SELECT TOP 100000 * FROM …` streams with live "Received X rows"; UI scrollable during load; Cancel works.
- Query Builder path same behavior.
- Column chooser hides/shows without re-querying; drag reorder still works on virtualized grid.
- Conditional formatting still applies to visible virtual rows.
- Grouping + summary rows correct on 50k-row set; expand/collapse instant.
- Calculated column `[d1.CompanyCode] <> [d2.CompanyCode]` still returns TRUE/FALSE.
- CSV export of 50k rows doesn't freeze UI.

Confirm to proceed and I'll implement in this order: types → queryRunner → DataExplorer streaming wiring + virtualization → lazy distinct/filter/sort/group memoization → SELECT * safeguards.
