import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, it } from "node:test";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { MongoServerError, ObjectId } from "mongodb";
import Stripe from "stripe";
import { jwtAlgorithm } from "../dist/config/jwt.js";
import { createVerifyToken } from "../dist/middleware/authorization.js";
import { paymentDatabase } from "../dist/config/payment-mode.js";
import { mockProvider } from "../dist/payments/provider.js";
import { configurePayments, stripeProvider } from "../dist/payments/stripe.js";
import { paymentRoutes } from "../dist/routes/payments.js";

const issuer = "http://localhost:5000";
const secret = "whsec_fixture_signing_secret";
const sdk = new Stripe("sk_test_fixture");
const users = Object.fromEntries(["student", "tutor", "admin", "other"].map((name) =>
  [name, { _id: new ObjectId(), role: name === "other" ? "student" : name, plan: "free" }],
));
const tokens = {};
const sandboxRows = { user: Object.values(users).map((user) => ({ ...user })), payments: [], payment_events: [] };
const rows = { user: Object.values(users), payments: [], payment_events: [] };
const calls = [];
const sessions = new Map();
const requestKeys = new Map();
let failUpgrade = false;
let collideReservation = false;
let server;
let api;
let eventId = 0;
let lastExpired;

const stripe = {
  webhooks: sdk.webhooks,
  checkout: {
    sessions: {
      async create(params, { idempotencyKey }) {
        calls.push(params);
        if (requestKeys.has(idempotencyKey)) return requestKeys.get(idempotencyKey);
        const id = "cs_test_" + (sessions.size + 1);
        const data = {
          id, object: "checkout.session", livemode: false, mode: params.mode,
          client_reference_id: params.client_reference_id, metadata: params.metadata,
          currency: params.line_items[0].price_data.currency, amount_total: params.line_items[0].price_data.unit_amount,
          payment_intent: null, payment_status: "unpaid", status: "open", url: "https://checkout.stripe.com/c/pay/" + id,
        };
        requestKeys.set(idempotencyKey, data);
        sessions.set(id, data);
        return data;
      },
      async retrieve(id) { return sessions.get(id); },
      async expire(id) {
        const session = sessions.get(id);
        session.status = "expired";
        lastExpired = id;
        return session;
      },
    },
  },
};

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair(jwtAlgorithm);
  const jwk = await exportJWK(publicKey);
  for (const [name, user] of Object.entries(users)) {
    tokens[name] = await new SignJWT({ role: "admin", plan: "pro" }).setProtectedHeader({ alg: jwtAlgorithm })
      .setIssuer(issuer).setAudience(issuer).setSubject(user._id.toHexString()).setExpirationTime("5m").sign(privateKey);
  }
  const db = databaseDouble();
  const app = express();
  app.use("/api", paymentRoutes(db, createVerifyToken(db, issuer, async () => ({ keys: [jwk] })), "http://localhost:3000", stripeProvider(stripe, secret, true)));
  const sandbox = databaseDouble(sandboxRows);
  app.use("/mock-api", paymentRoutes(sandbox, createVerifyToken(sandbox, issuer, async () => ({ keys: [jwk] })), "http://localhost:3000", mockProvider));
  app.use(express.json());
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  api = "http://127.0.0.1:" + server.address().port + "/api";
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function request(path, name, method = "GET", body, mock = false) {
  return fetch((mock ? api.replace(/\/api$/, "/mock-api") : api) + path, { method,
    headers: {
      ...(name ? { authorization: "Bearer " + tokens[name] } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: JSON.stringify(body),
  });
}

function event(type, session, overrides = {}) {
  return { id: "evt_fixture_" + ++eventId, type, livemode: false, data: { object: { ...session, ...overrides } } };
}

function sendEvent(payload, signatureMode = "valid") {
  const raw = JSON.stringify(payload, null, 2);
  const header = sdk.webhooks.generateTestHeaderString({ payload: raw, secret });
  return fetch(api + "/payments/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: signatureMode === "valid" ? raw : raw + " ",
  });
}

async function history(name) {
  const response = await request("/payments/mine", name);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}

it("uses current roles, fixed USD prices, and reuses pending Checkout attempts", async () => {
  assert.equal((await request("/payments/checkout", null, "POST")).status, 401);
  assert.equal((await request("/payments/mine")).status, 401);
  assert.equal((await request("/admin/payments")).status, 401);
  assert.equal((await request("/admin/payments", "student")).status, 403);
  assert.equal((await request("/payments/checkout", "admin", "POST")).status, 403);
  assert.equal((await request("/payments/checkout", "student", "POST", { amount: 5, role: "tutor" })).status, 400);
  assert.equal((await request("/payments/checkout", "student", "POST")).status, 200);
  assert.equal((await request("/payments/checkout", "student", "POST")).status, 200);
  assert.equal((await request("/payments/checkout", "tutor", "POST")).status, 200);
  assert.equal(calls.length, 2);
  for (const [index, role] of ["student", "tutor"].entries()) {
    assert.equal(calls[index].mode, "payment");
    assert.equal(calls[index].line_items[0].price_data.unit_amount, role === "student" ? 1000 : 1500);
    assert.equal(calls[index].line_items[0].price_data.currency, "usd");
    assert.equal(calls[index].metadata.userId, users[role]._id.toHexString());
    assert.equal(calls[index].metadata.role, role);
  }
  const student = await history("student");
  assert.equal(student.plan, "free");
  assert.equal(student.payments.length, 1);
  assert.equal(student.payments[0].status, "pending");
  assert.equal(Object.hasOwn(student.payments[0], "userId"), false);
  assert.deepEqual((await history("other")).payments, []);
  const admin = await request("/admin/payments", "admin");
  assert.equal(admin.status, 200);
  assert.equal((await admin.json()).total, 2);
});

it("requires signed test-mode paid data and atomically fulfills repeated events once", async () => {
  const checkout = sessions.get("cs_test_1");
  const verified = { status: "complete", payment_status: "paid", payment_intent: "pi_fixture_1" };
  const success = event("checkout.session.completed", checkout, verified);

  assert.equal((await sendEvent(success, "tampered")).status, 400);
  assert.equal((await sendEvent({ ...success, livemode: true })).status, 200);
  assert.equal((await sendEvent(event("checkout.session.completed", checkout, { status: "complete" }))).status, 200);
  assert.equal((await sendEvent(event("checkout.session.completed", checkout, { ...verified, amount_total: 15 }))).status, 400);
  assert.equal((await sendEvent(event("checkout.session.completed", checkout, { ...verified, client_reference_id: users.other._id.toHexString() }))).status, 400);
  assert.equal((await history("student")).plan, "free");

  const duplicate = await Promise.all([sendEvent(success), sendEvent(success)]);
  assert.deepEqual(duplicate.map(({ status }) => status), [200, 200]);
  assert.equal((await sendEvent(event("checkout.session.async_payment_succeeded", checkout, verified))).status, 200);
  assert.equal((await sendEvent(event("checkout.session.async_payment_failed", checkout, { status: "complete" }))).status, 200);

  const paid = await history("student");
  assert.equal(paid.plan, "pro");
  assert.equal(paid.payments.length, 1);
  assert.equal(paid.payments[0].status, "paid");
  assert.equal(paid.payments[0].stripePaymentIntentId, "pi_fixture_1");
  assert.ok(paid.payments[0].paidAt);
  assert.equal(rows.payment_events.filter(({ _id }) => _id === success.id).length, 1);
  assert.equal((await request("/payments/checkout", "student", "POST")).status, 409);
});

it("keeps failed and expired attempts unpaid and limits cancellation to the owner", async () => {
  const checkout = sessions.get("cs_test_2");
  const { _id: attemptId } = (await history("tutor")).payments[0];
  assert.equal((await request("/payments/cancel", "other", "POST", { attemptId })).status, 404);
  assert.equal((await request("/payments/cancel", "tutor", "POST", { attemptId })).status, 202);
  assert.equal(lastExpired, checkout.id);
  assert.equal((await sendEvent(event("checkout.session.expired", checkout))).status, 200);
  assert.equal((await history("tutor")).payments[0].status, "canceled");

  assert.equal((await request("/payments/checkout", "tutor", "POST")).status, 200);
  const second = sessions.get("cs_test_3");
  assert.equal((await sendEvent(event("checkout.session.async_payment_failed", second, { status: "complete", payment_intent: "pi_fixture_failed" }))).status, 200);
  const result = await history("tutor");
  assert.equal(result.plan, "free");
  assert.ok(result.payments.some((row) => row.status === "failed"));
  assert.ok(result.payments.some((row) => row.status === "canceled"));
});

it("rolls back fulfillment if updating the user fails and accepts Stripe's retry", async () => {
  assert.equal((await request("/payments/checkout", "other", "POST")).status, 200);
  const success = event("checkout.session.completed", sessions.get("cs_test_4"), {
    status: "complete", payment_status: "paid", payment_intent: "pi_fixture_4",
  });
  failUpgrade = true;
  try {
    assert.equal((await sendEvent(success)).status, 500);
    const current = await history("other");
    assert.equal(current.plan, "free");
    assert.equal(current.payments[0].status, "pending");
    assert.equal(rows.payment_events.some(({ _id }) => _id === success.id), false);
  } finally {
    failUpgrade = false;
  }
  assert.equal((await sendEvent(success)).status, 200);
  assert.equal((await history("other")).plan, "pro");
});

it("paginates admin payment history and supports literal transaction search and status filters", async () => {
  const first = await request("/admin/payments?limit=1&status=paid&provider=stripe-test", "admin");
  assert.equal(first.status, 200);
  const page = await first.json();
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  const second = await (await request("/admin/payments?limit=1&page=2&status=paid&provider=stripe-test", "admin")).json();
  assert.notEqual(second.items[0]._id, page.items[0]._id);
  assert.equal((await (await request("/admin/payments?search=pi_fixture_1", "admin")).json()).total, 1);
  assert.equal((await (await request("/admin/payments?search=.*", "admin")).json()).total, 0);
  assert.equal((await request("/admin/payments?limit=51", "admin")).status, 400);
});

function mockCase(name, run) {
  it("mock: " + name, async () => {
    sandboxRows.payments = [];
    sandboxRows.payment_events = [];
    sandboxRows.user = Object.values(users).map((user) => ({ ...user, plan: "free" }));
    await run();
  });
}

function mockRequest(path, name, method = "GET", body) {
  return request(path, name, method, body, true);
}
const begin = (name, body) => mockRequest("/payments/checkout", name, "POST", body);
const complete = (name, attemptId, outcome, extra) =>
  mockRequest("/payments/mock/complete", name, "POST", { attemptId, outcome, ...extra });
const mine = async (name) => (await mockRequest("/payments/mine", name)).json();

async function startMock(name) {
  const response = await begin(name);
  assert.equal(response.status, 200);
  const checkout = await response.json();
  assert.equal(checkout.provider, "mock");
  assert.equal(checkout.testMode, true);
  const url = new URL(checkout.url);
  assert.equal(url.origin + url.pathname, "http://localhost:3000/payments/mock");
  return url.searchParams.get("attempt_id");
}

mockCase("01 requires authentication for checkout and completion", async () => {
  assert.equal((await begin()).status, 401);
  assert.equal((await complete(undefined, new ObjectId().toString(), "success")).status, 401);
});

mockCase("02 uses the student's fixed $10 USD one-time price", async () => {
  await startMock("student");
  const { payments } = await mine("student");
  assert.equal(payments[0].amount, 1000);
  assert.equal(payments[0].currency, "usd");
  assert.equal(payments[0].role, "student");
});

mockCase("03 uses the tutor's fixed $15 USD price and rejects admins", async () => {
  assert.equal((await begin("admin")).status, 403);
  await startMock("tutor");
  const { payments } = await mine("tutor");
  assert.equal(payments[0].amount, 1500);
  assert.equal(payments[0].role, "tutor");
});

mockCase("04 rejects invented prices, identities, outcomes and attempt IDs", async () => {
  assert.equal((await begin("student", { amount: 0, role: "tutor" })).status, 400);
  const id = await startMock("student");
  assert.equal((await complete("student", id, "paid")).status, 400);
  assert.equal((await complete("student", id, "success", { userId: users.other._id })).status, 400);
  assert.equal((await complete("student", "invalid", "success")).status, 400);
  assert.equal((await complete("student", new ObjectId().toString(), "success")).status, 404);
});

mockCase("05 prevents cross-account completion and rechecks the current role", async () => {
  const id = await startMock("student");
  assert.equal((await complete("tutor", id, "success")).status, 404);
  sandboxRows.user.find(({ _id }) => _id.equals(users.student._id)).role = "admin";
  assert.equal((await complete("student", id, "success")).status, 403);
  assert.equal((await mine("student")).plan, "free");
});

mockCase("06 upgrades only after validated success and blocks checkout for Pro", async () => {
  const id = await startMock("student");
  assert.equal((await mine("student")).plan, "free");
  assert.equal((await mine("student")).payments[0].status, "pending");
  assert.equal((await complete("student", id, "success")).status, 200);
  const current = await mine("student");
  assert.equal(current.plan, "pro");
  assert.equal(current.payments[0].status, "paid");
  assert.ok(current.payments[0].paidAt);
  assert.equal(current.payments[0].mockSessionId, "mock_" + id);
  assert.equal((await begin("student")).status, 409);
});

mockCase("07 records failure without upgrading and permits another attempt", async () => {
  const id = await startMock("tutor");
  assert.equal((await complete("tutor", id, "failure")).status, 200);
  const current = await mine("tutor");
  assert.equal(current.plan, "free");
  assert.equal(current.payments[0].status, "failed");
  assert.notEqual(await startMock("tutor"), id);
});

mockCase("08 records cancellation without upgrading and permits another attempt", async () => {
  const id = await startMock("student");
  assert.equal((await complete("student", id, "cancel")).status, 200);
  const current = await mine("student");
  assert.equal(current.plan, "free");
  assert.equal(current.payments[0].status, "canceled");
  assert.notEqual(await startMock("student"), id);
});

mockCase("09 deduplicates concurrent checkout requests", async () => {
  collideReservation = true;
  const ids = await Promise.all(Array.from({ length: 4 }, () => startMock("student")));
  assert.equal(new Set(ids).size, 1);
  assert.equal((await mine("student")).payments.length, 1);
});

mockCase("10 makes completion idempotent and refuses terminal-state changes", async () => {
  const id = await startMock("student");
  const responses = await Promise.all([complete("student", id, "success"), complete("student", id, "success")]);
  assert.deepEqual(responses.map(({ status }) => status), [200, 200]);
  assert.equal((await complete("student", id, "cancel")).status, 409);
  assert.equal((await mine("student")).payments.length, 1);
});

mockCase("11 isolates user history and gives admins a labeled transaction view", async () => {
  await startMock("student");
  await startMock("tutor");
  assert.equal((await mine("student")).payments.length, 1);
  assert.equal(Object.hasOwn((await mine("student")).payments[0], "userId"), false);
  assert.equal((await mockRequest("/admin/payments", "student")).status, 403);
  const { items: records } = await (await mockRequest("/admin/payments", "admin")).json();
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.provider === "mock" && record.testMode));
});

