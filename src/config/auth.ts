import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Db } from "mongodb";
import { apiJwt } from "./jwt.js";

export function createAuth(db: Db, baseURL: string, clientOrigin: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  }

  return betterAuth({
    baseURL,
    secret,
    trustedOrigins: [clientOrigin],
    database: mongodbAdapter(db),
    plugins: [apiJwt(baseURL)],
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        role: { type: "string", defaultValue: "student", input: false },
        plan: { type: "string", defaultValue: "free", input: false },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path !== "/sign-up/email") return;

        const { accountType, role, plan } = context.body ?? {};
        if (role !== undefined || plan !== undefined) {
          throw new APIError("BAD_REQUEST", { message: "Role and plan are assigned by the server." });
        }
        if (accountType !== undefined && accountType !== "student" && accountType !== "tutor") {
          throw new APIError("BAD_REQUEST", { message: "Select Student or Tutor." });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => ({
            data: {
              ...user,
              role: context?.path === "/sign-up/email" && context.body?.accountType === "tutor"
                ? "tutor"
                : "student",
              plan: "free",
            },
          }),
        },
      },
    },
  });
}
