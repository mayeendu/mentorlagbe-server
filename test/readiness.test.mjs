import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { createReadiness } from "../dist/middleware/readiness.js";

test("both health paths report MongoDB readiness without exposing errors and stop probing during shutdown", async () => {
  let probes = 0;
  let available = true;
  const readiness = createReadiness(async () => {
    probes++;
    if (!available) throw new Error("private driver error");
  });
  const app = express();
  app.get(["/health", "/api/health"], readiness.health);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    for (const path of ["/health", "/api/health"]) {
      const healthy = await fetch(base + path);
      assert.equal(healthy.status, 200);
      assert.equal(healthy.headers.get("cache-control"), "no-store");
      assert.deepEqual(await healthy.json(), { status: "ok" });
    }
    available = false;
    const down = await fetch(base + "/health");
    assert.equal(down.status, 503);
    assert.deepEqual(await down.json(), { status: "unavailable" });

    available = true;
    assert.equal(readiness.beginShutdown(), true);
    assert.equal(readiness.beginShutdown(), false);
    const draining = await fetch(base + "/health");
    assert.equal(draining.status, 503);
    assert.deepEqual(await draining.json(), { status: "unavailable" });
    assert.equal(probes, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
