import { Router } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { env } from "../config/env";
import { authenticate } from "../middleware/auth";
const router = Router();
router.post("/", authenticate, async (req, res) => {
  const parsed = z.object({ message: z.string().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Message invalide" });
  if (!env.geminiApiKey) return res.status(503).json({ message: "Assistant IA non configuré" });
  try {
    const genAI = new GoogleGenerativeAI(env.geminiApiKey);
    const model = genAI.getGenerativeModel({ model: env.geminiModel, systemInstruction: "Tu es un assistant pédagogique sur le recyclage. Ne prétends jamais valider une déclaration ni attribuer des tokens. Pour les informations de récompense, renvoie vers le backend." });
    const result = await model.generateContent(parsed.data.message);
    res.json({ answer: result.response.text() });
  } catch { res.status(502).json({ message: "Le service IA est temporairement indisponible" }); }
});
export default router;
