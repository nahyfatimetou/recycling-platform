import type { Pool } from "pg";
import { pool as defaultPool } from "../db/pool";
import { reconcileProcessing, type RewardDeps } from "./rewardService";

/** Stable advisory lock key for startup / cron reconciliation (app-specific). */
export const RECONCILE_ADVISORY_LOCK_KEY = 746283901;

export type StartupReconcileResult = {
  skipped: boolean;
  reason?: string;
  examined: number;
  approved: number;
  failed: number;
  stillProcessing: number;
  conflicts: number;
  errors: Array<{ declarationId: string; message: string }>;
};

export type StartupReconcileDeps = {
  pool: Pick<Pool, "query">;
  reconcile: (declarationId: string, deps?: RewardDeps) => Promise<{ status: string; message?: string }>;
  rewardDeps?: RewardDeps;
  log?: (message: string, extra?: unknown) => void;
};

/**
 * Reconcile all PROCESSING declarations without submitting new blockchain txs.
 * Uses pg_try_advisory_lock so only one reconciler runs at a time (boot / multi-instance safe).
 */
export async function reconcileAllProcessing(
  deps: StartupReconcileDeps = {
    pool: defaultPool,
    reconcile: reconcileProcessing
  }
): Promise<StartupReconcileResult> {
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.log(`[reconcile] ${msg}`, extra ?? ""));
  const lock = await deps.pool.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [
    RECONCILE_ADVISORY_LOCK_KEY
  ]);
  if (!lock.rows[0]?.ok) {
    return {
      skipped: true,
      reason: "Un autre processus de réconciliation détient déjà le verrou",
      examined: 0,
      approved: 0,
      failed: 0,
      stillProcessing: 0,
      conflicts: 0,
      errors: []
    };
  }

  const result: StartupReconcileResult = {
    skipped: false,
    examined: 0,
    approved: 0,
    failed: 0,
    stillProcessing: 0,
    conflicts: 0,
    errors: []
  };

  try {
    const rows = await deps.pool.query<{ id: string }>(
      `SELECT id FROM declarations
       WHERE status = 'PROCESSING'
       ORDER BY updated_at ASC NULLS FIRST, created_at ASC`
    );
    result.examined = rows.rowCount ?? rows.rows.length;

    for (const row of rows.rows) {
      try {
        const outcome = await deps.reconcile(row.id, deps.rewardDeps);
        if (outcome.status === "APPROVED") result.approved += 1;
        else if (outcome.status === "FAILED") result.failed += 1;
        else if (outcome.status === "CONFLICT") result.conflicts += 1;
        else result.stillProcessing += 1;
      } catch (error: any) {
        result.errors.push({
          declarationId: row.id,
          message: String(error?.message || error)
        });
        log("declaration reconcile error", { id: row.id, error: error?.message });
      }
    }
    log("batch complete", result);
    return result;
  } finally {
    await deps.pool.query(`SELECT pg_advisory_unlock($1)`, [RECONCILE_ADVISORY_LOCK_KEY]);
  }
}
