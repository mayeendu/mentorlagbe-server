import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { ObjectId, type Db } from "mongodb";
import { apiJwt } from "./jwt.js";

export function createAuth(
  db: Db, baseURL: string, clientOrigin: string,
  secret = process.env.BETTER_AUTH_SECRET,
  production = process.env.NODE_ENV === "production",
) {
  if (!secret || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  }

  return betterAuth({
    baseURL,
    secret,
    trustedOrigins: [clientOrigin, baseURL],
    advanced: { useSecureCookies: production || baseURL.startsWith("https://") },
    session: { cookieCache: { enabled: false } },
    database: mongodbAdapter(db),
    plugins: [apiJwt(baseURL)],
    emailAndPassword: { enabled: true },
    onAPIError: {
      onError: (error) => {
        if (error instanceof Error && error.message.startsWith("Failed to decrypt private key.")) {
          console.error("API token signing key could not be decrypted. Check that BETTER_AUTH_SECRET matches the secret used to create the stored JWKS.");
          return;
        }
        console.error("Authentication request failed.");
      },
    },
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
      session: {
        create: {
          before: async (session) => {
            if (!ObjectId.isValid(session.userId)) return;
            const user = await db.collection("user").findOne({ _id: new ObjectId(session.userId) }, { projection: { disabled: 1 } });
            if (user?.disabled === true) throw new APIError("FORBIDDEN", { message: "This account is disabled." });
          },
        },
      },
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
