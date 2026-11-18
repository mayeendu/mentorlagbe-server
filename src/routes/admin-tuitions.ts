import { json, Router, type RequestHandler } from "express";
import { ObjectId, type Db, type Document } from "mongodb";
import { z } from "zod";
import { verifyAdmin } from "../middleware/authorization.js";
import { approvalStatus, idSchema, tuitionError, type Tuition } from "./tuitions.js";

const positiveInteger = (max: number) => z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(max));
const listQuery = z.strictObject({
  status: approvalStatus.optional(),
  page: positiveInteger(1_000_000).default(1),
  limit: positiveInteger(50).default(15),
  search: z.string().trim().max(100).default(""),
});
const decisionBody = z.strictObject({ expectedUpdatedAt: z.iso.datetime().optional() });

const tutorLookup = {
  $lookup: {
    from: "user",
    localField: "tutorId",
    foreignField: "_id",
    pipeline: [{ $project: { _id: 0, name: 1 } }],
    as: "tutor",
  },
};
const reviewFields = {
  title: 1, subject: 1, monthlyFee: 1, createdAt: 1, updatedAt: 1,
  approvalStatus: 1, description: 1, isActive: 1,
} as const;

export function adminTuitionRoutes(db: Db, verifyToken: RequestHandler) {
  const router = Router();
  const posts = db.collection<Tuition>("tuitions");

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  }, verifyToken, verifyAdmin);

  router.get("/", async (req, res) => {
    const input = listQuery.safeParse(req.query);
    if (!input.success) {
      res.status(400).json({ error: "Invalid tuition filters or pagination." });
      return;
    }

    const { status, page, limit, search } = input.data;
    const pipeline: Document[] = [
      ...(status ? [{ $match: { approvalStatus: status } }] : []),
      { $sort: { createdAt: -1, _id: -1 } },
    ];
    if (search) {
      const literal = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = { $regex: literal, $options: "i" };
      pipeline.push(tutorLookup, {
        $match: { $or: [{ title: match }, { subject: match }, { "tutor.name": match }] },
      });
    }
    pipeline.push({
      $facet: {
        items: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          ...(search ? [] : [tutorLookup]),
          { $project: { ...reviewFields, tutorName: { $ifNull: [{ $first: "$tutor.name" }, null] } } },
        ],
        count: [{ $count: "total" }],
      },
    });

    const result = await posts.aggregate<{ items: Document[]; count: { total: number }[] }>(pipeline).next();
    res.json({ items: result?.items ?? [], total: result?.count[0]?.total ?? 0, page, limit });
  });

  const decide = (status: "approved" | "rejected"): RequestHandler => async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const body = decisionBody.safeParse(req.body ?? {});
    if (!id.success || !body.success) {
      res.status(400).json({ error: id.success ? "Invalid review request." : "Invalid tuition ID." });
      return;
    }

    const _id = new ObjectId(id.data);
    const expected = body.data.expectedUpdatedAt;
    const result = await posts.findOneAndUpdate(
      { _id, approvalStatus: "pending", ...(expected ? { updatedAt: new Date(expected) } : {}) },
      { $set: { approvalStatus: status }, $currentDate: { updatedAt: true } },
      { returnDocument: "after", projection: reviewFields },
    );
    if (result) {
      res.json(result);
      return;
    }

    const existing = await posts.findOne({ _id }, { projection: { approvalStatus: 1 } });
    if (!existing) res.status(404).json({ error: "Tuition not found." });
    else if (existing.approvalStatus !== "pending") res.status(409).json({ error: "Only pending tuition posts can be reviewed." });
    else res.status(409).json({ error: "This post changed. Review the latest version before deciding." });
  };

  const parseDecision = json({ limit: "2kb" });
  router.patch("/:id/approve", parseDecision, decide("approved"));
  router.patch("/:id/reject", parseDecision, decide("rejected"));
  router.use(tuitionError);
  return router;
}
