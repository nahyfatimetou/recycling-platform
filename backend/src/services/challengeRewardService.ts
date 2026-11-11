import type { Pool, PoolClient, QueryResult } from "pg";
import { pool as defaultPool } from "../db/pool";
import * as blockchain from "./blockchainService";
import { collectRewardProof, type RewardBlockchain, type RewardDeps } from "./rewardService";
import { awardWeeklyBadge, maybeUnlockWeeklyBonus } from "./challengeService";

type ChallengeRewardDeps = {
  pool: Pick<Pool, "query" | "connect">;
  chain: RewardBlockchain;
};

const defaultDeps: ChallengeRewardDeps = {
  pool: defaultPool,
  chain: {
    isDeclarationProcessed: blockchain.isDeclarationProcessed,
    submitReward: blockchain.submitReward,
    getRewardReceipt: blockchain.getRewardReceipt,
    findRewardedProof: blockchain.findRewardedProof,
    requireValidWallet: blockchain.requireValidWallet
  }
};

type ProgressRow = {
  id: string;
  enrollment_id: string;
  user_id: string;
  status: string;
  reward_key: string;
  reward_amount: string | null;
  tx_hash: string | null;
  user_wallet: string | null;
};

async function loadProgress(db: ChallengeRewardDeps["pool"], progressId: string): Promise<ProgressRow> {
  const r = (await db.query(
    `SELECT p.id, p.enrollment_id, p.user_id, p.status, p.reward_key, p.reward_amount, p.tx_hash,
            u.wallet_address AS user_wallet
     FROM user_challenge_task_progress p
     JOIN users u ON u.id = p.user_id
     WHERE p.id=$1`,
    [progressId]
  )) as QueryResult;
  if (!r.rowCount) throw Object.assign(new Error("Progression de tâche introuvable"), { statusCode: 404 });
  return r.rows[0] as ProgressRow;
}

