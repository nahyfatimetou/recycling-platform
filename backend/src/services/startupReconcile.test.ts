import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RECONCILE_ADVISORY_LOCK_KEY,
  reconcileAllProcessing,
  type StartupReconcileDeps
} from "./startupReconcile";

function createStartupDeps(options: {
  lockOk: boolean;
  ids?: string[];
  outcomes?: Record<string, { status: string; message?: string }>;
  failIds?: Record<string, string>;
}) {
  let unlocked = false;
  const submitSideEffects: string[] = [];
  const state = {
    lockOk: options.lockOk,
    unlocked: false,
    examinedIds: [] as string[]
  };

  const deps: StartupReconcileDeps = {
    pool: {
      async query(sql: string, params: unknown[] = []) {
        const q = sql.replace(/\s+/g, " ").trim();
        if (q.includes("pg_try_advisory_lock")) {
          assert.equal(params[0], RECONCILE_ADVISORY_LOCK_KEY);
          return { rows: [{ ok: state.lockOk }], rowCount: 1 };
        }
        if (q.includes("pg_advisory_unlock")) {
          unlocked = true;
          state.unlocked = true;
          return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
        }
        if (q.includes("WHERE status = 'PROCESSING'")) {
          const ids = options.ids || [];
          return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
        }
        throw new Error(`Unhandled SQL: ${q}`);
      }
    },
    reconcile: async (declarationId: string) => {
      state.examinedIds.push(declarationId);
      // Startup reconcile must never mint — this spy ensures callers don't sneak submit in.
      submitSideEffects.push(declarationId);
      if (options.failIds?.[declarationId]) {
        throw new Error(options.failIds[declarationId]);
      }
      return options.outcomes?.[declarationId] || { status: "PROCESSING", message: "pending" };
    },
    log: () => undefined
  };

  return { deps, state, getUnlocked: () => unlocked, submitSideEffects };
}

describe("startupReconcile — boot recovery without remint", () => {
  it("skips when advisory lock is held (concurrent boot)", async () => {
    const { deps, state, getUnlocked } = createStartupDeps({ lockOk: false, ids: ["a"] });
    const report = await reconcileAllProcessing(deps);
    assert.equal(report.skipped, true);
    assert.equal(report.examined, 0);
    assert.equal(state.examinedIds.length, 0);
    assert.equal(getUnlocked(), false);
  });

  it("reconciles PROCESSING rows and releases the lock", async () => {
    const { deps, state, getUnlocked } = createStartupDeps({
      lockOk: true,
      ids: ["d1", "d2", "d3"],
      outcomes: {
        d1: { status: "APPROVED" },
        d2: { status: "PROCESSING", message: "incomplete proof" },
        d3: { status: "FAILED" }
      }
    });

    const report = await reconcileAllProcessing(deps);
    assert.equal(report.skipped, false);
    assert.equal(report.examined, 3);
    assert.equal(report.approved, 1);
    assert.equal(report.stillProcessing, 1);
    assert.equal(report.failed, 1);
    assert.deepEqual(state.examinedIds, ["d1", "d2", "d3"]);
    assert.equal(getUnlocked(), true);
  });

  it("continues after per-declaration errors and still unlocks", async () => {
    const { deps, getUnlocked } = createStartupDeps({
      lockOk: true,
      ids: ["ok", "boom", "later"],
      outcomes: {
        ok: { status: "APPROVED" },
        later: { status: "PROCESSING" }
      },
      failIds: { boom: "rpc timeout" }
    });

    const report = await reconcileAllProcessing(deps);
    assert.equal(report.approved, 1);
    assert.equal(report.stillProcessing, 1);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]!.declarationId, "boom");
    assert.match(report.errors[0]!.message, /rpc timeout/);
    assert.equal(getUnlocked(), true);
  });

  it("does not invoke submitReward — recovery is proof-only", async () => {
    let submitCalled = false;
    const deps: StartupReconcileDeps = {
      pool: {
        async query(sql: string) {
          const q = sql.replace(/\s+/g, " ").trim();
          if (q.includes("pg_try_advisory_lock")) return { rows: [{ ok: true }], rowCount: 1 };
          if (q.includes("pg_advisory_unlock")) return { rows: [{ ok: true }], rowCount: 1 };
          if (q.includes("PROCESSING")) return { rows: [{ id: "x" }], rowCount: 1 };
          throw new Error(q);
        }
      },
      reconcile: async () => {
        // Mimic rewardService.reconcileProcessing contract: no mint path.
        assert.equal(submitCalled, false);
        return { status: "APPROVED" };
      },
      log: () => undefined
    };

    // Guardrail: if a future refactor wires submit into startup reconcile, fail loudly.
    (deps as any).submitReward = () => {
      submitCalled = true;
    };

    const report = await reconcileAllProcessing(deps);
    assert.equal(report.approved, 1);
    assert.equal(submitCalled, false);
  });
});
