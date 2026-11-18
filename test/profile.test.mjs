import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, it, mock } from "node:test";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { MongoClient, ObjectId } from "mongodb";
import { createAuth } from "../dist/config/auth.js";
import { jwtAlgorithm } from "../dist/config/jwt.js";
import { createVerifyToken } from "../dist/middleware/authorization.js";
import { profileRoutes } from "../dist/routes/profile.js";

const issuer = "http://localhost:5000";
const accounts = Object.fromEntries(["student", "tutor", "admin"].map((role) => [role, {
  _id: new ObjectId(), role, name: "Fixture " + role, email: role + "@example.test", emailVerified: false,
  plan: role === "tutor" ? "pro" : "free", createdAt: new Date(), updatedAt: new Date(),
  privateMarker: "never returned",
}]));
const tokens = {};
const hostedImage = "https://i.ibb.co/fixture/avatar.png";
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
let server;
let base;

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair(jwtAlgorithm);
  for (const [role, doc] of Object.entries(accounts)) {
    tokens[role] = await new SignJWT({ role: "admin" }).setProtectedHeader({ alg: jwtAlgorithm })
      .setIssuer(issuer).setAudience(issuer).setSubject(doc._id.toHexString()).setExpirationTime("5m").sign(privateKey);
  }
  const db = {
    collection(name) {
      assert.equal(name, "user");
      const find = ({ _id }) => Object.values(accounts).find((user) => user._id.equals(_id));
      const project = (doc, fields) => doc && Object.fromEntries(Object.entries(doc).filter(([key]) => key === "_id" || fields?.[key]));
      return {
        findOne: async (filter, options) => project(find(filter), options?.projection) ?? null,
        findOneAndUpdate: async (filter, change, options) => {
          const current = find(filter);
          if (!current) return null;
          Object.assign(current, change.$set, { updatedAt: new Date() });
          return project(current, options?.projection);
        },
      };
    },
  };
  const jwk = await exportJWK(publicKey);
  const app = express();
  app.use("/api/users/me", profileRoutes(db, createVerifyToken(db, issuer, async () => ({ keys: [jwk] }))));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = "http://127.0.0.1:" + server.address().port + "/api/users/me";
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function request(role, method = "GET", body, path = "", type = "application/json") {
  return fetch(base + path, { method, headers: {
    ...(role ? { authorization: "Bearer " + tokens[role] } : {}),
    ...(body === undefined ? {} : { "content-type": type }),
  }, body: type === "application/json" ? JSON.stringify(body) : body });
}

it("requires a verified JWT and returns each role's own profile", async () => {
  assert.equal((await request()).status, 401);
  assert.equal((await request(undefined, "PATCH", { name: "New name" })).status, 401);
  assert.equal((await request(undefined, "POST", png, "/avatar", "image/png")).status, 401);
  for (const [role, account] of Object.entries(accounts)) {
    const response = await request(role);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const profile = await response.json();
    assert.equal(profile.id, account._id.toString());
    assert.equal(profile.role, role);
    assert.equal(profile.plan, account.plan);
    assert.equal(profile.email, account.email);
    assert.equal(Object.hasOwn(profile, "privateMarker"), false);
  }
});

it("validates edits and rejects identity selectors and protected fields without a partial write", async () => {
  const initial = await (await request("student")).json();
  for (const patch of [
    {}, { name: " " }, { phone: "123abc" }, { bio: "a".repeat(501) }, { location: "a".repeat(121) },
    { image: "https://elsewhere.example/avatar.png" }, { image: "https://i.ibb.co@elsewhere.example/a" },
    { email: "other@example.test" }, { role: "admin" }, { plan: "pro" },
    { id: accounts.admin._id }, { _id: accounts.admin._id }, { updatedAt: new Date() },
    { name: "Valid name", emailVerified: true },
  ]) {
    assert.equal((await request("student", "PATCH", patch)).status, 400);
  }
  assert.deepEqual(await (await request("student")).json(), initial);
});

