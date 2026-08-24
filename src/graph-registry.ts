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
  type GraphOperationResult,
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

export type GraphWaitClaimResult =
  | {
      readonly claimed: true;
      /** Opaque ownership token for this wait claim. */
      readonly claimId: string;
    }
  | { readonly claimed: false };

/** Process-local registry of graph runs, keyed by run id. */
export class GraphRunRegistry {
  private readonly runs = new Map<string, GraphRunHandle>();
  /** Active wait claims, grouped by run so concurrent waiters own independent claims. */
  private readonly waitClaims = new Map<string, Set<string>>();
  private waitClaimCounter = 0;

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

  /**
   * Claim a still-running run for wait_for_workflow. The signal is checked in
   * the same synchronous section as the claim, so a pre-aborted waiter never
   * suppresses a later terminal relay. Each claim has independent ownership so
   * one aborted concurrent waiter cannot release another waiter's claim.
   */
  claimWait(runId: string, signal?: AbortSignal): GraphOperationResult<GraphWaitClaimResult> {
    const handle = this.runs.get(runId);
    if (handle === undefined) return this.runNotFound(runId);
    if (signal?.aborted || isTerminalState(handle.snapshot().state)) {
      return { ok: true, result: { claimed: false } };
    }
    this.waitClaimCounter += 1;
    const claimId = `wait-${this.waitClaimCounter}`;
    const claims = this.waitClaims.get(runId) ?? new Set<string>();
    claims.add(claimId);
    this.waitClaims.set(runId, claims);
    return { ok: true, result: { claimed: true, claimId } };
  }

  /** Release one waiter's suppression claim. Releasing an absent claim is safe. */
  releaseWaitClaim(runId: string, claimId: string): void {
    const claims = this.waitClaims.get(runId);
    if (claims === undefined) return;
    claims.delete(claimId);
    if (claims.size === 0) this.waitClaims.delete(runId);
  }

  /** Consume all active claims for one terminal relay, suppressing that relay once. */
  consumeTerminalRelaySuppression(runId: string): boolean {
    return this.waitClaims.delete(runId);
  }

  async wait(
    runId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    claimId?: string,
  ): Promise<GraphWaitOperationResult> {
    const handle = this.runs.get(runId);
    if (handle === undefined) return this.runNotFound(runId);
    const releaseClaim = () => {
      if (claimId !== undefined) this.releaseWaitClaim(runId, claimId);
    };
    if (signal?.aborted) {
      releaseClaim();
      throw new Error("Operation aborted");
    }

    let removeAbortListener: (() => void) | undefined;
    const aborted = new Promise<Awaited<ReturnType<GraphRunHandle["wait"]>>>((resolve, reject) => {
      if (signal === undefined) return;
      const onAbort = () => {
        // Release synchronously before rejecting. A terminal event queued by
        // the same abort turn must see that ownership is gone and relay.
        releaseClaim();
        if (isTerminalState(handle.snapshot().state)) {
          resolve({ run: handle.snapshot(), completed: true });
        } else {
          reject(new Error("Operation aborted"));
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    try {
      const result = await (signal === undefined
        ? handle.wait(timeoutMs)
        : Promise.race([handle.wait(timeoutMs), aborted]));
      return { ok: true, result };
    } finally {
      removeAbortListener?.();
      releaseClaim();
    }
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

function isTerminalState(state: GraphRunSnapshot["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}
