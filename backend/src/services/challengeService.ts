import { randomUUID } from "crypto";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../db/pool";
import { declarationKey } from "./declarationKey";
import {
  DEFAULT_BONUS_ECO,
  DEFAULT_WEEKLY_TASKS,
  DAY_LABELS_FR,
  defaultBonusRewardWei,
  defaultTaskRewardWei,
  mondayOf,
  sundayFromMonday
} from "./challengeDefaults";
import { ecoAmountToWei, weiToEcoString } from "./rewardPolicy";

export type ChallengePool = Pick<Pool, "query" | "connect">;

const MOTIVATION_TASK = [
  "Bravo ! Chaque petit geste compte pour la planète.",
  "Super initiative — votre engagement écologique progresse.",
  "Excellent ! Continuez sur cette lancée verte."
];

const MOTIVATION_WEEK = "Félicitations ! Vous avez terminé les 7 tâches du défi hebdomadaire.";

function pickMotivation(): string {
  return MOTIVATION_TASK[Math.floor(Math.random() * MOTIVATION_TASK.length)]!;
}

function uiStatusLabel(status: string): string {
  switch (status) {
    case "TODO":
      return "À faire";
    case "IN_PROGRESS":
      return "En cours";
    case "SUBMITTED":
      return "En attente de validation";
    case "PROCESSING":
      return "Récompense en cours";
    case "COMPLETED":
      return "Terminée";
    case "REJECTED":
      return "Refusée";
    case "FAILED":
      return "Échec récompense";
    default:
      return status;
  }
}

export type CreateChallengeInput = {
  title: string;
  weekStart?: string;
  bonusEco?: string;
  isActive?: boolean;
  tasks?: Array<{
    dayOfWeek: number;
    title: string;
    description?: string;
    rewardEco: string;
  }>;
  adminUserId: string;
};

