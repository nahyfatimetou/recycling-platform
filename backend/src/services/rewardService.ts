import type { Pool, PoolClient, QueryResult } from "pg";
import { getAddress } from "ethers";
import { pool as defaultPool } from "../db/pool";
import * as blockchain from "./blockchainService";
import type { RewardedProof } from "./blockchainService";
import { computeRewardWei, parseAdminOverrideWei } from "./rewardPolicy";

export type ProcessRewardOptions = {
  /** ADMIN override in ECO (decimal string). Requires justification. */
  amountEco?: string;
  justification?: string;
  adminUserId?: string;
};

type DeclarationRow = {
  id: string;
  declaration_key: string;
  wallet_address: string | null;
  reward_amount: string | null;
  estimated_reward_amount: string | null;
  tx_hash: string | null;
  material: string;
  quantity: string;
  user_wallet: string | null;
};

export type RewardBlockchain = {
  isDeclarationProcessed: (declarationId: string) => Promise<boolean>;
  submitReward: (
    declarationId: string,
    wallet: string,
    amount: bigint
  ) => Promise<{ txHash: string; wait: () => Promise<{ status: number | null } | null> }>;
  getRewardReceipt: (txHash: string) => Promise<{ status: number | null } | null>;
  findRewardedProof: (declarationId: string) => Promise<RewardedProof | null>;
  requireValidWallet: (wallet: string) => string;
};

export type RewardDeps = {
  pool: Pick<Pool, "query" | "connect">;
  chain: RewardBlockchain;
};

const defaultDeps: RewardDeps = {
  pool: defaultPool,
  chain: {
    isDeclarationProcessed: blockchain.isDeclarationProcessed,
    submitReward: blockchain.submitReward,
    getRewardReceipt: blockchain.getRewardReceipt,
    findRewardedProof: blockchain.findRewardedProof,
    requireValidWallet: blockchain.requireValidWallet
  }
};

function resolveWallet(d: DeclarationRow, requireValidWallet: RewardBlockchain["requireValidWallet"]): string {
  const candidate = d.wallet_address || d.user_wallet;
  if (!candidate) {
    throw Object.assign(new Error("Wallet manquant: associez une adresse MetaMask au compte ou à la déclaration"), {
      statusCode: 400
    });
  }
  return requireValidWallet(candidate);
}

async function historizeOverride(
  db: RewardDeps["pool"],
  params: {
    declarationId: string;
    adminUserId: string;
    previousAmount: string | null;
    newAmount: string;
    justification: string;
  }
) {
  await db.query(
    `INSERT INTO reward_amount_overrides
      (declaration_id, admin_user_id, previous_amount, new_amount, justification)
     VALUES ($1,$2,$3,$4,$5)`,
    [params.declarationId, params.adminUserId, params.previousAmount, params.newAmount, params.justification.trim()]
  );
}

async function setProcessingError(deps: RewardDeps, declarationId: string, message: string) {
  await deps.pool.query(
    `UPDATE declarations SET last_error=$2, updated_at=NOW() WHERE id=$1 AND status='PROCESSING'`,
    [declarationId, message]
  );
}

/**
 * Shared confirmation gate for validate + reconcile.
 * Requires: isProcessed + successful receipt + Rewarded event matching declarationId/wallet/amount.
 * Never submits a transaction.
 */
