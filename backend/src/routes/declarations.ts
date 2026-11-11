import { Router } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { pool } from "../db/pool";
import { authenticate, requireRole } from "../middleware/auth";
import { requireValidWallet } from "../services/blockchainService";
import { declarationKey } from "../services/declarationKey";
import { computeRewardWei, quantityInputToString, weiToEcoString } from "../services/rewardPolicy";
import { processReward, reconcileProcessing } from "../services/rewardService";

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  material: z.string().min(2).max(80),
  quantity: z.union([z.string(), z.number()]),
  description: z.string().max(2000).optional(),
  walletAddress: z.string().optional()
  // reward amount is NEVER accepted from the client
});

router.post("/", requireRole("USER"), async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    const quantityStr = quantityInputToString(input.quantity);
    const estimated = computeRewardWei(input.material, quantityStr);

    const userRow = await pool.query(`SELECT wallet_address FROM users WHERE id=$1`, [req.user!.id]);
    const profileWallet = userRow.rows[0]?.wallet_address as string | null;
    const wallet = input.walletAddress
      ? requireValidWallet(input.walletAddress)
      : profileWallet
        ? requireValidWallet(profileWallet)
        : null;

    const uuid = randomUUID();
    const key = declarationKey(uuid);
    const result = await pool.query(
      `INSERT INTO declarations(
         id, user_id, material, quantity, description, wallet_address, declaration_key,
         estimated_reward_amount, reward_amount
       ) VALUES ($1,$2,$3,$4::numeric,$5,$6,$7,$8,NULL)
       RETURNING *`,
      [
        uuid,
        req.user!.id,
        input.material,
        quantityStr,
        input.description || null,
        wallet,
        key,
        estimated.rewardWei.toString()
      ]
    );
    const row = result.rows[0];
    res.status(201).json({
      ...row,
      estimated_reward_eco: weiToEcoString(estimated.rewardWei),
      material_key: estimated.materialKey,
      rate_eco_per_kg: estimated.rateEcoPerKg,
      note: "estimated_reward_amount est informatif; reward_amount définitif est calculé uniquement à la validation ADMIN"
    });
  } catch (e) {
    next(e);
  }
});

router.get("/mine", requireRole("USER"), async (req, res, next) => {
  try {
    const r = await pool.query("SELECT * FROM declarations WHERE user_id=$1 ORDER BY created_at DESC", [
      req.user!.id
    ]);
    res.json(r.rows);
  } catch (e) {
    next(e);
  }
});

router.get("/admin/list", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const status = String(req.query.status || "PENDING");
    const r = await pool.query(
      `SELECT d.*, u.full_name, u.email, u.wallet_address AS user_wallet_address
       FROM declarations d
       JOIN users u ON u.id = d.user_id
       WHERE d.status=$1
       ORDER BY d.created_at`,
      [status]
    );
    res.json(r.rows);
  } catch (e) {
    next(e);
  }
});

router.post("/admin/:id/reject", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const r = await pool.query(
      `UPDATE declarations SET status='REJECTED', updated_at=NOW()
       WHERE id=$1 AND status='PENDING' RETURNING *`,
      [String(req.params.id)]
    );
    if (!r.rowCount) {
      return res.status(409).json({ message: "Seules les déclarations PENDING peuvent être refusées" });
    }
    res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});

const validateSchema = z.object({
  amountEco: z.string().optional(),
  justification: z.string().min(5).max(2000).optional()
});

router.post("/admin/:id/validate", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const declarationId = String(req.params.id);
    const body = validateSchema.parse(req.body ?? {});
    if (body.amountEco !== undefined && !body.justification) {
      return res.status(400).json({ message: "Justification obligatoire pour un override de montant" });
    }
    res.json(
      await processReward(declarationId, false, {
        amountEco: body.amountEco,
        justification: body.justification,
        adminUserId: req.user!.id
      })
    );
  } catch (e: any) {
    res.status(e.statusCode || 502).json({ message: e.message });
  }
});

router.post("/admin/:id/retry", requireRole("ADMIN"), async (req, res, next) => {
  try {
    res.json(await processReward(String(req.params.id), true));
  } catch (e: any) {
    res.status(e.statusCode || 502).json({ message: e.message });
  }
});

router.post("/admin/:id/reconcile", requireRole("ADMIN"), async (req, res, next) => {
  try {
    res.json(await reconcileProcessing(String(req.params.id)));
  } catch (e: any) {
    res.status(e.statusCode || 502).json({ message: e.message });
  }
});

export default router;
