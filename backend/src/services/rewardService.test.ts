import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "ethers";
import { WEI_PER_ECO } from "./rewardPolicy";
import { processReward, reconcileProcessing, type RewardDeps } from "./rewardService";
import type { RewardedProof } from "./blockchainService";

type Decl = {
  id: string;
  user_id: string;
  status: string;
  material: string;
  quantity: string;
  wallet_address: string | null;
  estimated_reward_amount: string | null;
  reward_amount: string | null;
  declaration_key: string;
  tx_hash: string | null;
  last_error: string | null;
  processed_at: string | null;
};

type User = { id: string; wallet_address: string | null };
type Override = {
  declaration_id: string;
  admin_user_id: string;
  previous_amount: string | null;
  new_amount: string;
  justification: string;
};
type RewardEvent = {
  declaration_id: string;
  tx_hash: string;
  wallet_address: string;
  amount: string;
};

function createMemoryDeps(seed: {
  declaration: Decl;
  user: User;
  processed?: boolean;
  receiptStatus?: number | null;
  waitError?: Error;
  eventProof?: RewardedProof | null;
  /** If true, findRewardedProof returns null even when processed */
  hideEvent?: boolean;
}) {
  const state = {
    declaration: { ...seed.declaration },
    user: { ...seed.user },
    overrides: [] as Override[],
    events: [] as RewardEvent[],
    processed: Boolean(seed.processed),
    submitCalls: [] as bigint[],
    claimAttempts: 0
  };

  const requireValidWallet = (wallet: string) => {
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      throw Object.assign(new Error("Adresse wallet invalide"), { statusCode: 400 });
    }
    return getAddress(wallet);
  };

  const defaultProof = (): RewardedProof | null => {
    if (seed.hideEvent) return null;
    if (seed.eventProof !== undefined) return seed.eventProof;
    if (!state.processed) return null;
    const amount = state.declaration.reward_amount || "0";
    const wallet = state.declaration.wallet_address || state.user.wallet_address;
    if (!wallet) return null;
    return {
      declarationId: state.declaration.declaration_key,
      txHash: state.declaration.tx_hash || "0xabc",
      beneficiary: getAddress(wallet),
      amount: BigInt(amount)
    };
  };

  const pool = {
    async query(sql: string, params: unknown[] = []) {
      const q = sql.replace(/\s+/g, " ").trim();

      if (q.startsWith("UPDATE declarations SET status='PROCESSING'")) {
        state.claimAttempts += 1;
        const id = params[0];
        const allowed = params[1];
        if (state.declaration.id === id && state.declaration.status === allowed) {
          state.declaration.status = "PROCESSING";
          state.declaration.last_error = null;
          return { rowCount: 1, rows: [{ id }] };
        }
        return { rowCount: 0, rows: [] };
      }

      if (
        q.includes("FROM declarations d") &&
        q.includes("JOIN users u") &&
        q.includes("WHERE d.id=$1") &&
        !q.includes("status='PROCESSING'")
      ) {
        if (state.declaration.id !== params[0]) return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [
            {
              id: state.declaration.id,
              declaration_key: state.declaration.declaration_key,
              wallet_address: state.declaration.wallet_address,
              reward_amount: state.declaration.reward_amount,
              estimated_reward_amount: state.declaration.estimated_reward_amount,
              tx_hash: state.declaration.tx_hash,
              material: state.declaration.material,
              quantity: state.declaration.quantity,
              user_wallet: state.user.wallet_address
            }
          ]
        };
      }

      if (q.includes("WHERE d.id=$1 AND d.status='PROCESSING'")) {
        if (state.declaration.id !== params[0] || state.declaration.status !== "PROCESSING") {
          return { rowCount: 0, rows: [] };
        }
        return {
          rowCount: 1,
          rows: [
            {
              declaration_key: state.declaration.declaration_key,
              tx_hash: state.declaration.tx_hash,
              wallet_address: state.declaration.wallet_address,
              reward_amount: state.declaration.reward_amount,
              user_wallet: state.user.wallet_address
            }
          ]
        };
      }

      if (q.includes("SET wallet_address=$2")) {
        state.declaration.wallet_address = params[1] as string;
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET reward_amount=$2")) {
        state.declaration.reward_amount = String(params[1]);
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("INSERT INTO reward_amount_overrides")) {
        state.overrides.push({
          declaration_id: params[0] as string,
          admin_user_id: params[1] as string,
          previous_amount: (params[2] as string) ?? null,
          new_amount: params[3] as string,
          justification: params[4] as string
        });
        return { rowCount: 1, rows: [] };
      }

      if (q.startsWith("UPDATE declarations SET tx_hash=NULL")) {
        state.declaration.tx_hash = null;
        return { rowCount: 1, rows: [] };
      }

      if (q.startsWith("UPDATE declarations SET tx_hash=$2")) {
        state.declaration.tx_hash = params[1] as string;
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET last_error=$2") && !q.includes("status='FAILED'")) {
        state.declaration.last_error = params[1] as string;
        return { rowCount: 1, rows: [] };
      }

      if (q.includes("SET status='FAILED'")) {
        state.declaration.status = "FAILED";
        state.declaration.last_error = params[1] as string;
        return { rowCount: 1, rows: [] };
      }

      if (q.startsWith("SELECT tx_hash FROM declarations")) {
        return { rowCount: 1, rows: [{ tx_hash: state.declaration.tx_hash }] };
      }

      if (q.includes("status='APPROVED'") && q.includes("status='PROCESSING'")) {
        if (state.declaration.status !== "PROCESSING") return { rowCount: 0, rows: [] };
        state.declaration.status = "APPROVED";
        state.declaration.tx_hash = params[1] as string;
        state.declaration.reward_amount = String(params[2]);
        state.declaration.processed_at = new Date().toISOString();
        state.declaration.last_error = null;
        return { rowCount: 1, rows: [{ id: state.declaration.id }] };
      }

      if (q.includes("INSERT INTO reward_events")) {
        const exists = state.events.some((e) => e.declaration_id === params[0]);
        if (!exists) {
          state.events.push({
            declaration_id: params[0] as string,
            tx_hash: params[1] as string,
            wallet_address: params[2] as string,
            amount: String(params[3])
          });
        }
        return { rowCount: exists ? 0 : 1, rows: [] };
      }

      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }

      throw new Error(`Unhandled SQL in fake pool: ${q}`);
    },
    async connect() {
      return {
        query: (sql: string, params?: unknown[]) => pool.query(sql, params || []),
        release() {}
      };
    }
  };

  const deps: RewardDeps = {
    pool: pool as RewardDeps["pool"],
    chain: {
      requireValidWallet,
      isDeclarationProcessed: async () => state.processed,
      findRewardedProof: async () => defaultProof(),
      getRewardReceipt: async () =>
        seed.receiptStatus === null || seed.receiptStatus === undefined
          ? null
          : { status: seed.receiptStatus },
      submitReward: async (_key, _wallet, amount) => {
        state.submitCalls.push(amount);
        if (seed.waitError) {
          return {
            txHash: "0xabc",
            wait: async () => {
              throw seed.waitError;
            }
          };
        }
        return {
          txHash: "0xabc",
          wait: async () => {
            if (seed.receiptStatus === 1) state.processed = true;
            return seed.receiptStatus === null || seed.receiptStatus === undefined
              ? null
              : { status: seed.receiptStatus };
          }
        };
      }
    }
  };

  return { deps, state };
}

