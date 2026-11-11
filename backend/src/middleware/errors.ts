import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ message: "Route introuvable" });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ message: "Données invalides", issues: err.issues });
  }
  const anyErr = err as { statusCode?: number; message?: string };
  if (anyErr?.statusCode && anyErr.statusCode >= 400 && anyErr.statusCode < 600) {
    return res.status(anyErr.statusCode).json({ message: anyErr.message || "Erreur" });
  }
  console.error(err);
  res.status(500).json({ message: "Erreur interne du serveur" });
}