export async function createWeeklyChallenge(input: CreateChallengeInput, db: ChallengePool = defaultPool) {
  const weekStart = input.weekStart || mondayOf();
  const weekEnd = sundayFromMonday(weekStart);
  const bonusWei = ecoAmountToWei(input.bonusEco ?? DEFAULT_BONUS_ECO).toString();
  const tasks = input.tasks?.length
    ? input.tasks
    : DEFAULT_WEEKLY_TASKS.map((t) => ({
        dayOfWeek: t.dayOfWeek,
        title: t.title,
        description: t.description,
        rewardEco: t.rewardEco
      }));

  if (tasks.length !== 7) {
    throw Object.assign(new Error("Un défi hebdomadaire doit contenir exactement 7 tâches"), { statusCode: 400 });
  }
  const days = new Set(tasks.map((t) => t.dayOfWeek));
  if (days.size !== 7 || [...days].some((d) => d < 1 || d > 7)) {
    throw Object.assign(new Error("Les tâches doivent couvrir les jours 1 à 7 (lundi→dimanche)"), { statusCode: 400 });
  }

  const challengeId = randomUUID();
  const client = (await db.connect()) as PoolClient;
  try {
    await client.query("BEGIN");
    if (input.isActive !== false) {
      await client.query(`UPDATE weekly_challenges SET is_active=FALSE WHERE is_active=TRUE`);
    }
    await client.query(
      `INSERT INTO weekly_challenges (id, title, week_start, week_end, bonus_reward_wei, is_active, created_by)
       VALUES ($1,$2,$3::date,$4::date,$5,$6,$7)`,
      [challengeId, input.title, weekStart, weekEnd, bonusWei, input.isActive !== false, input.adminUserId]
    );
    for (const task of tasks) {
      await client.query(
        `INSERT INTO weekly_challenge_tasks (id, challenge_id, day_of_week, title, description, reward_wei)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          randomUUID(),
          challengeId,
          task.dayOfWeek,
          task.title,
          task.description || null,
          ecoAmountToWei(task.rewardEco).toString()
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error?.code === "23505") {
      throw Object.assign(new Error("Un défi existe déjà pour cette semaine (week_start)"), { statusCode: 409 });
    }
    throw error;
  } finally {
    client.release();
  }
  return getChallengeById(challengeId, db);
}

export async function updateWeeklyChallenge(
  challengeId: string,
  patch: {
    title?: string;
    bonusEco?: string;
    isActive?: boolean;
    tasks?: Array<{ dayOfWeek: number; title: string; description?: string; rewardEco: string }>;
  },
  db: ChallengePool = defaultPool
) {
  const existing = await db.query(`SELECT id FROM weekly_challenges WHERE id=$1`, [challengeId]);
  if (!existing.rowCount) throw Object.assign(new Error("Défi introuvable"), { statusCode: 404 });

  const client = (await db.connect()) as PoolClient;
  try {
    await client.query("BEGIN");
    if (patch.isActive === true) {
      await client.query(`UPDATE weekly_challenges SET is_active=FALSE WHERE is_active=TRUE AND id<>$1`, [challengeId]);
    }
    if (patch.title !== undefined || patch.bonusEco !== undefined || patch.isActive !== undefined) {
      await client.query(
        `UPDATE weekly_challenges
         SET title=COALESCE($2, title),
             bonus_reward_wei=COALESCE($3, bonus_reward_wei),
             is_active=COALESCE($4, is_active)
         WHERE id=$1`,
        [
          challengeId,
          patch.title ?? null,
          patch.bonusEco !== undefined ? ecoAmountToWei(patch.bonusEco).toString() : null,
          patch.isActive ?? null
        ]
      );
    }
    if (patch.tasks?.length) {
      if (patch.tasks.length !== 7) {
        throw Object.assign(new Error("La mise à jour des tâches exige exactement 7 entrées"), { statusCode: 400 });
      }
      for (const task of patch.tasks) {
        const updated = await client.query(
          `UPDATE weekly_challenge_tasks
           SET title=$3, description=$4, reward_wei=$5
           WHERE challenge_id=$1 AND day_of_week=$2
           RETURNING id`,
          [
            challengeId,
            task.dayOfWeek,
            task.title,
            task.description || null,
            ecoAmountToWei(task.rewardEco).toString()
          ]
        );
        if (updated.rowCount !== 1) {
          throw Object.assign(new Error(`Tâche jour ${task.dayOfWeek} introuvable`), { statusCode: 400 });
        }
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getChallengeById(challengeId, db);
}

export async function listChallenges(db: ChallengePool = defaultPool) {
  const r = await db.query(
    `SELECT c.*,
            (SELECT COUNT(*)::int FROM weekly_challenge_tasks t WHERE t.challenge_id=c.id) AS task_count,
            (SELECT COUNT(*)::int FROM user_weekly_challenges e WHERE e.challenge_id=c.id) AS enrollment_count
     FROM weekly_challenges c
     ORDER BY c.week_start DESC`
  );
  return r.rows.map((row) => ({
    ...row,
    bonus_reward_eco: weiToEcoString(BigInt(row.bonus_reward_wei || "0"))
  }));
}

export async function getChallengeById(challengeId: string, db: ChallengePool = defaultPool) {
  const c = await db.query(`SELECT * FROM weekly_challenges WHERE id=$1`, [challengeId]);
  if (!c.rowCount) throw Object.assign(new Error("Défi introuvable"), { statusCode: 404 });
  const tasks = await db.query(
    `SELECT * FROM weekly_challenge_tasks WHERE challenge_id=$1 ORDER BY day_of_week ASC`,
    [challengeId]
  );
  return {
    ...c.rows[0],
    bonus_reward_eco: weiToEcoString(BigInt(c.rows[0].bonus_reward_wei || "0")),
    tasks: tasks.rows.map((t) => ({
      ...t,
      day_label: DAY_LABELS_FR[t.day_of_week],
      reward_eco: weiToEcoString(BigInt(t.reward_wei || "0"))
    }))
  };
}

async function ensureEnrollment(userId: string, challengeId: string, db: ChallengePool) {
  const existing = await db.query(
    `SELECT * FROM user_weekly_challenges WHERE user_id=$1 AND challenge_id=$2`,
    [userId, challengeId]
  );
  if (existing.rowCount) return existing.rows[0];

  const enrollmentId = randomUUID();
  const client = (await db.connect()) as PoolClient;
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO user_weekly_challenges (id, user_id, challenge_id)
       VALUES ($1,$2,$3)`,
      [enrollmentId, userId, challengeId]
    );
    const tasks = await client.query(
      `SELECT id, reward_wei FROM weekly_challenge_tasks WHERE challenge_id=$1 ORDER BY day_of_week`,
      [challengeId]
    );
    for (const task of tasks.rows) {
      const progressId = randomUUID();
      await client.query(
        `INSERT INTO user_challenge_task_progress
           (id, enrollment_id, task_id, user_id, status, reward_key, reward_amount)
         VALUES ($1,$2,$3,$4,'TODO',$5,$6)`,
        [progressId, enrollmentId, task.id, userId, declarationKey(progressId), task.reward_wei]
      );
    }
    await client.query("COMMIT");
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error?.code === "23505") {
      const again = await db.query(
        `SELECT * FROM user_weekly_challenges WHERE user_id=$1 AND challenge_id=$2`,
        [userId, challengeId]
      );
      if (again.rowCount) return again.rows[0];
    }
    throw error;
  } finally {
    client.release();
  }
  const created = await db.query(`SELECT * FROM user_weekly_challenges WHERE id=$1`, [enrollmentId]);
  return created.rows[0];
}

