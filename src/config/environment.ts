import { paymentMode } from "./payment-mode.js";

export class ConfigurationError extends Error {}

function required(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key];
  if (!value || value.trim() !== value) throw new ConfigurationError(key + " must be set without surrounding whitespace.");
  return value;
}

function origin(value: string, key: string, production: boolean) {
  try {
    const url = new URL(value);
    const secure = url.protocol === "https:";
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!secure && (production || url.protocol !== "http:" || !loopback)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    if (production && loopback) throw new Error();
    return url.origin;
  } catch {
    throw new ConfigurationError(key + " must be an HTTPS origin without a path or credentials (loopback HTTP is allowed only in development).");
  }
}

export function readEnvironment(env = process.env) {
  const mode = env.NODE_ENV || "development";
  if (!["development", "test", "production"].includes(mode)) throw new ConfigurationError("NODE_ENV is invalid.");
  const production = mode === "production";
  const port = Number(env.PORT ?? "5000");
  if (!/^\d+$/.test(env.PORT ?? "5000") || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError("PORT must be an integer from 1 to 65535.");
  }
  const authOrigin = origin(required(env, "BETTER_AUTH_URL"), "BETTER_AUTH_URL", production);
  const clientOrigin = origin(required(env, "CLIENT_URL"), "CLIENT_URL", production);
  const authSecret = required(env, "BETTER_AUTH_SECRET");
  if (authSecret.length < 32) throw new ConfigurationError("BETTER_AUTH_SECRET must have at least 32 characters.");

  const mongoUri = required(env, "MONGODB_URI");
  if (!/^mongodb(?:\+srv)?:\/\/[^?#\s]+(?:\?[^#\s]*)?$/.test(mongoUri)) {
    throw new ConfigurationError("MONGODB_URI must be a valid MongoDB connection string.");
  }
  if (production) {
    const query = new URLSearchParams(mongoUri.split("?")[1]);
    for (const [name, value] of query) {
      const option = name.toLowerCase();
      const setting = value.toLowerCase();
      if ((["tls", "ssl"].includes(option) && setting !== "true") ||
        (["tlsinsecure", "tlsallowinvalidcertificates", "tlsallowinvalidhostnames", "directconnection"].includes(option) && setting !== "false")) {
        throw new ConfigurationError("Production MONGODB_URI must use verified TLS and a transaction-capable topology.");
      }
    }
  }

  if (env.IMGBB_API_KEY && !/^[A-Za-z0-9_-]{16,128}$/.test(env.IMGBB_API_KEY)) {
    throw new ConfigurationError("IMGBB_API_KEY has an invalid format.");
  }

  let payments;
  try { payments = paymentMode(env); }
  catch { throw new ConfigurationError("PAYMENT_MODE must be disabled, stripe, or mock (development only)."); }
  if (payments === "stripe") {
    const secret = required(env, "STRIPE_SECRET_KEY");
    const webhook = required(env, "STRIPE_WEBHOOK_SECRET");
    const key = production ? /^sk_live_[A-Za-z0-9]{16,}$/ : /^sk_test_[A-Za-z0-9]{16,}$/;
    if (!key.test(secret) || !/^whsec_[A-Za-z0-9]{16,}$/.test(webhook)) {
      throw new ConfigurationError("Stripe requires the correct mode's secret key and a webhook signing secret.");
    }
  }

  return { authOrigin, clientOrigin, port, production, authSecret, mongoUri };
}
