import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import { createAuth } from "../dist/config/auth.js";
import { createVerifyToken } from "../dist/middleware/authorization.js";
import { adminStatsRoutes } from "../dist/routes/admin-stats.js";
import { adminUserRoutes, ensureAdminGuard } from "../dist/routes/admin-users.js";
import { paymentRoutes } from "../dist/routes/payments.js";

const uri = process.env.ADMIN_TEST_MONGODB_URI ||
  (process.env.ADMIN_TEST_USE_CONFIGURED_MONGODB === "1" ? process.env.MONGODB_URI : undefined);

describe("admin dashboard on MongoDB", { skip: !uri }, () => {
  const issuer = "http://localhost:5000";
  const mongo = new MongoClient(uri || "mongodb://127.0.0.1:27017", { serverSelectionTimeoutMS: 5000 });
  const db = mongo.db("ml_admin_" + new ObjectId().toHexString());
  const accounts = {};
  const password = "fixture-password-only";
  const existingSecret = process.env.BETTER_AUTH_SECRET;
  let api;
  let server;

  before(async () => {
    process.env.BETTER_AUTH_SECRET = "admin-integration-test-secret-0123456789";
    await mongo.connect();
    await ensureAdminGuard(db);
    const auth = createAuth(db, issuer, "http://localhost:3000");
    const app = express();
    const verify = createVerifyToken(db, issuer, () => auth.api.getJwks());
    app.all("/api/auth/*splat", toNodeHandler(auth));
    app.use("/api/admin/stats", adminStatsRoutes(db, verify));
    app.use("/api/admin/users", adminUserRoutes(db, verify));
    app.use("/api", paymentRoutes(db, verify, "http://localhost:3000", null));
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    api = "http://127.0.0.1:" + server.address().port + "/api";
    for (const [name, role] of [["owner", "admin"], ["reviewer", "admin"], ["other", "student"], ["teacher", "tutor"]]) {
      const email = name + "@example.test";
      const response = await auth.api.signUpEmail({ body: { name, email, password }, asResponse: true });
      assert.equal(response.status, 200);
      const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      const user = await db.collection("user").findOne({ email });
      await db.collection("user").updateOne({ _id: user._id }, { $set: { role, plan: role === "tutor" ? "pro" : "free" } });
      const issued = await fetch(api + "/auth/token", { headers: { cookie } });
      assert.equal(issued.status, 200);
      accounts[name] = { id: user._id, cookie, email, token: (await issued.json()).token };
    }
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { await db.dropDatabase(); }
    finally {
      await mongo.close();
      if (existingSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = existingSecret;
    }
  });

  function request(path, name, method = "GET", body) {
    return fetch(api + path, {
      method,
      headers: {
        ...(name ? { authorization: "Bearer " + accounts[name].token } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: JSON.stringify(body),
    });
  }

  const change = (actor, target, body) => request("/admin/users/" + accounts[target].id, actor, "PATCH", body);

  it("restricts admin stats, users, and payment history to current admins", async () => {
    for (const path of ["/admin/stats", "/admin/users", "/admin/payments"]) {
      assert.equal((await request(path)).status, 401);
      for (const name of ["other", "teacher"]) assert.equal((await request(path, name)).status, 403);
      const response = await request(path, "owner");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal((await change("other", "other", { role: "admin" })).status, 403);
  });

  it("aggregates persisted counts, activity, and monthly revenue by payment provider", async () => {
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const old = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 7, 1));
    await db.collection("tuitions").insertMany([
      { title: "Maths", approvalStatus: "approved", createdAt: now },
      { title: "English", approvalStatus: "pending", createdAt: now },
    ]);
    await db.collection("applications").insertMany([
      { tuition: { title: "Maths" }, status: "accepted", createdAt: now },
      { tuition: { title: "Maths" }, status: "pending", createdAt: now },
    ]);
    await db.collection("payments").insertMany([
      { provider: "stripe", testMode: false, status: "paid", amount: 1000, paidAt: now },
      { provider: "stripe", testMode: false, status: "paid", amount: 1500, paidAt: old },
      { provider: "stripe", testMode: false, status: "failed", amount: 5000 },
      { provider: "mock", testMode: true, status: "paid", amount: 1500, paidAt: now },
      { provider: "stripe", testMode: true, status: "paid", amount: 1100, paidAt: now },
      { status: "paid", amount: 1200, updatedAt: now },
    ].map((row) => ({ currency: "usd", createdAt: now, ...row })));

    const result = await (await request("/admin/stats", "owner")).json();
    assert.deepEqual(result.roles, [{ label: "admin", count: 2 }, { label: "student", count: 1 }, { label: "tutor", count: 1 }]);
    assert.deepEqual(result.plans, [{ label: "free", count: 3 }, { label: "pro", count: 1 }]);
    assert.deepEqual(result.tuition, [{ label: "approved", count: 1 }, { label: "pending", count: 1 }]);
    assert.deepEqual(result.application, [{ label: "accepted", count: 1 }, { label: "pending", count: 1 }]);
    assert.deepEqual(Object.fromEntries(result.payments.map(({ bucket, amount, count }) => [bucket, [amount, count]])), {
      live: [2500, 2], mock: [1500, 1], stripeTest: [2300, 2],
    });
    assert.equal(result.monthly.length, 6);
    assert.deepEqual(result.monthly.at(-1), { month, live: 1000, mock: 1500, stripeTest: 2300 });
    assert.ok(result.activity.some(({ kind }) => kind === "Payment"));
    assert.ok(result.activity.every((row) => !Object.hasOwn(row, "email")));
  });

  it("paginates and filters users and payments against MongoDB", async () => {
    const first = await (await request("/admin/users?role=admin&limit=1", "owner")).json();
    const second = await (await request("/admin/users?role=admin&limit=1&page=2", "owner")).json();
    assert.equal(first.total, 2);
    assert.equal(first.items.length, 1);
    assert.notEqual(first.items[0]._id, second.items[0]._id);
    assert.equal((await (await request("/admin/users?search=teacher%40example.test", "owner")).json()).total, 1);
    assert.equal((await (await request("/admin/users?search=.*", "owner")).json()).total, 0);
    assert.equal((await request("/admin/users?limit=51", "owner")).status, 400);
    const page = await (await request("/admin/payments?provider=stripe-live&status=paid&limit=1&page=2", "owner")).json();
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].testMode, false);
  });

  it("updates roles and disables sessions and API tokens with safe reactivation", async () => {
    assert.equal((await request("/admin/users/invalid", "owner", "PATCH", { role: "admin" })).status, 400);
    assert.equal((await request("/admin/users/" + new ObjectId(), "owner", "PATCH", { disabled: true })).status, 404);
    assert.equal((await change("owner", "teacher", { role: "admin", plan: "pro" })).status, 400);
    assert.equal((await change("owner", "owner", { role: "student" })).status, 409);
    assert.equal((await change("owner", "owner", { disabled: true })).status, 409);
    assert.equal((await change("owner", "teacher", { role: "admin" })).status, 200);
    assert.equal((await request("/admin/stats", "teacher")).status, 200);
    assert.equal((await change("owner", "teacher", { role: "tutor" })).status, 200);
    assert.equal((await request("/admin/stats", "teacher")).status, 403);
    assert.equal((await change("owner", "teacher", { disabled: true })).status, 200);
    const blocked = await request("/payments/mine", "teacher");
    assert.equal(blocked.status, 403);
    assert.match((await blocked.json()).error, /disabled/);
    assert.equal((await fetch(api + "/auth/token", { headers: { cookie: accounts.teacher.cookie } })).status, 401);

    async function signIn() {
      return fetch(api + "/auth/sign-in/email", {
        method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ email: accounts.teacher.email, password }),
      });
    }
    assert.equal((await signIn()).status, 403);
    assert.equal((await (await request("/admin/users?access=disabled", "owner")).json()).total, 1);
    assert.equal((await change("owner", "teacher", { disabled: false })).status, 200);
    assert.equal((await signIn()).status, 200);
  });

  it("keeps an active admin across simultaneous disable and demotion attempts", async () => {
    const responses = await Promise.all([
      change("owner", "reviewer", { disabled: true }),
      change("reviewer", "owner", { role: "student" }),
    ]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 403]);
    assert.equal(await db.collection("user").countDocuments({ role: "admin", disabled: { $ne: true } }), 1);
    const survivor = responses[0].status === 200 ? "owner" : "reviewer";
    assert.equal((await change(survivor, survivor, { disabled: true })).status, 409);
    assert.equal((await change(survivor, survivor, { role: "student" })).status, 409);
  });
});