async function buildEnrollmentView(enrollment: any, db: ChallengePool) {
  const challenge = await getChallengeById(enrollment.challenge_id, db);
  const progress = await db.query(
    `SELECT p.*, t.day_of_week, t.title, t.description, t.reward_wei AS task_reward_wei
     FROM user_challenge_task_progress p
     JOIN weekly_challenge_tasks t ON t.id = p.task_id
     WHERE p.enrollment_id=$1
     ORDER BY t.day_of_week ASC`,
    [enrollment.id]
  );

  const tasks = progress.rows.map((p) => ({
    progressId: p.id,
    taskId: p.task_id,
    dayOfWeek: p.day_of_week,
    dayLabel: DAY_LABELS_FR[p.day_of_week],
    title: p.title,
    description: p.description,
    status: p.status,
    statusLabel: uiStatusLabel(p.status),
    rewardEco: weiToEcoString(BigInt(p.task_reward_wei || p.reward_amount || "0")),
    pointsEarnedEco: weiToEcoString(BigInt(p.points_earned || "0")),
    completedAt: p.completed_at,
    submittedAt: p.submitted_at,
    txHash: p.tx_hash,
    lastError: p.last_error
  }));

  const completedCount = tasks.filter((t) => t.status === "COMPLETED").length;
  const earnedWei = progress.rows
    .filter((p) => p.status === "COMPLETED")
    .reduce((acc, p) => acc + BigInt(p.points_earned || "0"), 0n);
  const bonusGranted =
    enrollment.bonus_reward_status === "GRANTED" ? BigInt(enrollment.bonus_reward_amount || "0") : 0n;

  return {
    enrollmentId: enrollment.id,
    challenge,
    tasks,
    progress: {
      completedCount,
      totalTasks: 7,
      percent: Math.round((completedCount / 7) * 100),
      earnedEco: weiToEcoString(earnedWei),
      bonusStatus: enrollment.bonus_reward_status,
      bonusEco: weiToEcoString(BigInt(challenge.bonus_reward_wei || "0")),
      bonusTxHash: enrollment.bonus_tx_hash,
      bonusLastError: enrollment.bonus_last_error,
      totalRewardsEco: weiToEcoString(earnedWei + bonusGranted),
      weekCompleted: completedCount === 7,
      completedAt: enrollment.completed_at,
      badgeCode: enrollment.badge_code
    },
    messages: {
      weekComplete: completedCount === 7 ? MOTIVATION_WEEK : null
    }
  };
}

export async function getCurrentChallengeForUser(userId: string, db: ChallengePool = defaultPool) {
  const active = await db.query(
    `SELECT * FROM weekly_challenges
     WHERE is_active=TRUE
     ORDER BY week_start DESC
     LIMIT 1`
  );
  if (!active.rowCount) {
    return { challenge: null, enrollment: null, message: "Aucun défi hebdomadaire actif" };
  }
  const enrollment = await ensureEnrollment(userId, active.rows[0].id, db);
  const view = await buildEnrollmentView(enrollment, db);
  return view;
}