export async function collectRewardProof(
  deps: RewardDeps,
  params: {
    declarationKey: string;
    hintTxHash: string | null;
    expectedWallet: string;
    expectedAmountWei: string;
  }
): Promise<{ ok: true; proof: RewardedProof } | { ok: false; reason: string }> {
  const processed = await deps.chain.isDeclarationProcessed(params.declarationKey);
  if (!processed) {
    return { ok: false, reason: "Preuve incomplète: isProcessed=false on-chain" };
  }

  const eventProof = await deps.chain.findRewardedProof(params.declarationKey);
  if (!eventProof) {
    return {
      ok: false,
      reason: "Preuve incomplète: événement Rewarded introuvable pour ce declarationId (pas de second mint)"
    };
  }

  const txHash = params.hintTxHash || eventProof.txHash;
  if (!txHash) {
    return { ok: false, reason: "Preuve incomplète: tx_hash absent" };
  }

  if (params.hintTxHash && params.hintTxHash.toLowerCase() !== eventProof.txHash.toLowerCase()) {
    return {
      ok: false,
      reason: `Preuve incohérente: tx_hash DB (${params.hintTxHash}) ≠ événement Rewarded (${eventProof.txHash})`
    };
  }

  const receipt = await deps.chain.getRewardReceipt(eventProof.txHash);
  if (!receipt || receipt.status !== 1) {
    return {
      ok: false,
      reason: "Preuve incomplète: receipt absent ou status != 1 pour la transaction Rewarded"
    };
  }

  const expectedWallet = getAddress(params.expectedWallet);
  if (eventProof.beneficiary.toLowerCase() !== expectedWallet.toLowerCase()) {
    return {
      ok: false,
      reason: `Preuve incohérente: beneficiary on-chain (${eventProof.beneficiary}) != wallet attendu (${expectedWallet})`
    };
  }

  const expectedAmount = BigInt(params.expectedAmountWei);
  if (eventProof.amount !== expectedAmount) {
    return {
      ok: false,
      reason: `Preuve incohérente: amount on-chain (${eventProof.amount.toString()}) != montant définitif (${expectedAmount.toString()})`
    };
  }

  return { ok: true, proof: eventProof };
}

/**
 * Persist APPROVED + reward_events only with full proof and status=PROCESSING.
 */
async function markApproved(
  deps: RewardDeps,
  params: {
    declarationId: string;
    declarationKey: string;
    hintTxHash: string | null;
    wallet: string;
    amountWei: string;
  }
): Promise<
  | { status: "APPROVED"; txHash: string; reconciled: true }
  | { status: "PROCESSING"; message: string }
  | { status: "CONFLICT"; message: string }
