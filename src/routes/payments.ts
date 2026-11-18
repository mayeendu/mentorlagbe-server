import { json, raw, Router, type RequestHandler } from "express";
import { MongoServerError, ObjectId, type ClientSession, type Db, type Filter } from "mongodb";
import { z } from "zod";
import { verifyAdmin } from "../middleware/authorization.js";
import type { FinalStatus, PaymentProvider, StripeReceipt, UpgradeRole } from "../payments/provider.js";
import { listQueryFields, literalSearch } from "./admin-query.js";
import { idSchema, tuitionError } from "./tuitions.js";

const prices = { student: 1000, tutor: 1500 } as const;
const roleSchema = z.enum(["student", "tutor"]);
const historyQuery = z.strictObject({
  ...listQueryFields,
  status: z.enum(["pending", "paid", "failed", "canceled"]).optional(),
  provider: z.enum(["mock", "stripe", "stripe-test", "stripe-live"]).optional(),
});
const attemptBody = z.strictObject({ attemptId: idSchema });
const simulationBody = attemptBody.extend({ outcome: z.enum(["success", "failure", "cancel"]) });
const outcomes = { success: "paid", failure: "failed", cancel: "canceled" } as const;

type Payment = {
  _id: ObjectId;
  userId: ObjectId;
  role: UpgradeRole;
  amount: number;
  currency: "usd";
  provider?: PaymentProvider["name"] | null;
  testMode?: boolean;
  status: "pending" | FinalStatus;
  mockSessionId?: string;
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  createdAt: Date;
  updatedAt: Date;
  paidAt?: Date;
};
type BillingUser = { _id: ObjectId; role?: string; plan?: string };
type PaymentEvent = { _id: string; createdAt: Date };

export async function ensurePaymentIndexes(db: Db) {
  await db.collection("payments").createIndexes([
    { key: { stripeSessionId: 1 }, unique: true, partialFilterExpression: { stripeSessionId: { $type: "string" } } },
    { key: { stripePaymentIntentId: 1 }, unique: true, partialFilterExpression: { stripePaymentIntentId: { $type: "string" } } },
    { key: { mockSessionId: 1 }, unique: true, partialFilterExpression: { mockSessionId: { $type: "string" } } },
    { key: { userId: 1 }, unique: true, partialFilterExpression: { status: "pending" } },
    { key: { userId: 1, createdAt: -1, _id: -1 } },
    { key: { createdAt: -1, _id: -1 } },
  ]);
  await db.createCollection("payment_events").catch((error: unknown) => {
    if (!(error instanceof MongoServerError) || error.code !== 48) throw error;
  });
}

function isDuplicate(error: unknown) {
  return error instanceof MongoServerError && error.code === 11000;
}

function matchesProvider(payment: Payment, provider: PaymentProvider) {
  return (payment.provider ?? "stripe") === provider.name && (payment.testMode ?? true) === provider.testMode;
}

