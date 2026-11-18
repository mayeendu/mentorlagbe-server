import type { RequestHandler } from "express";
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from "jose";
import { ObjectId, type Db } from "mongodb";
import { jwtAlgorithm } from "../config/jwt.js";

type Role = "student" | "tutor" | "admin";

export function createVerifyToken(db: Db, issuer: string, getJwks: () => Promise<JSONWebKeySet>): RequestHandler {
  const users = db.collection<{ _id: ObjectId; role?: unknown }>("user");

  return async (req, res, next) => {
    const token = /^Bearer +([\w-]+\.[\w-]+\.[\w-]+)$/i.exec(req.get("authorization") ?? "")?.[1];
    if (!token) {
      res.set("WWW-Authenticate", "Bearer").status(401).json({ error: "Bearer token required" });
      return;
    }

    const keys = createLocalJWKSet(await getJwks());
    let subject: string | undefined;
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: [jwtAlgorithm],
        issuer,
        audience: issuer,
        requiredClaims: ["sub", "exp"],
      });
      subject = payload.sub;
    } catch (error) {
      if (!(error instanceof errors.JOSEError)) throw error;
    }

    // Better Auth's MongoDB adapter exposes the user's ObjectId as a hex string.
    const user = subject && ObjectId.isValid(subject)
      ? await users.findOne({ _id: new ObjectId(subject) }, { projection: { role: 1 } })
      : null;
    if (!user || !subject) {
      res.set("WWW-Authenticate", 'Bearer error="invalid_token"').status(401).json({ error: "Invalid Bearer token" });
      return;
    }

    res.locals.authUserId = new ObjectId(subject);
    res.locals.authRole = user.role;
    next();
  };
}

function requireRole(role: Role): RequestHandler {
  return (_req, res, next) => {
    if (res.locals.authRole !== role) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

export const verifyStudent = requireRole("student");
export const verifyTutor = requireRole("tutor");
export const verifyAdmin = requireRole("admin");
