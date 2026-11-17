import "dotenv/config";
import express from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { createAuth } from "./config/auth.js";
import { connectDB } from "./config/db.js";
import { createVerifyToken } from "./middleware/authorization.js";
import { roleTestRoutes } from "./routes/role-tests.js";

const app = express();
const PORT = Number(process.env.PORT) || 5000;

async function startServer() {
  try {
    const clientOrigin = new URL(process.env.CLIENT_URL || process.env.CLIENT_ORIGIN || "http://localhost:3000").origin;
    const baseURL = new URL(process.env.BETTER_AUTH_URL || `http://localhost:${PORT}`).origin;
    const db = await connectDB();
    const auth = createAuth(db, baseURL, clientOrigin);

    app.use(cors({ origin: [clientOrigin, baseURL], credentials: true }));
    app.get("/api/auth/token", (_req, res, next) => {
      res.set("Cache-Control", "no-store");
      next();
    });
    app.all("/api/auth/*splat", toNodeHandler(auth));
    app.use(express.json());
    const verifyToken = createVerifyToken(db, baseURL, () => auth.api.getJwks());
    app.use("/api", roleTestRoutes(verifyToken));

    app.get("/api/health", (_req, res) => {
      res.json({
        status: "ok",
        message: "MentorLagbe API is running",
      });
    });

    app.listen(PORT, () => {
      console.log(`API listening on port ${PORT}`);
    });
  } catch {
    console.error("Server startup failed. Check MongoDB and the server environment variables.");
    process.exit(1);
  }
}

startServer();
