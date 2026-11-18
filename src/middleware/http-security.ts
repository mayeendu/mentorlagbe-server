import cors from "cors";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";

export function secureApi(production: boolean): RequestHandler {
  return (_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    if (production) res.set("Strict-Transport-Security", "max-age=31536000");
    next();
  };
}

export function apiCors(clientOrigin: string, authOrigin: string) {
  const origins = [clientOrigin, authOrigin];
  const rejectUnknown: RequestHandler = (req, res, next) => {
    const origin = req.get("origin");
    if (origin && !origins.includes(origin)) {
      res.status(403).json({ error: "Origin is not allowed." });
      return;
    }
    next();
  };
  return [rejectUnknown, cors({
    origin: origins,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  })];
}

export function protectAuth(authOrigin: string): RequestHandler[] {
  const authority = new URL(authOrigin);
  const validate: RequestHandler = (req, res, next) => {
    if (!["GET", "HEAD", "POST"].includes(req.method)) {
      res.set("Allow", "GET, HEAD, POST").status(405).json({ error: "Method not allowed." });
      return;
    }
    const hasBody = Number(req.get("content-length") ?? 0) > 0 || req.get("transfer-encoding");
    if (hasBody && (req.method !== "POST" || !req.is(["application/json", "application/x-www-form-urlencoded"]))) {
      res.status(415).json({ error: "Unsupported authentication request body." });
      return;
    }
    // The Node adapter constructs its URL from these headers.
    req.headers.host = authority.host;
    req.headers["x-forwarded-proto"] = authority.protocol.slice(0, -1);
    delete req.headers[":authority"];
    next();
  };
  return [
    validate,
    express.json({ limit: "16kb", inflate: false }),
    express.urlencoded({ limit: "16kb", extended: false, inflate: false, parameterLimit: 30 }),
  ];
}

export const apiError: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error.status === 413) {
    const imageUpload = req.method === "POST" && ["/api/users/me/avatar", "/api/tutor/tuitions/image"].includes(req.originalUrl.split("?")[0]);
    res.status(413).json({ error: imageUpload ? "Images must be 5 MB or smaller." : "Request body is too large." });
  } else if (error.status === 400) {
    res.status(400).json({ error: "Invalid request body." });
  } else if (error.status === 415) {
    res.status(415).json({ error: "Unsupported request encoding or content type." });
  } else {
    console.error("API request failed.", { method: req.method });
    res.status(500).json({ error: "Could not complete the request." });
  }
};