export function paymentRoutes(db: Db, verifyToken: RequestHandler, clientOrigin: string, provider: PaymentProvider | null) {
  if (provider?.name === "mock" && process.env.NODE_ENV === "production") throw new Error("Mock payments cannot run in production");
  const router = Router();
  const payments = db.collection<Payment>("payments");
  const events = db.collection<PaymentEvent>("payment_events");
  const users = db.collection<BillingUser>("user");
  const noStore: RequestHandler = (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  };

  async function settle(
    payment: Payment, status: FinalStatus, session: ClientSession,
    references: Pick<Payment, "stripeSessionId" | "stripePaymentIntentId"> = {},
  ) {
    const now = new Date();
    await payments.updateOne({ _id: payment._id }, { $set: {
      ...references, status, updatedAt: now, ...(status === "paid" ? { paidAt: now } : {}),
    } }, { session });
    if (status === "paid") {
      const upgraded = await users.updateOne({ _id: payment.userId }, { $set: { plan: "pro" } }, { session });
      if (!upgraded.matchedCount) throw new Error("Payment user is unavailable");
    }
  }

  router.post("/payments/webhook", raw({ type: "application/json", limit: "256kb", inflate: false }), async (req, res) => {
    if (provider?.name !== "stripe") {
      res.status(503).json({ error: "Stripe webhooks are disabled." });
      return;
    }
    let receipt: StripeReceipt | null;
    try {
      const signature = req.get("stripe-signature");
      if (!signature || !Buffer.isBuffer(req.body)) throw new Error("Missing signature or raw body");
      receipt = provider.verifyWebhook(req.body, signature);
    } catch {
      res.status(400).json({ error: "Invalid Stripe webhook." });
      return;
    }
    if (!receipt) {
      res.sendStatus(200);
      return;
    }
    const attempt = idSchema.safeParse(receipt.attemptId);
    if (!attempt.success) {
      res.status(400).json({ error: "Invalid payment attempt." });
      return;
    }

    const eventId = receipt.eventId;
    const details = receipt;
    try {
      const valid = await db.client.withSession((session) => session.withTransaction(async () => {
        if (await events.findOne({ _id: eventId }, { session })) return true;
        const payment = await payments.findOne({ _id: new ObjectId(attempt.data) }, { session });
        if (!payment || !matchesProvider(payment, provider) ||
          (payment.stripeSessionId && payment.stripeSessionId !== details.sessionId) ||
          (payment.stripePaymentIntentId && details.paymentIntentId && payment.stripePaymentIntentId !== details.paymentIntentId) ||
          payment.userId.toHexString() !== details.userId || payment.role !== details.role ||
          payment.amount !== details.amount || payment.currency !== details.currency) return false;

        if (payment.status !== "paid" && (details.status === "paid" || payment.status === "pending")) {
          await settle(payment, details.status, session, {
            stripeSessionId: details.sessionId,
            ...(details.paymentIntentId ? { stripePaymentIntentId: details.paymentIntentId } : {}),
          });
        }
        await events.insertOne({ _id: eventId, createdAt: new Date() }, { session });
        return true;
      }));
      if (!valid) {
        res.status(400).json({ error: "Stripe session does not match a payment attempt." });
        return;
      }
    } catch (error) {
      if (!(isDuplicate(error) && await events.findOne({ _id: eventId }))) throw error;
    }
    res.sendStatus(200);
  });

  const checkout: RequestHandler = async (req, res) => {
    if (!z.strictObject({}).safeParse(req.body ?? {}).success) {
      res.status(400).json({ error: "Checkout does not accept pricing or account details." });
      return;
    }
    if (!provider) {
      res.status(503).json({ error: "Payments are unavailable." });
      return;
    }

    const userId: ObjectId = res.locals.authUserId;
    const reserve = () => db.client.withSession((session) => session.withTransaction(async () => {
      const user = await users.findOne({ _id: userId }, { session });
      const role = roleSchema.safeParse(user?.role);
      if (!role.success) return { status: 403, error: "Only student and tutor accounts can upgrade." } as const;
      if (user?.plan === "pro") return { status: 409, error: "Your account already has Pro." } as const;
      const existing = await payments.findOne({ userId, status: "pending" }, { session });
      if (existing) {
        if (!matchesProvider(existing, provider) || existing.role !== role.data) {
          return { status: 409, error: "An earlier checkout is still pending." } as const;
        }
        return { payment: existing };
      }
      const _id = new ObjectId();
      const now = new Date();
      const payment: Payment = {
        _id, userId, role: role.data, amount: prices[role.data], currency: "usd", status: "pending",
        provider: provider.name, testMode: provider.testMode, createdAt: now, updatedAt: now,
        ...(provider.name === "mock" ? { mockSessionId: "mock_" + _id.toHexString() } : {}),
      };
      await payments.insertOne(payment, { session });
      return { payment };
    }));
    const reserved = await reserve().catch((error: unknown) => {
      if (!isDuplicate(error)) throw error;
      return reserve();
    });
    if (reserved.status !== undefined) {
      res.status(reserved.status).json({ error: reserved.error });
      return;
    }

    const payment = reserved.payment;
    let opened;
    try {
      opened = await provider.open({
        attemptId: payment._id.toHexString(), userId: userId.toHexString(), role: payment.role,
        amount: payment.amount, currency: payment.currency, stripeSessionId: payment.stripeSessionId,
      }, clientOrigin);
    } catch {
      res.status(502).json({ error: "Could not open Checkout. Try again shortly." });
      return;
    }
    if (provider.name === "stripe" && opened.sessionId) {
      await payments.updateOne({ _id: payment._id, status: "pending", stripeSessionId: { $exists: false } }, {
        $set: { stripeSessionId: opened.sessionId, updatedAt: new Date() },
      });
    }
    if (!opened.url) {
      res.status(409).json({ error: "Checkout is closed. Check your payment history for its status." });
      return;
    }
    res.json({ provider: provider.name, testMode: provider.testMode, url: opened.url });
  };

  const mockComplete: RequestHandler = async (req, res) => {
    if (provider?.name !== "mock" || process.env.NODE_ENV === "production") {
      res.sendStatus(404);
      return;
    }
    const body = simulationBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid simulation request." });
      return;
    }

    const { attemptId, outcome } = body.data;
    const status = outcomes[outcome];
    const result = await db.client.withSession((session) => session.withTransaction(async () => {
      const userId: ObjectId = res.locals.authUserId;
      const payment = await payments.findOne({
        _id: new ObjectId(attemptId), userId, provider: "mock", testMode: true, mockSessionId: "mock_" + attemptId.toLowerCase(),
      }, { session });
      if (!payment) return { code: 404, error: "Mock checkout not found." };
      const user = await users.findOne({ _id: userId }, { session });
      if (!user || user.role !== payment.role) return { code: 403, error: "This account cannot complete the checkout." };
      if (payment.status === status) return { code: 200, status };
      if (payment.status !== "pending" || (status === "paid" && user.plan === "pro")) {
        return { code: 409, error: "Checkout has already been resolved." };
      }
      await settle(payment, status, session);
      return { code: 200, status };
    }));
    res.status(result.code).json(result.code === 200 ? { status: result.status } : { error: result.error });
  };

  const cancel: RequestHandler = async (req, res) => {
    const body = attemptBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid checkout attempt." });
      return;
    }
    const payment = await payments.findOne({ _id: new ObjectId(body.data.attemptId), userId: res.locals.authUserId });
    if (!payment) {
      res.status(404).json({ error: "Checkout attempt not found." });
      return;
    }
    if (provider?.name !== "stripe" || !matchesProvider(payment, provider) || !payment.stripeSessionId || payment.status !== "pending") {
      res.status(409).json({ error: "This checkout can no longer be canceled." });
      return;
    }
    try {
      if (!await provider.cancel(payment.stripeSessionId)) {
        res.status(409).json({ error: "Stripe has already completed this checkout. Check your payment history." });
        return;
      }
      res.status(202).json({ pending: true });
    } catch {
      res.status(502).json({ error: "Could not cancel Stripe Checkout. Refresh your payment status before retrying." });
    }
  };

  const parseBody = json({ limit: "2kb" });
  router.post("/payments/checkout", noStore, verifyToken, parseBody, checkout);
  router.post("/payments/mock/complete", noStore, verifyToken, parseBody, mockComplete);
  router.post("/payments/cancel", noStore, verifyToken, parseBody, cancel);
  router.get("/payments/mine", noStore, verifyToken, (async (_req, res) => {
    const userId: ObjectId = res.locals.authUserId;
    const [user, rows] = await Promise.all([
      users.findOne({ _id: userId }, { projection: { plan: 1 } }),
      payments.find({ userId }, { projection: { userId: 0 } }).sort({ createdAt: -1, _id: -1 }).toArray(),
    ]);
    res.json({ plan: user?.plan === "pro" ? "pro" : "free", payments: rows });
  }) satisfies RequestHandler);
  router.get("/admin/payments", noStore, verifyToken, verifyAdmin, (async (req, res) => {
    const input = historyQuery.safeParse(req.query);
    if (!input.success) {
      res.status(400).json({ error: "Invalid payment filters or pagination." });
      return;
    }
    const { page, limit, search, status, provider: source } = input.data;
    const filter: Filter<Payment> = {};
    if (status) filter.status = status;
    if (source === "mock") filter.provider = "mock";
    if (source?.startsWith("stripe")) {
      filter.provider = { $in: ["stripe", null] };
      if (source === "stripe-live") {
        filter.provider = "stripe";
        filter.testMode = false;
      } else if (source === "stripe-test") filter.testMode = { $ne: false };
    }
    if (search) {
      const pattern = literalSearch(search);
      filter.$or = [{ stripeSessionId: pattern }, { stripePaymentIntentId: pattern }, { mockSessionId: pattern }];
      const role = roleSchema.safeParse(search.toLowerCase());
      if (role.success) filter.$or.push({ role: role.data });
      if (idSchema.safeParse(search).success) {
        const id = new ObjectId(search);
        filter.$or.push({ _id: id }, { userId: id });
      }
    }
    const [items, total] = await Promise.all([
      payments.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      payments.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  }) satisfies RequestHandler);
  router.use(tuitionError);

  return router;
}
