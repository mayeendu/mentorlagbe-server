import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import { decodeJwt } from "jose";
import { ObjectId } from "mongodb";
import { apiJwt } from "../dist/config/jwt.js";
import { createVerifyToken } from "../dist/middleware/authorization.js";
import { protectAuth, secureApi } from "../dist/middleware/http-security.js";
import { roleTestRoutes } from "../dist/routes/role-tests.js";

describe("Bearer authorization", () => {
  const issuer = "http://localhost:5000";
  const roles = ["student", "tutor", "admin"];
  const currentRoles = new Map();
  const tokens = new Map();
  const auth = betterAuth({
    baseURL: issuer,
    secret: "authorization-tests-only-secret-8d3a4591f7c2",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }),
    advanced: { useSecureCookies: true, database: { generateId: () => new ObjectId().toHexString() } },
    plugins: [apiJwt(issuer)],
    emailAndPassword: { enabled: true },
  });

  // Keep the production ObjectId query in the test while isolating the database.
  const db = {
    collection(name) {
      assert.equal(name, "user");
      return {
        async findOne({ _id }) {
          assert.ok(_id instanceof ObjectId);
          const role = currentRoles.get(_id.toHexString());
          return role ? { role } : null;
        },
      };
    },
  };
  const app = express();
  app.use("/api", secureApi(true));
  app.all("/api/auth/*splat", ...protectAuth(issuer), toNodeHandler(auth));
  app.use("/api", roleTestRoutes(createVerifyToken(db, issuer, () => auth.api.getJwks())));
  const server = app.listen(0, "127.0.0.1");
  let api;

  before(async () => {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    api = `http://127.0.0.1:${address.port}/api`;

    for (const role of roles) {
      const signup = await auth.api.signUpEmail({
        body: { name: role, email: `${role}@example.test`, password: "test-password-only" },
        asResponse: true,
      });
      assert.equal(signup.status, 200);
      const cookies = signup.headers.getSetCookie();
      assert.ok(cookies.some((value) => value.startsWith("__Secure-") && /; Secure\b/i.test(value)));
      const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
      const response = await fetch(`${api}/auth/token`, { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/);
      const { token } = await response.json();
      const claims = decodeJwt(token);
      assert.ok(claims.sub);
      assert.equal(claims.role, undefined);
      currentRoles.set(claims.sub, role);
      tokens.set(role, token);
    }
  });

  after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  function request(role, token) {
    return fetch(`${api}/${role}/test`, {
      headers: token ? { authorization: `Bearer ${token}`, "x-role": "admin" } : {},
    });
  }

  for (const role of roles) {
    it(`limits a ${role} to the matching route`, async () => {
      for (const routeRole of roles) {
        const result = await request(routeRole, tokens.get(role));
        assert.equal(result.status, role === routeRole ? 200 : 403);
        if (role === routeRole) assert.deepEqual(await result.json(), { role });
      }
    });
  }

  it("requires a Bearer JWT on all protected routes", async () => {
    for (const role of roles) {
      assert.equal((await request(role)).status, 401);
      assert.equal((await request(role, "malformed-token")).status, 401);
    }
    assert.equal((await fetch(`${api}/auth/token`)).status, 401);
  });

  it("rejects a token with a modified signature", async () => {
    const token = tokens.get("student");
    const [header, payload, signature] = token.split(".");
    const invalid = `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    assert.equal((await request("student", invalid)).status, 401);
  });

  const claimCases = [
    { label: "expired", claims: { exp: 1 } },
    { label: "issued by another issuer", claims: { iss: "https://other.example" } },
    { label: "issued for another audience", claims: { aud: "https://other.example" } },
  ];
  for (const { label, claims } of claimCases) {
    it(`rejects a correctly signed JWT that is ${label}`, async () => {
      const { sub } = decodeJwt(tokens.get("student"));
      const { token } = await auth.api.signJWT({ body: { payload: { sub, ...claims } } });
      assert.equal((await request("student", token)).status, 401);
    });
  }

  it("applies role changes and user removal to an already issued JWT", async () => {
    const token = tokens.get("admin");
    const { sub } = decodeJwt(token);
    assert.ok(sub);
    currentRoles.set(sub, "student");
    assert.equal((await request("admin", token)).status, 403);
    assert.equal((await request("student", token)).status, 200);
    currentRoles.delete(sub);
    assert.equal((await request("student", token)).status, 401);
  });
});