mockCase("12 blocks mock in production and separates real and mock providers and databases", async () => {
  assert.throws(() => configurePayments({ PAYMENT_MODE: "mock", NODE_ENV: "production" }), /cannot run in production/);
  assert.equal(configurePayments({ PAYMENT_MODE: "stripe", NODE_ENV: "production" }), null);
  assert.equal(configurePayments({ PAYMENT_MODE: "stripe", NODE_ENV: "production", STRIPE_SECRET_KEY: "sk_test_" + "a".repeat(32), STRIPE_WEBHOOK_SECRET: "whsec_" + "b".repeat(32) }), null);
  assert.equal(paymentDatabase({ PAYMENT_MODE: "mock" }), "mentorlagbe_mock");
  assert.equal(paymentDatabase({ PAYMENT_MODE: "stripe" }), "mentorlagbe_stripe_test");
  assert.equal(paymentDatabase({ PAYMENT_MODE: "stripe", NODE_ENV: "production" }), "mentorlagbe");
  assert.equal((await request("/payments/mock/complete", "student", "POST", { attemptId: new ObjectId(), outcome: "success" })).status, 404);
  assert.equal((await mockRequest("/payments/webhook", undefined, "POST", {})).status, 503);
});

function databaseDouble(data = rows) {
  let last = Promise.resolve();
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((branch) => matches(row, branch));
    if (value instanceof RegExp) return typeof row[key] === "string" && value.test(row[key]);
    if (value && "$exists" in Object(value)) return Object.hasOwn(row, key) === value.$exists;
    if (value && "$in" in Object(value)) return value.$in.includes(row[key] ?? null);
    if (value && "$ne" in Object(value)) return row[key] !== value.$ne;
    return String(row[key]) === String(value);
  });
  const project = (row, projection) => {
    if (!row || !projection) return row ? { ...row } : null;
    const includes = Object.values(projection).some(Boolean);
    return Object.fromEntries(Object.entries(row).filter(([key]) => key === "_id" || (includes ? projection[key] : projection[key] !== 0)));
  };
  return {
    client: { withSession: (run) => run({
      withTransaction(callback) {
        const transaction = last.then(async () => {
          const snapshot = Object.fromEntries(Object.entries(data).map(([name, items]) => [name, items.map((row) => ({ ...row }))]));
          try {
            return await callback();
          } catch (error) {
            Object.assign(data, snapshot);
            throw error;
          }
        });
        last = transaction.catch(() => {});
        return transaction;
      },
    }) },
    collection(name) {
      return {
        findOne: async (filter, options) => project(data[name].find((row) => matches(row, filter)), options?.projection),
        countDocuments: async (filter) => data[name].filter((row) => matches(row, filter)).length,
        find: (filter = {}, options) => {
          let offset = 0;
          let limit;
          const cursor = {
            sort: () => cursor,
            skip(value) { offset = value; return cursor; },
            limit(value) { limit = value; return cursor; },
            toArray: async () => data[name].filter((row) => matches(row, filter))
              .slice(offset, limit === undefined ? undefined : offset + limit).map((row) => project(row, options?.projection)),
          };
          return cursor;
        },
        insertOne: async (doc) => {
          if (name === "payments" && doc.provider === "mock" && collideReservation) {
            collideReservation = false;
            throw new MongoServerError({ code: 11000 });
          }
          if (data[name].some((row) => String(row._id) === String(doc._id))) throw new MongoServerError({ code: 11000 });
          data[name].push({ ...doc });
          return { insertedId: doc._id };
        },
        updateOne: async (filter, update) => {
          const row = data[name].find((candidate) => matches(candidate, filter));
          if (!row) return { matchedCount: 0 };
          if (name === "user" && failUpgrade) throw new Error("Test database update failure");
          Object.assign(row, update.$set);
          return { matchedCount: 1 };
        },
      };
    },
  };
}
