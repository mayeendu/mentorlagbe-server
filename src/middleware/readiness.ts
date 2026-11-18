import type { RequestHandler } from "express";

export function createReadiness(ping: () => Promise<unknown>) {
  let draining = false;

  const health: RequestHandler = async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!draining) {
      try {
        await ping();
        if (!draining) {
          res.json({ status: "ok" });
          return;
        }
      } catch {
        // Keep internal database errors out of the readiness response.
      }
    }
    res.status(503).json({ status: "unavailable" });
  };

  return {
    health,
    beginShutdown() {
      if (draining) return false;
      draining = true;
      return true;
    },
  };
}
