import "dotenv/config";
import express from "express";
import { toNodeHandler } from "better-auth/node";
import { createAuth } from "./config/auth.js";
import { connectDB } from "./config/db.js";
import { ConfigurationError, readEnvironment } from "./config/environment.js";
import { createVerifyToken } from "./middleware/authorization.js";
import { apiCors, apiError, protectAuth, secureApi } from "./middleware/http-security.js";
import { applicationRoutes, ensureApplicationIndexes } from "./routes/applications.js";
import { adminStatsRoutes } from "./routes/admin-stats.js";
import { adminUserRoutes, ensureAdminGuard } from "./routes/admin-users.js";
import { adminTuitionRoutes } from "./routes/admin-tuitions.js";
import { configurePayments } from "./payments/stripe.js";
import { ensurePaymentIndexes, paymentRoutes } from "./routes/payments.js";
import { profileRoutes } from "./routes/profile.js";
import { publicTuitionRoutes } from "./routes/public-tuitions.js";
import { roleTestRoutes } from "./routes/role-tests.js";
import { ensureTuitionIndexes, tuitionRoutes } from "./routes/tuitions.js";

async function startServer() {
  const config = readEnvironment();
  const db = await connectDB(config);
  try {
    await ensureTuitionIndexes(db);
    await ensureApplicationIndexes(db);
    await ensurePaymentIndexes(db);
    await ensureAdminGuard(db);
    const auth = createAuth(db, config.authOrigin, config.clientOrigin, config.authSecret, config.production);
    const verifyToken = createVerifyToken(db, config.authOrigin, () => auth.api.getJwks());

    const app = express();
    app.disable("x-powered-by");
    app.use("/api", secureApi(config.production), ...apiCors(config.clientOrigin, config.authOrigin));
    app.all("/api/auth/*splat", ...protectAuth(config.authOrigin), toNodeHandler(auth));

    app.get("/api/health", async (_req, res) => {
      try {
        await db.command({ ping: 1 }, { timeoutMS: 2_000 });
        res.json({ status: "ok" });
      } catch {
        res.status(503).json({ status: "unavailable" });
      }
    });

    app.use("/api/tutor/tuitions", tuitionRoutes(db, verifyToken));
    app.use("/api/admin/stats", adminStatsRoutes(db, verifyToken));
    app.use("/api/admin/users", adminUserRoutes(db, verifyToken));
    app.use("/api/admin/tuitions", adminTuitionRoutes(db, verifyToken));
    app.use("/api/tuitions", publicTuitionRoutes(db));
    app.use("/api", applicationRoutes(db, verifyToken));
    app.use("/api", paymentRoutes(db, verifyToken, config.clientOrigin, configurePayments()));
    app.use("/api/users/me", profileRoutes(db, verifyToken));
    app.use("/api", roleTestRoutes(verifyToken));
    app.use("/api", (_req, res) => { res.status(404).json({ error: "API route not found." }); });
    app.use(apiError);

    const server = app.listen(config.port, "0.0.0.0", () => console.log("API listening on port " + config.port));
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.on("error", () => {
      console.error("Could not start the HTTP listener.");
      process.exitCode = 1;
      void db.client.close().catch(() => {});
    });

    const shutdown = () => {
      const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
      deadline.unref();
      server.close(() => {
        clearTimeout(deadline);
        void db.client.close().catch(() => { process.exitCode = 1; });
      });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch (error) {
    await db.client.close();
    throw error;
  }
}

void startServer().catch((error: unknown) => {
  console.error(error instanceof ConfigurationError ? error.message : "API startup failed. Check MongoDB connectivity, topology, and permissions.");
  process.exitCode = 1;
});
