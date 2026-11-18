import { Router } from "express";
import type { Collection, Db } from "mongodb";
import type { RequestHandler } from "express";
import { verifyAdmin } from "../middleware/authorization.js";
import { tuitionError } from "./tuitions.js";

export function adminStatsRoutes(db: Db, verifyToken: RequestHandler) {
  const router = Router();
  const users = db.collection("user");
  const tuitions = db.collection("tuitions");
  const applications = db.collection("applications");
  const payments = db.collection("payments");
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  }, verifyToken, verifyAdmin);

  router.get("/", async (_req, res) => {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const paymentType = {
      $switch: {
        branches: [
          { case: { $eq: ["$provider", "mock"] }, then: "mock" },
          { case: { $and: [{ $eq: ["$provider", "stripe"] }, { $eq: ["$testMode", false] }] }, then: "live" },
        ],
        default: "stripeTest",
      },
    };
    const group = (collection: Collection, field: string) => collection.aggregate([
      { $group: { _id: { $ifNull: ["$" + field, "unknown"] }, count: { $sum: 1 } } },
      { $project: { _id: 0, label: "$_id", count: 1 } },
      { $sort: { label: 1 } },
    ]).toArray();
    const recent = (collection: Collection, kind: string, label: string | Record<string, unknown>, status: string, match = {}) =>
      collection.aggregate([
        { $match: match },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: 5 },
        { $project: { kind: { $literal: kind }, label, status, createdAt: 1 } },
      ]).toArray();

    const [roles, plans, tuition, application, money, latestUsers, latestTuitions, latestApplications, latestPayments] = await Promise.all([
      group(users, "role"), group(users, "plan"), group(tuitions, "approvalStatus"), group(applications, "status"),
      payments.aggregate([
        { $match: { status: "paid", currency: "usd" } },
        { $project: { amount: 1, bucket: paymentType, paidDate: { $ifNull: ["$paidAt", "$updatedAt", "$createdAt"] } } },
        { $facet: {
          totals: [
            { $group: { _id: "$bucket", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
            { $project: { _id: 0, bucket: "$_id", amount: 1, count: 1 } },
          ],
          monthly: [
            { $match: { paidDate: { $gte: start, $lt: end } } },
            { $group: { _id: { bucket: "$bucket", month: { $dateToString: { date: "$paidDate", format: "%Y-%m", timezone: "UTC" } } }, amount: { $sum: "$amount" } } },
            { $project: { _id: 0, bucket: "$_id.bucket", month: "$_id.month", amount: 1 } },
          ],
        } },
      ]).next(),
      recent(users, "User", "$name", "$role"),
      recent(tuitions, "Tuition", "$title", "$approvalStatus"),
      recent(applications, "Application", "$tuition.title", "$status"),
      recent(payments, "Payment", paymentType, "$status", { status: "paid", currency: "usd" }),
    ]);

    const monthly = Array.from({ length: 6 }, (_, index) => {
      const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1)).toISOString().slice(0, 7);
      const amount = (bucket: string) => money?.monthly.find((row: { month: string; bucket: string }) => row.month === month && row.bucket === bucket)?.amount ?? 0;
      return { month, live: amount("live"), mock: amount("mock"), stripeTest: amount("stripeTest") };
    });
    const activity = [...latestUsers, ...latestTuitions, ...latestApplications, ...latestPayments]
      .filter((row) => row.createdAt instanceof Date)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 8);
    res.json({ roles, plans, tuition, application, payments: money?.totals ?? [], monthly, activity });
  });

  router.use(tuitionError);
  return router;
}
