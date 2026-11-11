import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../middleware/auth";
import {
  createWeeklyChallenge,
  getChallengeById,
  getCurrentChallengeForUser,
  listAdminProgress,
  listChallenges,
  listTaskSubmissions,
  listUserBadges,
  listUserChallengeHistory,
  rejectTaskSubmission,
  startTask,
  submitTaskCompletion,
  updateWeeklyChallenge
} from "../services/challengeService";
import {
  processBonusReward,
  processTaskReward,
  reconcileBonusReward,
  reconcileTaskReward
} from "../services/challengeRewardService";

const router = Router();
router.use(authenticate);

const taskInputSchema = z.object({
  dayOfWeek: z.number().int().min(1).max(7),
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  rewardEco: z.string().min(1).max(40)
});

const createSchema = z.object({
  title: z.string().min(3).max(200),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  bonusEco: z.string().min(1).max(40).optional(),
  isActive: z.boolean().optional(),
  tasks: z.array(taskInputSchema).length(7).optional()
});

const updateSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  bonusEco: z.string().min(1).max(40).optional(),
  isActive: z.boolean().optional(),
  tasks: z.array(taskInputSchema).length(7).optional()
});

/** USER — défi actif + progression (auto-inscription). */
router.get("/current", requireRole("USER"), async (req, res, next) => {
  try {
    res.json(await getCurrentChallengeForUser(req.user!.id));
  } catch (e) {
    next(e);
  }
});

router.get("/mine/history", requireRole("USER"), async (req, res, next) => {
  try {
    res.json(await listUserChallengeHistory(req.user!.id));
  } catch (e) {
    next(e);
  }
});

router.get("/mine/badges", requireRole("USER"), async (req, res, next) => {
  try {
    res.json(await listUserBadges(req.user!.id));
  } catch (e) {
    next(e);
  }
});

router.post("/tasks/:progressId/start", requireRole("USER"), async (req, res, next) => {
  try {
    res.json(await startTask(req.user!.id, String(req.params.progressId)));
  } catch (e) {
    next(e);
  }
});

/** Marquer terminée → SUBMITTED uniquement (pas de mint). */
router.post("/tasks/:progressId/complete", requireRole("USER"), async (req, res, next) => {
  try {
    res.json(await submitTaskCompletion(req.user!.id, String(req.params.progressId)));
  } catch (e) {
    next(e);
  }
});

/** ADMIN — CRUD défis */
router.post("/admin", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    const challenge = await createWeeklyChallenge({ ...input, adminUserId: req.user!.id });
    res.status(201).json(challenge);
  } catch (e) {
    next(e);
  }
});

router.get("/admin/list", requireRole("ADMIN"), async (_req, res, next) => {
  try {
    res.json(await listChallenges());
  } catch (e) {
    next(e);
  }
});

router.get("/admin/submissions/list", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const status = String(req.query.status || "SUBMITTED");
    res.json(await listTaskSubmissions(status));
  } catch (e) {
    next(e);
  }
});

router.get("/admin/:id/progress", requireRole("ADMIN"), async (req, res, next) => {
  try {
    res.json(await listAdminProgress(String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

router.get("/admin/:id", requireRole("ADMIN"), async (req, res, next) => {
  try {
    res.json(await getChallengeById(String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

router.patch("/admin/:id", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const patch = updateSchema.parse(req.body);
    res.json(await updateWeeklyChallenge(String(req.params.id), patch));
  } catch (e) {
    next(e);
  }
});

router.post("/admin/tasks/:progressId/validate", requireRole("ADMIN"), async (req, res, next) => {
  try {
    res.json(await processTaskReward(String(req.params.progressId), false));
  } catch (e) {
    next(e);
  }
});

router.post("/admin/tasks/:progressId/reject", requireRole("ADMIN"), async (req, res, next) => {
  try {
    res.json(await rejectTaskSubmission(String(req.params.progressId)));
  } catch (e) {
    next(e);
  }
});

router.post("/admin/tasks/:progressId/retry", requireRole("ADMIN"), async (req, res, next) => {
  try {
    res.json(await processTaskReward(String(req.params.progressId), true));
  } catch (e) {
    next(e);
  }
});

router.post("/admin/tasks/:progressId/reconcile", requireRole("ADMIN"), async (req, res, next) => {
  try {
    res.json(await reconcileTaskReward(String(req.params.progressId)));
  } catch (e) {
    next(e);
  }
});

router.post("/admin/enrollments/:id/validate-bonus", requireRole("ADMIN"), async (req, res, next) => {
  try {
    res.json(await processBonusReward(String(req.params.id), false));
  } catch (e) {
    next(e);
  }
});

router.post("/admin/enrollments/:id/retry-bonus", requireRole("ADMIN"), async (req, res, next) => {
  try {
    res.json(await processBonusReward(String(req.params.id), true));
  } catch (e) {
    next(e);
  }
});

router.post("/admin/enrollments/:id/reconcile-bonus", requireRole("ADMIN"), async (req, res, next) => {
  try {
    res.json(await reconcileBonusReward(String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

export default router;