async function markTaskCompleted(
  deps: ChallengeRewardDeps,
  params: {
    progressId: string;
    enrollmentId: string;
    userId: string;
    rewardKey: string;
    wallet: string;
    amountWei: string;
    hintTxHash: string | null;
  }
) {
  const collected = await collectRewardProof(deps as RewardDeps, {
    declarationKey: params.rewardKey,
    hintTxHash: params.hintTxHash,
    expectedWallet: params.wallet,
    expectedAmountWei: params.amountWei
  });
  if (!collected.ok) {
    await deps.pool.query(
      `UPDATE user_challenge_task_progress
       SET last_error=$2, updated_at=NOW()
       WHERE id=$1 AND status='PROCESSING'`,
      [params.progressId, collected.reason]
    );
    return { status: "PROCESSING" as const, message: collected.reason };
  }

  const client = (await deps.pool.connect()) as PoolClient;
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE user_challenge_task_progress
       SET status='COMPLETED',
           tx_hash=$2,
           reward_amount=$3,
           points_earned=$3,
           completed_at=COALESCE(completed_at, NOW()),
           last_error=NULL,
           updated_at=NOW()
       WHERE id=$1 AND status='PROCESSING'
       RETURNING id`,
      [params.progressId, collected.proof.txHash, params.amountWei]
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { status: "CONFLICT" as const, message: "Transition COMPLETED refusée (conflit)" };
    }
    await client.query(
      `INSERT INTO challenge_reward_events
         (kind, progress_id, enrollment_id, reward_key, tx_hash, wallet_address, amount)
       VALUES ('TASK',$1,$2,$3,$4,$5,$6)
       ON CONFLICT (reward_key) DO NOTHING`,
      [
        params.progressId,
        params.enrollmentId,
        params.rewardKey,
        collected.proof.txHash,
        params.wallet,
        params.amountWei
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await maybeUnlockWeeklyBonus(params.enrollmentId, deps.pool);
  return { status: "COMPLETED" as const, txHash: collected.proof.txHash };
}

/**
 * ADMIN validates a SUBMITTED task → PROCESSING → on-chain mint → COMPLETED after proof.
 * Retry uses FAILED. Never mints on USER click.
 */
export async function processTaskReward(
  progressId: string,
  retry = false,
  deps: ChallengeRewardDeps = defaultDeps
) {
  const allowed = retry ? "FAILED" : "SUBMITTED";
  const claim = await deps.pool.query(
    `UPDATE user_challenge_task_progress
     SET status='PROCESSING', last_error=NULL, updated_at=NOW()
     WHERE id=$1 AND status=$2
     RETURNING id`,
    [progressId, allowed]
  );
  if (claim.rowCount !== 1) {
    throw Object.assign(new Error(`Transition refusée : tâche non ${allowed}`), { statusCode: 409 });
  }

  const row = await loadProgress(deps.pool, progressId);
  let wallet: string;
  try {
    if (!row.user_wallet) {
      throw Object.assign(new Error("Wallet manquant: l'utilisateur doit associer MetaMask"), { statusCode: 400 });
    }
    wallet = deps.chain.requireValidWallet(row.user_wallet);
  } catch (error: any) {
    await deps.pool.query(
      `UPDATE user_challenge_task_progress
       SET status='FAILED', last_error=$2, updated_at=NOW()
       WHERE id=$1 AND status='PROCESSING'`,
      [progressId, String(error?.message || "Wallet invalide")]
    );
    throw error;
  }

  if (!row.reward_amount || BigInt(row.reward_amount) <= 0n) {
    await deps.pool.query(
      `UPDATE user_challenge_task_progress
       SET status='FAILED', last_error=$2, updated_at=NOW()
       WHERE id=$1 AND status='PROCESSING'`,
      [progressId, "Montant de récompense invalide"]
    );
    throw Object.assign(new Error("Montant de récompense invalide"), { statusCode: 409 });
  }

  const amountWei = BigInt(row.reward_amount);
  const already = await deps.chain.isDeclarationProcessed(row.reward_key);
  if (already) {
    return markTaskCompleted(deps, {
      progressId,
      enrollmentId: row.enrollment_id,
      userId: row.user_id,
      rewardKey: row.reward_key,
      wallet,
      amountWei: amountWei.toString(),
      hintTxHash: row.tx_hash
    });
  }

  try {
    const submitted = await deps.chain.submitReward(row.reward_key, wallet, amountWei);
    await deps.pool.query(
      `UPDATE user_challenge_task_progress SET tx_hash=$2, updated_at=NOW() WHERE id=$1 AND status='PROCESSING'`,
      [progressId, submitted.txHash]
    );
    try {
      await submitted.wait();
    } catch {
      // keep PROCESSING; reconcile later
    }
    return markTaskCompleted(deps, {
      progressId,
      enrollmentId: row.enrollment_id,
      userId: row.user_id,
      rewardKey: row.reward_key,
      wallet,
      amountWei: amountWei.toString(),
      hintTxHash: submitted.txHash
    });
  } catch (error: any) {
    const message = String(error?.shortMessage || error?.message || "Échec transaction défi");
    const processedAfterError = await deps.chain.isDeclarationProcessed(row.reward_key).catch(() => false);
    if (processedAfterError) {
      return markTaskCompleted(deps, {
        progressId,
        enrollmentId: row.enrollment_id,
        userId: row.user_id,
        rewardKey: row.reward_key,
        wallet,
        amountWei: amountWei.toString(),
        hintTxHash: row.tx_hash
      });
    }
    await deps.pool.query(
      `UPDATE user_challenge_task_progress
       SET status='FAILED', last_error=$2, updated_at=NOW()
       WHERE id=$1 AND status='PROCESSING'`,
      [progressId, message]
    );
    throw Object.assign(new Error(message), { statusCode: 502 });
  }
}

export async function reconcileTaskReward(progressId: string, deps: ChallengeRewardDeps = defaultDeps) {
  const row = await loadProgress(deps.pool, progressId);
  if (row.status !== "PROCESSING") {
    throw Object.assign(new Error("Réconciliation possible uniquement en PROCESSING"), { statusCode: 409 });
  }
  if (!row.user_wallet || !row.reward_amount) {
    throw Object.assign(new Error("Données de récompense incomplètes"), { statusCode: 409 });
  }
  const wallet = deps.chain.requireValidWallet(row.user_wallet);
  return markTaskCompleted(deps, {
    progressId,
    enrollmentId: row.enrollment_id,
    userId: row.user_id,
    rewardKey: row.reward_key,
    wallet,
    amountWei: row.reward_amount,
    hintTxHash: row.tx_hash
  });
}

type EnrollmentRow = {
  id: string;
  user_id: string;
  challenge_id: string;
  bonus_reward_status: string;
  bonus_reward_key: string | null;
  bonus_reward_amount: string | null;
  bonus_tx_hash: string | null;
  user_wallet: string | null;
};

async function loadEnrollment(db: ChallengeRewardDeps["pool"], enrollmentId: string): Promise<EnrollmentRow> {
  const r = (await db.query(
    `SELECT e.id, e.user_id, e.challenge_id, e.bonus_reward_status, e.bonus_reward_key,
            e.bonus_reward_amount, e.bonus_tx_hash, u.wallet_address AS user_wallet
     FROM user_weekly_challenges e
     JOIN users u ON u.id = e.user_id
     WHERE e.id=$1`,
    [enrollmentId]
  )) as QueryResult;
  if (!r.rowCount) throw Object.assign(new Error("Inscription au défi introuvable"), { statusCode: 404 });
  return r.rows[0] as EnrollmentRow;
}

async function markBonusGranted(
  deps: ChallengeRewardDeps,
  params: {
    enrollment: EnrollmentRow;
    wallet: string;
    amountWei: string;
    rewardKey: string;
    hintTxHash: string | null;
  }
) {
  const collected = await collectRewardProof(deps as RewardDeps, {
    declarationKey: params.rewardKey,
    hintTxHash: params.hintTxHash,
    expectedWallet: params.wallet,
    expectedAmountWei: params.amountWei
  });
  if (!collected.ok) {
    await deps.pool.query(
      `UPDATE user_weekly_challenges SET bonus_last_error=$2 WHERE id=$1 AND bonus_reward_status='PROCESSING'`,
      [params.enrollment.id, collected.reason]
    );
    return { status: "PROCESSING" as const, message: collected.reason };
  }

  const client = (await deps.pool.connect()) as PoolClient;
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE user_weekly_challenges
       SET bonus_reward_status='GRANTED',
           bonus_tx_hash=$2,
           bonus_reward_amount=$3,
           bonus_last_error=NULL,
           completed_at=COALESCE(completed_at, NOW())
       WHERE id=$1 AND bonus_reward_status='PROCESSING'
       RETURNING id`,
      [params.enrollment.id, collected.proof.txHash, params.amountWei]
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { status: "CONFLICT" as const, message: "Transition GRANTED refusée (conflit)" };
    }
    await client.query(
      `INSERT INTO challenge_reward_events
         (kind, enrollment_id, reward_key, tx_hash, wallet_address, amount)
       VALUES ('BONUS',$1,$2,$3,$4,$5)
       ON CONFLICT (reward_key) DO NOTHING`,
      [params.enrollment.id, params.rewardKey, collected.proof.txHash, params.wallet, params.amountWei]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await awardWeeklyBadge(params.enrollment.user_id, params.enrollment.challenge_id, params.enrollment.id, deps.pool);
  return { status: "GRANTED" as const, txHash: collected.proof.txHash };
}

