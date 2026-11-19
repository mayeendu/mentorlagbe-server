import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import { createMongoClient } from "../dist/config/db.js";
import { readEnvironment } from "../dist/config/environment.js";
import { paymentDatabase } from "../dist/config/payment-mode.js";
import { apiCors, apiError, protectAuth, secureApi } from "../dist/middleware/http-security.js";

const clientOrigin = "https://app.example.test";
const authOrigin = "https://api.example.test";
const env = {
  NODE_ENV: "production", PORT: "5000", CLIENT_URL: clientOrigin, BETTER_AUTH_URL: authOrigin,
  BETTER_AUTH_SECRET: "production-security-test-fixture-only",
  MONGODB_URI: "mongodb+srv://cluster.example.test/mentorlagbe",
  PAYMENT_MODE: "disabled",
};

test("requires explicit HTTPS origins, a strong secret and safe MongoDB settings without leaking values", () => {
  assert.equal(readEnvironment(env).production, true);
  for (const [override, expected] of [
    [{ PORT: "1e4" }, /PORT/],
    [{ CLIENT_URL: "http://app.example.test" }, /CLIENT_URL/],
    [{ BETTER_AUTH_URL: "https://localhost" }, /BETTER_AUTH_URL/],
    [{ CLIENT_URL: "https://app.example.test/path" }, /CLIENT_URL/],
    [{ BETTER_AUTH_SECRET: "too-short" }, /BETTER_AUTH_SECRET/],
    [{ MONGODB_URI: "" }, /MONGODB_URI/],
    [{ MONGODB_URI: env.MONGODB_URI + "?tls=false" }, /verified TLS/],
    [{ MONGODB_URI: env.MONGODB_URI + "?TLSAllowInvalidHostnames=true" }, /verified TLS/],
    [{ MONGODB_URI: env.MONGODB_URI + "?directConnection=true" }, /topology/],
  ]) assert.throws(() => readEnvironment({ ...env, ...override }), expected);
  const secret = "mongodb+srv://do-not-log-this@cluster.example.test/?tlsInsecure=true";
  assert.throws(() => readEnvironment({ ...env, MONGODB_URI: secret }), (error) => !error.message.includes("do-not-log-this"));
});

test("constructs a MongoDB driver client with production TLS without connecting", async () => {
  const mongo = createMongoClient(readEnvironment(env));
  assert.equal(mongo.options.tls, true);
  assert.notEqual(mongo.options.tlsInsecure, true);
  assert.notEqual(mongo.options.tlsAllowInvalidCertificates, true);
  assert.notEqual(mongo.options.tlsAllowInvalidHostnames, true);
  await mongo.close();
});

test("fails closed on mock and unconfigured Stripe in production", () => {
  assert.throws(() => readEnvironment({ ...env, PAYMENT_MODE: "mock" }), /development only/);
  assert.throws(() => readEnvironment({ ...env, PAYMENT_MODE: "stripe" }), /STRIPE_SECRET_KEY/);
  assert.throws(() => readEnvironment({
    ...env, PAYMENT_MODE: "stripe", STRIPE_SECRET_KEY: "sk_test_" + "a".repeat(30), STRIPE_WEBHOOK_SECRET: "whsec_" + "b".repeat(30),
  }), /correct mode/);
  assert.equal(paymentDatabase(env), "mentorlagbe");
  assert.equal(paymentDatabase({ NODE_ENV: "development", PAYMENT_MODE: "mock" }), "mentorlagbe_mock");
});

test("selects the existing demo database on a hosted API with payments disabled", () => {
  assert.equal(readEnvironment(env).databaseName, "mentorlagbe");
  const demoEnv = { ...env, MONGODB_DATABASE: "mentorlagbe_mock" };
  assert.equal(readEnvironment(demoEnv).databaseName, "mentorlagbe_mock");
  assert.throws(() => readEnvironment({ ...demoEnv, PAYMENT_MODE: "stripe" }), /MONGODB_DATABASE/);
  assert.throws(() => readEnvironment({ ...demoEnv, MONGODB_DATABASE: "other" }), /MONGODB_DATABASE/);
});

let server;
let api;
before(async () => {
  const auth = betterAuth({
    baseURL: authOrigin,
    trustedOrigins: [clientOrigin, authOrigin],
    secret: env.BETTER_AUTH_SECRET,
    advanced: { useSecureCookies: true },
    emailAndPassword: { enabled: true },
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  });
  const app = express();
  app.disable("x-powered-by");
  app.use("/api", secureApi(true), ...apiCors(clientOrigin, authOrigin));
  app.all("/api/auth/*splat", ...protectAuth(authOrigin), toNodeHandler(auth));
  app.get("/api/fixture", (_req, res) => res.json({ ok: true }));
  app.use(apiError);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  api = "http://127.0.0.1:" + server.address().port + "/api";
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("matches full origins, permits approved preflights, and serves security headers", async () => {
  for (const origin of ["null", clientOrigin + ".other.test", "http://app.example.test"]) {
    const response = await fetch(api + "/fixture", { headers: { origin } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const correct = await fetch(api + "/fixture", {
    method: "OPTIONS", headers: { origin: clientOrigin, "access-control-request-method": "PATCH", "access-control-request-headers": "authorization,content-type" },
  });
  assert.equal(correct.status, 204);
  assert.equal(correct.headers.get("access-control-allow-origin"), clientOrigin);
  assert.match(correct.headers.get("access-control-allow-headers"), /Authorization/i);
  assert.equal(correct.headers.get("x-powered-by"), null);
  assert.equal(correct.headers.get("x-content-type-options"), "nosniff");
  assert.match(correct.headers.get("strict-transport-security"), /max-age/);
  assert.equal((await fetch(api + "/fixture")).status, 200);
});

test("caps authentication payloads and preserves secure Better Auth cookies for valid requests", async () => {
  const endpoint = api + "/auth/sign-up/email";
  const headers = { origin: clientOrigin, "content-type": "application/json" };
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ name: "x".repeat(17000) }) })).status, 413);
  const oversized = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ name: "x".repeat(17000) })));
    controller.close();
  } });
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: oversized, duplex: "half" })).status, 413);
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "{}" })).status, 415);
  const signup = await fetch(endpoint, {
    method: "POST", headers: { ...headers, "x-forwarded-proto": "http" },
    body: JSON.stringify({ name: "Fixture User", email: "security@example.test", password: "fixture-only-password" }),
  });
  assert.equal(signup.status, 200);
  const cookies = signup.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => cookie.startsWith("__Secure-") && /; HttpOnly/i.test(cookie) && /; Secure/i.test(cookie) && !/; Domain=/i.test(cookie)));
  assert.equal(signup.headers.get("cache-control"), "no-store");
  const session = await fetch(api + "/auth/get-session", { headers: { cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; ") } });
  assert.equal((await session.json()).user.email, "security@example.test");
});
