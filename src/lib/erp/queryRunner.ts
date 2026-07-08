// ============================================================================
// queryRunner.ts — single seam between the Data Explorer UI and its data source.
//
// Today we have two concrete sources:
//   • streamingElectronSource — uses the batched IPC stream handler
//   • bufferedElectronSource  — falls back to the original one-shot IPC
//
// Tomorrow (Option C) we'll add a serverPagedSource with the same interface
// that requests row windows on demand. Nothing in the renderer should reach
// into `window.erp` for Data Explorer queries — always go through here.
// ============================================================================

import type {
  DataExplorerSpec,
  DataExplorerStartEvent,
  DataExplorerBatchEvent,
  DataExplorerDoneEvent,
  DataExplorerErrorEvent,
} from "./types";
import { getErp } from "./client";

export interface QueryHandlers {
  onStart: (e: DataExplorerStartEvent) => void;
  onBatch: (e: DataExplorerBatchEvent) => void;
  onDone: (e: DataExplorerDoneEvent) => void;
  onError: (e: DataExplorerErrorEvent) => void;
}

export interface QueryCapabilities {
  /** Streaming batches vs single buffered payload. */
  streaming: boolean;
  /** Reserved for Option C: source honours spec.serverSort / serverFilter / page. */
  serverOps: boolean;
}

export interface QuerySource {
  readonly name: string;
  readonly capabilities: QueryCapabilities;
  run(spec: DataExplorerSpec, handlers: QueryHandlers): () => void; // returns cancel()
}

let _seq = 0;
const nextReqId = () =>
  `deq-${Date.now().toString(36)}-${(_seq++).toString(36)}`;

// ---------------------------------------------------------------------------
// Streaming source (preferred when the Electron build exposes stream IPC)
// ---------------------------------------------------------------------------
function makeStreamingElectronSource(): QuerySource | null {
  const erp = getErp();
  if (
    !erp?.streamDataExplorerQuery ||
    !erp.onDataExplorerStart ||
    !erp.onDataExplorerBatch ||
    !erp.onDataExplorerDone ||
    !erp.onDataExplorerError
  ) {
    return null;
  }
  return {
    name: "streaming-electron",
    capabilities: { streaming: true, serverOps: false },
    run(spec, handlers) {
      const reqId = nextReqId();
      let cancelled = false;
      const unsub: Array<() => void> = [];

      const guard =
        <T extends { reqId: string }>(cb: (e: T) => void) =>
        (e: T) => {
          if (cancelled || e.reqId !== reqId) return;
          cb(e);
        };

      unsub.push(erp.onDataExplorerStart!(guard(handlers.onStart)));
      unsub.push(erp.onDataExplorerBatch!(guard(handlers.onBatch)));
      unsub.push(
        erp.onDataExplorerDone!(
          guard((e) => {
            handlers.onDone(e);
            unsub.forEach((u) => u());
          }),
        ),
      );
      unsub.push(
        erp.onDataExplorerError!(
          guard((e) => {
            handlers.onError(e);
            unsub.forEach((u) => u());
          }),
        ),
      );

      erp.streamDataExplorerQuery!(reqId, spec);

      return () => {
        cancelled = true;
        unsub.forEach((u) => u());
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Buffered fallback (older Electron builds without the stream handler)
// ---------------------------------------------------------------------------
function makeBufferedElectronSource(): QuerySource | null {
  const erp = getErp();
  if (!erp?.runDataExplorerQuery) return null;
  return {
    name: "buffered-electron",
    capabilities: { streaming: false, serverOps: false },
    run(spec, handlers) {
      const reqId = nextReqId();
      let cancelled = false;
      (async () => {
        try {
          const res = await erp.runDataExplorerQuery(spec);
          if (cancelled) return;
          handlers.onStart({ reqId, columns: res.columns, sql: res.sql });
          if (res.rows.length) {
            handlers.onBatch({
              reqId,
              rows: res.rows,
              received: res.rows.length,
            });
          }
          handlers.onDone({
            reqId,
            totalRows: res.rows.length,
            durationMs: res.durationMs,
          });
        } catch (err) {
          if (cancelled) return;
          handlers.onError({ reqId, message: (err as Error).message });
        }
      })();
      return () => {
        cancelled = true;
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Public factory — pick the best available source.
// ---------------------------------------------------------------------------
export function getDefaultQuerySource(): QuerySource | null {
  return makeStreamingElectronSource() ?? makeBufferedElectronSource();
}