export async function startTask(userId: string, progressId: string, db: ChallengePool = defaultPool) {
  const r = await db.query(
    `UPDATE user_challenge_task_progress
     SET status='IN_PROGRESS', started_at=COALESCE(started_at, NOW()), updated_at=NOW()
     WHERE id=$1 AND user_id=$2 AND status='TODO'
     RETURNING *`,
    [progressId, userId]
  );
  if (r.rowCount !== 1) {
    throw Object.assign(new Error("Impossible de démarrer cette tâche (statut attendu: À faire)"), {
      statusCode: 409
    });
  }
  return { progress: r.rows[0], statusLabel: uiStatusLabel("IN_PROGRESS") };
}

/**
 * USER marks a task done → SUBMITTED only.
 * No blockchain call, no ECO mint.
 */
export async function submitTaskCompletion(userId: string, progressId: string, db: ChallengePool = defaultPool) {
  const r = await db.query(
    `UPDATE user_challenge_task_progress
     SET status='SUBMITTED',
         submitted_at=NOW(),
         started_at=COALESCE(started_at, NOW()),
         updated_at=NOW(),
         last_error=NULL
     WHERE id=$1 AND user_id=$2 AND status IN ('TODO', 'IN_PROGRESS')
     RETURNING *`,
    [progressId, userId]
  );
  if (r.rowCount !== 1) {
    throw Object.assign(
      new Error("Impossible de marquer cette tâche (déjà soumise, terminée ou refusée)"),
      { statusCode: 409 }
    );
  }
  return {
    progress: r.rows[0],
    statusLabel: uiStatusLabel("SUBMITTED"),
    motivation: pickMotivation(),
    note: "En attente de validation administrateur — aucun token ECO n'a été attribué"
  };
}

export async function listUserChallengeHistory(userId: string, db: ChallengePool = defaultPool) {
  const enrollments = await db.query(
    `SELECT e.*, c.title, c.week_start, c.week_end, c.bonus_reward_wei
     FROM user_weekly_challenges e
     JOIN weekly_challenges c ON c.id = e.challenge_id
     WHERE e.user_id=$1
     ORDER BY c.week_start DESC`,
    [userId]
  );
  const out = [];
  for (const e of enrollments.rows) {
    const completed = await db.query(
      `SELECT COUNT(*)::int AS n FROM user_challenge_task_progress
       WHERE enrollment_id=$1 AND status='COMPLETED'`,
      [e.id]
    );
    out.push({
      enrollmentId: e.id,
      title: e.title,
      weekStart: e.week_start,
      weekEnd: e.week_end,
      completedTasks: completed.rows[0].n,
      totalTasks: 7,
      bonusStatus: e.bonus_reward_status,
      badgeCode: e.badge_code,
      completedAt: e.completed_at,
      finished: completed.rows[0].n === 7
    });
  }
  return out;
}

export async function listUserBadges(userId: string, db: ChallengePool = defaultPool) {
  const r = await db.query(
    `SELECT * FROM user_badges WHERE user_id=$1 ORDER BY earned_at DESC`,
    [userId]
  );
  return r.rows;
}

export async function listAdminProgress(challengeId: string, db: ChallengePool = defaultPool) {
  await getChallengeById(challengeId, db);
  const rows = await db.query(
    `SELECT e.id AS enrollment_id, e.bonus_reward_status, e.completed_at, e.badge_code,
            u.id AS user_id, u.full_name, u.email, u.wallet_address,
            (SELECT COUNT(*)::int FROM user_challenge_task_progress p
              WHERE p.enrollment_id=e.id AND p.status='COMPLETED') AS completed_tasks
     FROM user_weekly_challenges e
     JOIN users u ON u.id = e.user_id
     WHERE e.challenge_id=$1
     ORDER BY completed_tasks DESC, u.full_name ASC`,
    [challengeId]
  );
  return rows.rows;
}

