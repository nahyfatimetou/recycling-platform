import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ message: "Authentification requise" });
  try {
    const payload = jwt.verify(header.slice(7), env.jwtSecret) as { sub: string; role: "USER" | "ADMIN" };
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch { return res.status(401).json({ message: "Token invalide ou expiré" }); }
}

export function requireRole(role: "USER" | "ADMIN") {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || req.user.role !== role) return res.status(403).json({ message: "Accès interdit" });
    next();
  };
}
