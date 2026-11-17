import { Router, type RequestHandler } from "express";
import { verifyAdmin, verifyStudent, verifyTutor } from "../middleware/authorization.js";

export function roleTestRoutes(verifyToken: RequestHandler) {
  const router = Router();

  router.get("/student/test", verifyToken, verifyStudent, (_req, res) => {
    res.json({ role: "student" });
  });
  router.get("/tutor/test", verifyToken, verifyTutor, (_req, res) => {
    res.json({ role: "tutor" });
  });
  router.get("/admin/test", verifyToken, verifyAdmin, (_req, res) => {
    res.json({ role: "admin" });
  });

  return router;
}