export async function listTaskSubmissions(status: string, db: ChallengePool = defaultPool) {
  const allowed = ["SUBMITTED", "PROCESSING", "FAILED", "COMPLETED", "REJECTED"];
  if (!allowed.includes(status)) {
    throw Object.assign(new Error(`Statut invalide (attendus: ${allowed.join(", ")})`), { statusCode: 400 });
  }
  const r = await db.query(
    `SELECT p.*, t.day_of_week, t.title AS task_title, c.title AS challenge_title, c.week_start,
            u.full_name, u.email, u.wallet_address AS user_wallet
     FROM user_challenge_task_progress p
     JOIN weekly_challenge_tasks t ON t.id = p.task_id
     JOIN weekly_challenges c ON c.id = t.challenge_id
     JOIN users u ON u.id = p.user_id
     WHERE p.status=$1
     ORDER BY p.updated_at ASC`,
    [status]
  );
  return r.rows.map((row) => ({
    ...row,
    day_label: DAY_LABELS_FR[row.day_of_week],
    status_label: uiStatusLabel(row.status),
    reward_eco: weiToEcoString(BigInt(row.reward_amount || "0"))
  }));
}

export async function rejectTaskSubmission(progressId: string, db: ChallengePool = defaultPool) {
  const r = await db.query(
    `UPDATE user_challenge_task_progress
     SET status='REJECTED', updated_at=NOW(), last_error='Refusé par administrateur'
     WHERE id=$1 AND status='SUBMITTED'
     RETURNING *`,
    [progressId]
  );
  if (r.rowCount !== 1) {
    throw Object.assign(new Error("Refus impossible: soumission non SUBMITTED"), { statusCode: 409 });
  }
  return r.rows[0];
}

/** After a task becomes COMPLETED, unlock weekly bonus if all 7 are done. */
export async function maybeUnlockWeeklyBonus(enrollmentId: string, db: ChallengePool = defaultPool) {
  const count = await db.query(
    `SELECT COUNT(*)::int AS n FROM user_challenge_task_progress
     WHERE enrollment_id=$1 AND status='COMPLETED'`,
    [enrollmentId]
  );
  if (count.rows[0].n !== 7) return null;

  const enrollment = await db.query(
    `SELECT e.*, c.bonus_reward_wei
     FROM user_weekly_challenges e
     JOIN weekly_challenges c ON c.id = e.challenge_id
     WHERE e.id=$1`,
    [enrollmentId]
  );
  if (!enrollment.rowCount) return null;
  const row = enrollment.rows[0];
  if (row.bonus_reward_status !== "NONE" && row.bonus_reward_status !== "PENDING") {
    return row;
  }

  const bonusKey = row.bonus_reward_key || declarationKey(enrollmentId);
  const updated = await db.query(
    `UPDATE user_weekly_challenges
     SET bonus_reward_status='PENDING',
         bonus_reward_key=COALESCE(bonus_reward_key, $2),
         bonus_reward_amount=$3,
         completed_at=COALESCE(completed_at, NOW())
     WHERE id=$1 AND bonus_reward_status IN ('NONE', 'PENDING')
     RETURNING *`,
    [enrollmentId, bonusKey, row.bonus_reward_wei]
  );
  return updated.rows[0] || row;
}

export async function awardWeeklyBadge(userId: string, challengeId: string, enrollmentId: string, db: ChallengePool) {
  await db.query(
    `INSERT INTO user_badges (id, user_id, badge_code, label, challenge_id)
     VALUES ($1,$2,'WEEKLY_CHAMPION','Champion·ne écologique de la semaine',$3)
     ON CONFLICT (user_id, badge_code, challenge_id) DO NOTHING`,
    [randomUUID(), userId, challengeId]
  );
  await db.query(
    `UPDATE user_weekly_challenges SET badge_code='WEEKLY_CHAMPION' WHERE id=$1`,
    [enrollmentId]
  );

  const finished = await db.query(
    `SELECT COUNT(*)::int AS n FROM user_weekly_challenges
     WHERE user_id=$1 AND bonus_reward_status='GRANTED'`,
    [userId]
  );
  const n = finished.rows[0].n as number;
  if (n >= 3) {
    const existing = await db.query(
      `SELECT id FROM user_badges WHERE user_id=$1 AND badge_code='STREAK_3' LIMIT 1`,
      [userId]
    );
    if (!existing.rowCount) {
      await db.query(
        `INSERT INTO user_badges (id, user_id, badge_code, label, challenge_id)
         VALUES ($1,$2,'STREAK_3','Régulier·ère éco — 3 défis complétés',$3)`,
        [randomUUID(), userId, challengeId]
      );
    }
  }
}

export { DAY_LABELS_FR, defaultBonusRewardWei, defaultTaskRewardWei, uiStatusLabel, MOTIVATION_WEEK };
