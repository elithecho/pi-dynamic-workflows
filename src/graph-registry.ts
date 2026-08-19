/**
 * Process-local graph run registry.
 *
 * Owns live {@link GraphRunHandle} instances keyed by run id. Runs are kept
 * indefinitely so status/wait/cancel can observe a run even after it reaches a
 * terminal state. This module is pure: it depends only on the graph contracts
 * and the graph runtime engine, never on pi-* or typebox.
 */

import {
  type CancellationReason,
  type GraphCancelOperationResult,
  GraphContractError,
  type GraphLifecycleEvent,
  type GraphOperationError,
  type GraphRunSnapshot,
  type GraphStartOperationResult,
  type GraphStatusOperationResult,
  type GraphWaitOperationResult,
  type InvokingParentExecutionContext,
  type ModelRegistryLike,
} from "./graph.js";
import { type GraphRunHandle, type NodeExecutor, startGraphRun } from "./graph-runtime.js";

export interface GraphRunRegistryStartOptions {
  readonly executor: NodeExecutor;
  readonly modelRegistry?: ModelRegistryLike;
  readonly runId?: string;
  readonly parentSignal?: AbortSignal;
  readonly onEvent?: (event: GraphLifecycleEvent) => void;
}

/** Process-local registry of graph runs, keyed by run id. */
export class GraphRunRegistry {
  private readonly runs = new Map<string, GraphRunHandle>();

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  snapshot(runId: string): GraphRunSnapshot | undefined {
    return this.runs.get(runId)?.snapshot();
  }

  start(
    graph: unknown,
    parent: InvokingParentExecutionContext,
    options: GraphRunRegistryStartOptions,
  ): GraphStartOperationResult {
    try {
      const handle = startGraphRun(graph, {
        executor: options.executor,
        parentContext: parent,
        modelRegistry: options.modelRegistry,
        runId: options.runId,
        onEvent: options.onEvent,
        parentSignal: options.parentSignal,
      });
      // startGraphRun is synchronous (microtask scheduling may already be in
      // flight); register the handle before returning so status/wait/cancel
      // observe the run immediately.
      this.runs.set(handle.runId, handle);
      const snapshot = handle.snapshot();
      return {
        ok: true,
        result: {
          runId: handle.runId,
          state: snapshot.state === "running" ? "running" : "created",
        },
      };
    } catch (error) {
      if (error instanceof GraphContractError) {
        return { ok: false, error: { code: error.code, message: error.message } };
      }
      return { ok: false, error: { code: "invalid_state", message: String(error) } };
    }
  }

  status(runId: string): GraphStatusOperationResult {
    const handle = this.runs.get(runId);
    if (handle === undefined) return this.runNotFound(runId);
    return { ok: true, result: { run: handle.snapshot() } };
  }

  async wait(runId: string, timeoutMs?: number): Promise<GraphWaitOperationResult> {
    const handle = this.runs.get(runId);
    if (handle === undefined) return this.runNotFound(runId);
    return { ok: true, result: await handle.wait(timeoutMs) };
  }

  cancel(runId: string, reason: CancellationReason = "requested"): GraphCancelOperationResult {
    const handle = this.runs.get(runId);
    if (handle === undefined) return this.runNotFound(runId);
    return { ok: true, result: handle.cancel(reason) };
  }

  private runNotFound(runId: string): GraphOperationError {
    return { ok: false, error: { code: "run_not_found", message: `run ${runId} not found` } };
  }
}
