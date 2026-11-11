import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { z } from "zod";
import { pool } from "../db/pool";
import { env } from "../config/env";
import { authenticate } from "../middleware/auth";
import { requireValidWallet } from "../services/blockchainService";

const router = Router();

const registerSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(10),
  walletAddress: z.string().optional()
});

router.post("/register", async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);
    const wallet = input.walletAddress ? requireValidWallet(input.walletAddress) : null;
    const hash = await bcrypt.hash(input.password, 12);
    const result = await pool.query(
      `INSERT INTO users(full_name,email,password_hash,wallet_address)
       VALUES($1,$2,$3,$4)
       RETURNING id,full_name,email,role,wallet_address`,
      [input.fullName, input.email.toLowerCase(), hash, wallet]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (e) {
    next(e);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const input = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const result = await pool.query(
      "SELECT id,full_name,email,password_hash,role,wallet_address FROM users WHERE email=$1",
      [input.email.toLowerCase()]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(input.password, user.password_hash))) {
      return res.status(401).json({ message: "Identifiants incorrects" });
    }
    const signOptions: SignOptions = {
      subject: user.id,
      expiresIn: env.jwtExpiresIn as SignOptions["expiresIn"]
    };
    const token = jwt.sign({ role: user.role }, env.jwtSecret, signOptions);
    res.json({
      token,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: user.role,
        walletAddress: user.wallet_address
      }
    });
  } catch (e) {
    next(e);
  }
});

/** Associate / update MetaMask wallet on the authenticated user profile. */
router.patch("/wallet", authenticate, async (req, res, next) => {
  try {
    const input = z.object({ walletAddress: z.string().min(1) }).parse(req.body);
    const wallet = requireValidWallet(input.walletAddress);
    const result = await pool.query(
      `UPDATE users SET wallet_address=$2 WHERE id=$1
       RETURNING id, full_name, email, role, wallet_address`,
      [req.user!.id, wallet]
    );
    res.json({ user: result.rows[0] });
  } catch (e) {
    next(e);
  }
});

router.get("/me", authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, email, role, wallet_address FROM users WHERE id=$1`,
      [req.user!.id]
    );
    if (!result.rowCount) return res.status(404).json({ message: "Utilisateur introuvable" });
    res.json({ user: result.rows[0] });
  } catch (e) {
    next(e);
  }
});

export default router;