export async function processBonusReward(
  enrollmentId: string,
  retry = false,
  deps: ChallengeRewardDeps = defaultDeps
) {
  const allowed = retry ? "FAILED" : "PENDING";
  const claim = await deps.pool.query(
    `UPDATE user_weekly_challenges
     SET bonus_reward_status='PROCESSING', bonus_last_error=NULL
     WHERE id=$1 AND bonus_reward_status=$2
     RETURNING id`,
    [enrollmentId, allowed]
  );
  if (claim.rowCount !== 1) {
    throw Object.assign(new Error(`Transition refusée : bonus non ${allowed}`), { statusCode: 409 });
  }

  const enrollment = await loadEnrollment(deps.pool, enrollmentId);
  if (!enrollment.bonus_reward_key || !enrollment.bonus_reward_amount) {
    await deps.pool.query(
      `UPDATE user_weekly_challenges SET bonus_reward_status='FAILED', bonus_last_error=$2 WHERE id=$1`,
      [enrollmentId, "Clé ou montant de bonus manquant"]
    );
    throw Object.assign(new Error("Clé ou montant de bonus manquant"), { statusCode: 409 });
  }

  let wallet: string;
  try {
    if (!enrollment.user_wallet) {
      throw Object.assign(new Error("Wallet manquant: l'utilisateur doit associer MetaMask"), { statusCode: 400 });
    }
    wallet = deps.chain.requireValidWallet(enrollment.user_wallet);
  } catch (error: any) {
    await deps.pool.query(
      `UPDATE user_weekly_challenges SET bonus_reward_status='FAILED', bonus_last_error=$2 WHERE id=$1`,
      [enrollmentId, String(error?.message || "Wallet invalide")]
    );
    throw error;
  }

  const amountWei = BigInt(enrollment.bonus_reward_amount);
  if (amountWei <= 0n) {
    await deps.pool.query(
      `UPDATE user_weekly_challenges SET bonus_reward_status='FAILED', bonus_last_error=$2 WHERE id=$1`,
      [enrollmentId, "Bonus nul"]
    );
    throw Object.assign(new Error("Bonus nul"), { statusCode: 409 });
  }

  const already = await deps.chain.isDeclarationProcessed(enrollment.bonus_reward_key);
  if (already) {
    return markBonusGranted(deps, {
      enrollment,
      wallet,
      amountWei: amountWei.toString(),
      rewardKey: enrollment.bonus_reward_key,
      hintTxHash: enrollment.bonus_tx_hash
    });
  }

  try {
    const submitted = await deps.chain.submitReward(enrollment.bonus_reward_key, wallet, amountWei);
    await deps.pool.query(
      `UPDATE user_weekly_challenges SET bonus_tx_hash=$2 WHERE id=$1 AND bonus_reward_status='PROCESSING'`,
      [enrollmentId, submitted.txHash]
    );
    try {
      await submitted.wait();
    } catch {
      // PROCESSING until reconcile
    }
    return markBonusGranted(deps, {
      enrollment,
      wallet,
      amountWei: amountWei.toString(),
      rewardKey: enrollment.bonus_reward_key,
      hintTxHash: submitted.txHash
    });
  } catch (error: any) {
    const message = String(error?.shortMessage || error?.message || "Échec transaction bonus");
    const processedAfterError = await deps.chain
      .isDeclarationProcessed(enrollment.bonus_reward_key)
      .catch(() => false);
    if (processedAfterError) {
      return markBonusGranted(deps, {
        enrollment,
        wallet,
        amountWei: amountWei.toString(),
        rewardKey: enrollment.bonus_reward_key,
        hintTxHash: enrollment.bonus_tx_hash
      });
    }
    await deps.pool.query(
      `UPDATE user_weekly_challenges SET bonus_reward_status='FAILED', bonus_last_error=$2 WHERE id=$1`,
      [enrollmentId, message]
    );
    throw Object.assign(new Error(message), { statusCode: 502 });
  }
}

export async function reconcileBonusReward(enrollmentId: string, deps: ChallengeRewardDeps = defaultDeps) {
  const enrollment = await loadEnrollment(deps.pool, enrollmentId);
  if (enrollment.bonus_reward_status !== "PROCESSING") {
    throw Object.assign(new Error("Réconciliation bonus uniquement en PROCESSING"), { statusCode: 409 });
  }
  if (!enrollment.bonus_reward_key || !enrollment.bonus_reward_amount || !enrollment.user_wallet) {
    throw Object.assign(new Error("Données bonus incomplètes"), { statusCode: 409 });
  }
  const wallet = deps.chain.requireValidWallet(enrollment.user_wallet);
  return markBonusGranted(deps, {
    enrollment,
    wallet,
    amountWei: enrollment.bonus_reward_amount,
    rewardKey: enrollment.bonus_reward_key,
    hintTxHash: enrollment.bonus_tx_hash
  });
}