const WALLET = "0x00000000000000000000000000000000000000a1";
const ESTIMATED = (30n * WEI_PER_ECO).toString();

function baseDecl(overrides: Partial<Decl> = {}): Decl {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    user_id: "22222222-2222-2222-2222-222222222222",
    status: "PENDING",
    material: "plastic",
    quantity: "2.5",
    wallet_address: WALLET,
    estimated_reward_amount: ESTIMATED,
    reward_amount: null,
    declaration_key: "0x" + "11".repeat(32),
    tx_hash: null,
    last_error: null,
    processed_at: null,
    ...overrides
  };
}

describe("rewardService — validate / retry / reconcile / anti-double-mint", () => {
  it("success: receipt=1 + isProcessed + Rewarded → APPROVED + reward_events", async () => {
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl(),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: WALLET },
      receiptStatus: 1
    });

    const result = await processReward(baseDecl().id, false, {}, deps);
    assert.equal(result.status, "APPROVED");
    assert.equal(state.declaration.status, "APPROVED");
    assert.equal(state.declaration.tx_hash, "0xabc");
    assert.ok(state.declaration.processed_at);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0]!.amount, ESTIMATED);
    assert.equal(state.submitCalls.length, 1);
    assert.equal(state.submitCalls[0], 30n * WEI_PER_ECO);
  });

  it("failure: receipt status=0 and not processed → FAILED", async () => {
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl(),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: WALLET },
      receiptStatus: 0,
      processed: false
    });

    const result = await processReward(baseDecl().id, false, {}, deps);
    assert.equal(result.status, "FAILED");
    assert.equal(state.declaration.status, "FAILED");
    assert.equal(state.events.length, 0);
  });

  it("timeout after broadcast: leaves PROCESSING and does not mark APPROVED", async () => {
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl(),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: WALLET },
      waitError: new Error("timeout"),
      processed: false
    });

    await assert.rejects(() => processReward(baseDecl().id, false, {}, deps), /timeout/);
    assert.equal(state.declaration.status, "PROCESSING");
    assert.equal(state.declaration.tx_hash, "0xabc");
    assert.equal(state.events.length, 0);
  });

  it("retry reuses definitive amount and does not recalculate", async () => {
    const definitive = 42n * WEI_PER_ECO;
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl({
        status: "FAILED",
        reward_amount: definitive.toString(),
        estimated_reward_amount: ESTIMATED,
        material: "plastic",
        quantity: "2.5"
      }),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: WALLET },
      receiptStatus: 1
    });

    await processReward(baseDecl().id, true, {}, deps);
    assert.equal(state.submitCalls[0], definitive);
    assert.equal(state.declaration.reward_amount, definitive.toString());
  });

  it("double-mint guard: isProcessed true skips submitReward and approves with proof", async () => {
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl({
        reward_amount: ESTIMATED,
        tx_hash: "0xdead"
      }),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: WALLET },
      processed: true,
      receiptStatus: 1,
      eventProof: {
        declarationId: "0x" + "11".repeat(32),
        txHash: "0xdead",
        beneficiary: getAddress(WALLET),
        amount: 30n * WEI_PER_ECO
      }
    });

    const result = await processReward(baseDecl().id, false, {}, deps);
    assert.equal(result.status, "APPROVED");
    assert.equal(state.submitCalls.length, 0);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0]!.tx_hash, "0xdead");
  });

  it("ADMIN override without justification is rejected", async () => {
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl(),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: WALLET },
      receiptStatus: 1
    });

    await assert.rejects(
      () => processReward(baseDecl().id, false, { amountEco: "10", adminUserId: "admin" }, deps),
      /Justification/
    );
    assert.equal(state.declaration.status, "FAILED");
    assert.equal(state.submitCalls.length, 0);
    assert.equal(state.overrides.length, 0);
  });

  it("ADMIN override with justification is historized and used on-chain", async () => {
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl(),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: WALLET },
      receiptStatus: 1
    });

    const ok = await processReward(
      baseDecl().id,
      false,
      { amountEco: "10", justification: "Correction manuelle barème", adminUserId: "admin-1" },
      deps
    );
    assert.equal(ok.status, "APPROVED");
    assert.equal(state.overrides.length, 1);
    assert.equal(state.overrides[0]!.new_amount, (10n * WEI_PER_ECO).toString());
    assert.equal(state.overrides[0]!.justification, "Correction manuelle barème");
    assert.equal(state.submitCalls[0], 10n * WEI_PER_ECO);
  });

  it("reconcile: isProcessed + proof → APPROVED without second mint", async () => {
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl({
        status: "PROCESSING",
        tx_hash: "0xabc",
        reward_amount: ESTIMATED
      }),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: WALLET },
      processed: true,
      receiptStatus: 1,
      eventProof: {
        declarationId: "0x" + "11".repeat(32),
        txHash: "0xabc",
        beneficiary: getAddress(WALLET),
        amount: 30n * WEI_PER_ECO
      }
    });

    const result = await reconcileProcessing(baseDecl().id, deps);
    assert.equal(result.status, "APPROVED");
    assert.equal(state.submitCalls.length, 0);
    assert.equal(state.declaration.status, "APPROVED");
    assert.equal(state.events.length, 1);
  });

  it("validate fails before definitive amount then retry is blocked", async () => {
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl({ wallet_address: null }),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: null },
      receiptStatus: 1
    });

    await assert.rejects(() => processReward(baseDecl().id, false, {}, deps), /Wallet/);
    assert.equal(state.declaration.status, "FAILED");
    assert.equal(state.declaration.reward_amount, null);
    assert.equal(state.submitCalls.length, 0);

    // Wallet becomes available later, but definitive reward_amount was never persisted.
    state.declaration.wallet_address = WALLET;
    state.user.wallet_address = WALLET;
    await assert.rejects(() => processReward(baseDecl().id, true, {}, deps), /définitif absent/);
    assert.equal(state.submitCalls.length, 0);
    assert.equal(state.declaration.reward_amount, null);
  });

  it("isProcessed=true without usable Rewarded event stays PROCESSING", async () => {
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl({
        reward_amount: ESTIMATED,
        tx_hash: null
      }),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: WALLET },
      processed: true,
      hideEvent: true,
      receiptStatus: 1
    });

    const result = await processReward(baseDecl().id, false, {}, deps);
    assert.equal(result.status, "PROCESSING");
    assert.equal(state.declaration.status, "PROCESSING");
    assert.match(String(state.declaration.last_error), /Rewarded/);
    assert.equal(state.submitCalls.length, 0);
    assert.equal(state.events.length, 0);
  });

  it("receipt=1 but isProcessed=false keeps PROCESSING (validate path)", async () => {
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl(),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: WALLET },
      receiptStatus: 1,
      processed: false
    });
    // Force wait to NOT flip processed
    deps.chain.submitReward = async (_k, _w, amount) => {
      state.submitCalls.push(amount);
      return {
        txHash: "0xabc",
        wait: async () => ({ status: 1 })
      };
    };

    const result = await processReward(baseDecl().id, false, {}, deps);
    assert.equal(result.status, "PROCESSING");
    assert.equal(state.declaration.status, "PROCESSING");
    assert.match(String(state.declaration.last_error), /isProcessed=false/);
    assert.equal(state.events.length, 0);
  });

  it("estimated differs from definitive: validate recalculates and persists definitive", async () => {
    const staleEstimate = (999n * WEI_PER_ECO).toString();
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl({
        estimated_reward_amount: staleEstimate,
        reward_amount: null,
        material: "plastic",
        quantity: "2.5"
      }),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: WALLET },
      receiptStatus: 1
    });

    await processReward(baseDecl().id, false, {}, deps);
    assert.equal(state.declaration.estimated_reward_amount, staleEstimate);
    assert.equal(state.declaration.reward_amount, ESTIMATED);
    assert.equal(state.submitCalls[0], 30n * WEI_PER_ECO);
  });

  it("wallet absent or invalid → FAILED before mint", async () => {
    const missing = createMemoryDeps({
      declaration: baseDecl({ wallet_address: null }),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: null }
    });
    await assert.rejects(() => processReward(baseDecl().id, false, {}, missing.deps), /Wallet/);
    assert.equal(missing.state.declaration.status, "FAILED");
    assert.equal(missing.state.submitCalls.length, 0);

    const invalid = createMemoryDeps({
      declaration: baseDecl({ wallet_address: "not-an-address" }),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: null }
    });
    await assert.rejects(() => processReward(baseDecl().id, false, {}, invalid.deps), /invalide/);
    assert.equal(invalid.state.declaration.status, "FAILED");
  });

  it("concurrent claim: second validate gets 409", async () => {
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl({ status: "PROCESSING" }),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: WALLET },
      receiptStatus: 1
    });

    await assert.rejects(() => processReward(baseDecl().id, false, {}, deps), /Transition refusée/);
    assert.equal(state.claimAttempts, 1);
    assert.equal(state.submitCalls.length, 0);
  });

  it("reconcile: receipt=1 but isProcessed=false stays PROCESSING", async () => {
    const { deps, state } = createMemoryDeps({
      declaration: baseDecl({
        status: "PROCESSING",
        tx_hash: "0xabc",
        reward_amount: ESTIMATED
      }),
      user: { id: "22222222-2222-2222-2222-222222222222", wallet_address: WALLET },
      processed: false,
      receiptStatus: 1
    });

    const result = await reconcileProcessing(baseDecl().id, deps);
    assert.equal(result.status, "PROCESSING");
    assert.equal(state.declaration.status, "PROCESSING");
    assert.equal(state.submitCalls.length, 0);
  });
});