> {
  const collected = await collectRewardProof(deps, {
    declarationKey: params.declarationKey,
    hintTxHash: params.hintTxHash,
    expectedWallet: params.wallet,
    expectedAmountWei: params.amountWei
  });

  if (!collected.ok) {
    await setProcessingError(deps, params.declarationId, collected.reason);
    return { status: "PROCESSING", message: collected.reason };
  }

  const txHash = collected.proof.txHash;
  const client = (await deps.pool.connect()) as PoolClient;
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE declarations
       SET status='APPROVED',
           tx_hash=$2,
           reward_amount=$3,
           processed_at=COALESCE(processed_at, NOW()),
           last_error=NULL,
           updated_at=NOW()
       WHERE id=$1 AND status='PROCESSING'
       RETURNING id`,
      [params.declarationId, txHash, params.amountWei]
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return {
        status: "CONFLICT",
        message: "Transition APPROVED refusée: déclaration plus en PROCESSING (conflit concurrent)"
      };
    }
    await client.query(
      `INSERT INTO reward_events (declaration_id, tx_hash, wallet_address, amount)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (declaration_id) DO NOTHING`,
      [params.declarationId, txHash, params.wallet, params.amountWei]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { status: "APPROVED", txHash, reconciled: true };
}

async function loadClaimedDeclaration(db: RewardDeps["pool"], declarationId: string): Promise<DeclarationRow> {
  const result = (await db.query(
    `SELECT d.id, d.declaration_key, d.wallet_address, d.reward_amount, d.estimated_reward_amount, d.tx_hash,
            d.material, d.quantity::text AS quantity, u.wallet_address AS user_wallet
     FROM declarations d
     JOIN users u ON u.id = d.user_id
     WHERE d.id=$1`,
    [declarationId]
  )) as QueryResult;
  if (!result.rowCount) throw Object.assign(new Error("Déclaration introuvable"), { statusCode: 404 });
  return result.rows[0] as DeclarationRow;
}

/**
 * Transaction orchestration:
 * - Claim PENDING/FAILED atomically before submitting.
 * - Validate: recalculate definitive reward into reward_amount (estimated stays separate).
 * - Retry: reuse definitive reward_amount only — never recalculate; blocked if null.
 * - Persist tx_hash as soon as broadcast returns.
 * - APPROVED only with aligned proofs (isProcessed + receipt status=1 + Rewarded match).
 * - Incomplete proof → PROCESSING + last_error; never a second mint for audit repair.
 */
export async function processReward(
  declarationId: string,
  retry = false,
  options: ProcessRewardOptions = {},
  deps: RewardDeps = defaultDeps
) {
  const allowed = retry ? "FAILED" : "PENDING";
  const claim = await deps.pool.query(
    `UPDATE declarations SET status='PROCESSING', last_error=NULL, updated_at=NOW()
     WHERE id=$1 AND status=$2
     RETURNING id`,
    [declarationId, allowed]
  );
  if (claim.rowCount !== 1) {
    throw Object.assign(new Error(`Transition refusée : déclaration non ${allowed}`), { statusCode: 409 });
  }

  const d = await loadClaimedDeclaration(deps.pool, declarationId);
  let wallet: string;
  try {
    wallet = resolveWallet(d, deps.chain.requireValidWallet);
  } catch (error: any) {
    await deps.pool.query(
      `UPDATE declarations SET status='FAILED', last_error=$2, updated_at=NOW() WHERE id=$1 AND status='PROCESSING'`,
      [declarationId, String(error?.message || "Wallet invalide")]
    );
    throw error;
  }

  await deps.pool.query(`UPDATE declarations SET wallet_address=$2, updated_at=NOW() WHERE id=$1 AND status='PROCESSING'`, [
    declarationId,
    wallet
  ]);

  let definitiveWei: bigint;
  try {
    if (retry) {
      if (d.reward_amount === null || d.reward_amount === undefined || d.reward_amount === "") {
        throw Object.assign(
          new Error(
            "Montant définitif absent: retry impossible tant que la validation n'a pas enregistré reward_amount"
          ),
          { statusCode: 409 }
        );
      }
      definitiveWei = BigInt(d.reward_amount);
      if (definitiveWei <= 0n) {
        throw Object.assign(new Error("Montant définitif invalide"), { statusCode: 409 });
      }
    } else {
      const computed = computeRewardWei(d.material, d.quantity);
      definitiveWei = computed.rewardWei;

      if (options.amountEco !== undefined) {
        if (!options.justification || options.justification.trim().length < 5) {
          throw Object.assign(
            new Error("Justification obligatoire (min 5 caractères) pour un override ADMIN"),
            { statusCode: 400 }
          );
        }
        if (!options.adminUserId) {
          throw Object.assign(new Error("adminUserId requis pour historiser l'override"), { statusCode: 400 });
        }
        const previousAmount = definitiveWei.toString();
        definitiveWei = parseAdminOverrideWei(options.amountEco);
        await historizeOverride(deps.pool, {
          declarationId,
          adminUserId: options.adminUserId,
          previousAmount,
          newAmount: definitiveWei.toString(),
          justification: options.justification
        });
      }

      await deps.pool.query(
        `UPDATE declarations SET reward_amount=$2, updated_at=NOW() WHERE id=$1 AND status='PROCESSING'`,
        [declarationId, definitiveWei.toString()]
      );
    }
  } catch (error: any) {
    await deps.pool.query(
      `UPDATE declarations SET status='FAILED', last_error=$2, updated_at=NOW() WHERE id=$1 AND status='PROCESSING'`,
      [declarationId, String(error?.message || "Montant de récompense invalide")]
    );
    throw error;
  }

  const amountWeiStr = definitiveWei.toString();
  let broadcastHash: string | null = null;

  try {
    // Already rewarded on-chain: reconcile with proofs only (no second mint).
    if (await deps.chain.isDeclarationProcessed(d.declaration_key)) {
      return markApproved(deps, {
        declarationId,
        declarationKey: d.declaration_key,
        hintTxHash: d.tx_hash,
        wallet,
        amountWei: amountWeiStr
      });
    }

    await deps.pool.query(`UPDATE declarations SET tx_hash=NULL, updated_at=NOW() WHERE id=$1 AND status='PROCESSING'`, [
      declarationId
    ]);

    const submitted = await deps.chain.submitReward(d.declaration_key, wallet, definitiveWei);
    broadcastHash = submitted.txHash;
    await deps.pool.query(`UPDATE declarations SET tx_hash=$2, updated_at=NOW() WHERE id=$1 AND status='PROCESSING'`, [
      declarationId,
      submitted.txHash
    ]);

    const receipt = await submitted.wait();

    // Align with reconcile: receipt.status===1 is necessary but not sufficient alone.
    if (receipt && receipt.status === 1) {
      if (!(await deps.chain.isDeclarationProcessed(d.declaration_key))) {
        const msg =
          "Receipt status=1 mais isProcessed=false — déclaration laissée PROCESSING (pas de second mint)";
        await setProcessingError(deps, declarationId, msg);
        return { status: "PROCESSING" as const, txHash: submitted.txHash, message: msg };
      }
      return markApproved(deps, {
        declarationId,
        declarationKey: d.declaration_key,
        hintTxHash: submitted.txHash,
        wallet,
        amountWei: amountWeiStr
      });
    }

    // Uncertain / failed receipt: prefer on-chain truth before marking FAILED.
    if (await deps.chain.isDeclarationProcessed(d.declaration_key)) {
      return markApproved(deps, {
        declarationId,
        declarationKey: d.declaration_key,
        hintTxHash: submitted.txHash,
        wallet,
        amountWei: amountWeiStr
      });
    }

    if (receipt && receipt.status === 0) {
      await deps.pool.query(
        `UPDATE declarations SET status='FAILED', last_error=$2, updated_at=NOW() WHERE id=$1 AND status='PROCESSING'`,
        [declarationId, "Transaction Hedera confirmée en échec (receipt status 0)"]
      );
      return { status: "FAILED" as const, txHash: submitted.txHash };
    }

    const msg = "Résultat transaction inconnu après wait — PROCESSING (réconciliation requise)";
    await setProcessingError(deps, declarationId, msg);
    return { status: "PROCESSING" as const, txHash: submitted.txHash, message: msg };
  } catch (error: any) {
    const hasHash = await deps.pool.query("SELECT tx_hash FROM declarations WHERE id=$1", [declarationId]);
    if (!broadcastHash && !hasHash.rows[0]?.tx_hash) {
      if (await deps.chain.isDeclarationProcessed(d.declaration_key)) {
        return markApproved(deps, {
          declarationId,
          declarationKey: d.declaration_key,
          hintTxHash: null,
          wallet,
          amountWei: amountWeiStr
        });
      }
      await deps.pool.query(
        `UPDATE declarations SET status='FAILED', last_error=$2, updated_at=NOW() WHERE id=$1 AND status='PROCESSING'`,
        [declarationId, String(error?.shortMessage || error?.message || "Erreur blockchain")]
      );
    } else {
      // Broadcast happened: never FAILED on unknown outcome; keep PROCESSING for reconcile.
      await setProcessingError(
        deps,
        declarationId,
        String(error?.shortMessage || error?.message || "Timeout ou erreur après broadcast")
      );
    }
    throw error;
  }
}

export async function reconcileProcessing(declarationId: string, deps: RewardDeps = defaultDeps) {
  const result = await deps.pool.query(
    `SELECT d.declaration_key, d.tx_hash, d.wallet_address, d.reward_amount, u.wallet_address AS user_wallet
     FROM declarations d
     JOIN users u ON u.id = d.user_id
     WHERE d.id=$1 AND d.status='PROCESSING'`,
    [declarationId]
  );
  if (!result.rowCount) {
    throw Object.assign(new Error("Déclaration non PROCESSING"), { statusCode: 409 });
  }
  const row = result.rows[0];
  const wallet = deps.chain.requireValidWallet(row.wallet_address || row.user_wallet || "");
  if (row.reward_amount === null || row.reward_amount === undefined || row.reward_amount === "") {
    throw Object.assign(new Error("Montant définitif (reward_amount) manquant pour réconciliation"), {
      statusCode: 409
    });
  }

  // Same gate as validate: never approve on partial proof; never submit a new tx.
  if (await deps.chain.isDeclarationProcessed(row.declaration_key)) {
    return markApproved(deps, {
      declarationId,
      declarationKey: row.declaration_key,
      hintTxHash: row.tx_hash,
      wallet,
      amountWei: String(row.reward_amount)
    });
  }

  if (row.tx_hash) {
    const receipt = await deps.chain.getRewardReceipt(row.tx_hash);
    if (receipt && receipt.status === 1) {
      const msg =
        "Receipt status=1 mais isProcessed=false — PROCESSING conservé (réessayer reconcile, pas de second mint)";
      await setProcessingError(deps, declarationId, msg);
      return { status: "PROCESSING" as const, message: msg };
    }
    if (receipt && receipt.status === 0) {
      await deps.pool.query(
        `UPDATE declarations SET status='FAILED', last_error=$2, updated_at=NOW() WHERE id=$1 AND status='PROCESSING'`,
        [declarationId, "Transaction Hedera confirmée en échec (receipt status 0)"]
      );
      return { status: "FAILED" as const, txHash: row.tx_hash };
    }
  }

  return {
    status: "PROCESSING" as const,
    message: "Transaction en attente ou preuve on-chain encore incomplète"
  };
}
