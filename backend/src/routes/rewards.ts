import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { readEcoBalance } from "../services/blockchainService";
const router = Router();
router.get("/balance/:wallet", authenticate, async (req, res, next) => {
  try {
    const wallet = String(req.params.wallet);
    res.json({ wallet, balanceBaseUnits: await readEcoBalance(wallet) });
  } catch (e) {
    next(e);
  }
});
export default router;