it("writes the canonical Better Auth name/image fields and updates only the current user", async () => {
  const other = await (await request("admin")).json();
  const response = await request("tutor", "PATCH", {
    name: "  Updated Tutor  ", phone: "+880 1700-000000", bio: "  Test bio  ", location: " Dhaka ", image: hostedImage,
  });
  assert.equal(response.status, 200);
  const profile = await response.json();
  assert.equal(profile.name, "Updated Tutor");
  assert.equal(profile.phone, "+880 1700-000000");
  assert.equal(profile.bio, "Test bio");
  assert.equal(profile.location, "Dhaka");
  assert.equal(accounts.tutor.name, "Updated Tutor");
  assert.equal(accounts.tutor.image, hostedImage);
  assert.equal(profile.plan, "pro");
  assert.equal(profile.email, accounts.tutor.email);
  assert.deepEqual(await (await request("admin")).json(), other);
  assert.equal((await (await request("tutor", "PATCH", { image: null, phone: "" })).json()).image, null);
  assert.equal((await (await request("tutor")).json()).phone, "");
});

it("validates image bytes and size, and returns only the hosted URL from ImgBB", async () => {
  const key = process.env.IMGBB_API_KEY;
  process.env.IMGBB_API_KEY = "profile-test-imgbb-fixture";
  const originalFetch = globalThis.fetch;
  let uploads = 0;
  const intercept = mock.method(globalThis, "fetch", async (input, options) => {
    if (!(input instanceof URL) || input.hostname !== "api.imgbb.com") return originalFetch(input, options);
    uploads += 1;
    assert.equal(input.searchParams.get("key"), "profile-test-imgbb-fixture");
    assert.equal(options.method, "POST");
    assert.equal(options.body.get("image").type, "image/png");
    return Response.json({ success: true, data: { url: hostedImage, delete_url: "not exposed" } });
  });
  try {
    assert.equal((await request("student", "POST", Buffer.from("not PNG"), "/avatar", "image/png")).status, 415);
    assert.equal((await request("student", "POST", png, "/avatar", "image/svg+xml")).status, 415);
    assert.equal((await request("student", "POST", Buffer.alloc(5 * 1024 * 1024 + 1), "/avatar", "image/png")).status, 413);
    assert.equal(uploads, 0);
    const response = await request("student", "POST", png, "/avatar", "image/png");
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { imageUrl: hostedImage });
    assert.equal(uploads, 1);
    assert.equal((await (await request("student")).json()).image, null);
  } finally {
    intercept.mock.restore();
    if (key === undefined) delete process.env.IMGBB_API_KEY;
    else process.env.IMGBB_API_KEY = key;
  }
});

it("exposes profile changes through an existing Better Auth session on MongoDB", {
  skip: !process.env.PROFILE_TEST_MONGODB_URI && process.env.PROFILE_TEST_USE_CONFIGURED_MONGODB !== "1",
}, async () => {
  const mongo = new MongoClient(process.env.PROFILE_TEST_MONGODB_URI || process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const db = mongo.db("ml_profile_" + new ObjectId().toHexString());
  const authSecret = process.env.BETTER_AUTH_SECRET;
  let localServer;
  try {
    process.env.BETTER_AUTH_SECRET = "profile-integration-test-secret-only-0123456789";
    await mongo.connect();
    const auth = createAuth(db, issuer, "http://localhost:3000");
    const app = express();
    app.all("/api/auth/*splat", toNodeHandler(auth));
    app.use("/api/users/me", profileRoutes(db, createVerifyToken(db, issuer, () => auth.api.getJwks())));
    localServer = app.listen(0, "127.0.0.1");
    await once(localServer, "listening");
    const url = "http://127.0.0.1:" + localServer.address().port;
    const signup = await auth.api.signUpEmail({
      body: { name: "Original Fixture", email: "fixture@example.test", password: "fixture-password-only" }, asResponse: true,
    });
    assert.equal(signup.status, 200);
    const cookie = signup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const tokenResponse = await fetch(url + "/api/auth/token", { headers: { cookie } });
    assert.equal(tokenResponse.status, 200);
    const { token } = await tokenResponse.json();
    const updated = await fetch(url + "/api/users/me", {
      method: "PATCH", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ name: "Updated Fixture", image: hostedImage }),
    });
    assert.equal(updated.status, 200);
    const session = await fetch(url + "/api/auth/get-session?disableRefresh=true", { headers: { cookie } });
    assert.equal(session.status, 200);
    const { user } = await session.json();
    assert.equal(user.name, "Updated Fixture");
    assert.equal(user.image, hostedImage);
    assert.equal(user.email, "fixture@example.test");
    assert.equal(user.role, "student");
    assert.equal(user.plan, "free");
  } finally {
    if (localServer) await new Promise((resolve) => localServer.close(resolve));
    try {
      await db.dropDatabase();
    } finally {
      await mongo.close();
      if (authSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = authSecret;
    }
  }
});
