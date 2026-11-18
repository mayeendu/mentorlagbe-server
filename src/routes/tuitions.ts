import { json, Router, type ErrorRequestHandler, type RequestHandler } from "express";
import { ObjectId, type Db } from "mongodb";
import { z } from "zod";
import { verifyTutor } from "../middleware/authorization.js";
import { isHostedImage, readImage, uploadTuitionImage } from "./tuition-images.js";

const details = z.strictObject({
  title: z.string().trim().min(3).max(100),
  subject: z.string().trim().min(2).max(80),
  location: z.string().trim().min(2).max(120),
  classLevel: z.string().trim().min(1).max(80).nullable().optional(),
  format: z.enum(["Home tuition", "Online"]),
  daysPerWeek: z.number().int().min(1).max(7),
  monthlyFee: z.number().int().min(1).max(1_000_000),
  description: z.string().trim().min(10).max(2000),
  imageUrl: z.string().max(2048).refine(isHostedImage).nullable(),
});
const updateDetails = details.partial().refine((value) => Object.keys(value).length > 0);
const activeState = z.strictObject({ isActive: z.boolean() });
export const idSchema = z.string().regex(/^[a-f0-9]{24}$/i);
export const approvalStatus = z.enum(["pending", "approved", "rejected"]);
export type Tuition = z.infer<typeof details> & {
  tutorId: ObjectId;
  applicationWriteVersion?: ObjectId;
  approvalStatus: z.infer<typeof approvalStatus>;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export async function ensureTuitionIndexes(db: Db) {
  await db.collection("tuitions").createIndexes([
    { key: { tutorId: 1, createdAt: -1, _id: -1 } },
    { key: { approvalStatus: 1, isActive: 1, createdAt: -1, _id: -1 } },
    { key: { approvalStatus: 1, createdAt: -1, _id: -1 } },
    { key: { createdAt: -1, _id: -1 } },
  ]);
}

export const tuitionError: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error.status === 413) {
    res.status(413).json({ error: _req.path === "/image" ? "Images must be 5 MB or smaller." : "Request body is too large." });
  } else if (error.status === 400) {
    res.status(400).json({ error: "Invalid request body." });
  } else if (error.status === 415) {
    res.status(415).json({ error: "Unsupported image encoding." });
  } else {
    res.status(500).json({ error: "Could not complete the request." });
  }
};

export function tuitionRoutes(db: Db, verifyToken: RequestHandler) {
  const router = Router();
  const posts = db.collection<Tuition>("tuitions");
  const users = db.collection<{ _id: ObjectId; role: string; plan?: string }>("user");

  router.use(verifyToken, verifyTutor);
  router.post("/image", readImage, uploadTuitionImage);
  router.use(json({ limit: "32kb" }));
  router.param("id", (_req, res, next, id) => {
    if (!idSchema.safeParse(id).success) {
      res.status(400).json({ error: "Invalid tuition ID." });
      return;
    }
    res.locals.tuitionFilter = { _id: new ObjectId(id), tutorId: res.locals.authUserId };
    next();
  });

  router.get("/", async (_req, res) => {
    const items = await posts.find({ tutorId: res.locals.authUserId }, { projection: { applicationWriteVersion: 0 } }).sort({ createdAt: -1, _id: -1 }).toArray();
    res.json(items);
  });

  router.post("/", async (req, res) => {
    const input = details.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Check the tuition details.", issues: input.error.flatten().fieldErrors });
      return;
    }

    const tutorId: ObjectId = res.locals.authUserId;
    const result = await db.client.withSession((session) => session.withTransaction(async () => {
      // Write to the same user document before counting so concurrent creates serialize.
      const tutor = await users.findOneAndUpdate(
        { _id: tutorId, role: "tutor" },
        { $set: { tuitionWriteVersion: new ObjectId() } },
        { session, projection: { plan: 1 } },
      );
      if (!tutor) return { status: 403, body: { error: "Forbidden" } };
      if (tutor.plan !== "pro" && await posts.countDocuments({ tutorId }, { session, limit: 2 }) >= 2) {
        return { status: 409, body: { error: "Free tutors can have up to two tuition posts, including inactive posts." } };
      }

      const now = new Date();
      const tuition: Tuition = {
        ...input.data, tutorId, approvalStatus: "pending", isActive: true, createdAt: now, updatedAt: now,
      };
      const { insertedId } = await posts.insertOne(tuition, { session });
      return { status: 201, body: { ...tuition, _id: insertedId } };
    }));
    res.status(result.status).json(result.body);
  });

  router.get("/:id", async (_req, res) => {
    const tuition = await posts.findOne(res.locals.tuitionFilter, { projection: { applicationWriteVersion: 0 } });
    if (tuition) res.json(tuition);
    else res.status(404).json({ error: "Tuition not found." });
  });

  router.patch("/:id", async (req, res) => {
    const input = updateDetails.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Check the tuition details.", issues: input.error.flatten().fieldErrors });
      return;
    }

    const fields = Object.entries(input.data).map(([key, value]) => [key, { $literal: value }] as const);
    const tuition = await posts.findOneAndUpdate(res.locals.tuitionFilter, [
      { $set: {
        ...Object.fromEntries(fields),
        approvalStatus: { $cond: [
          { $or: fields.map(([key, value]) => ({ $ne: [{ $ifNull: ["$" + key, null] }, value] })) },
          "pending",
          "$approvalStatus",
        ] },
        updatedAt: "$$NOW",
      } },
    ], { returnDocument: "after", projection: { applicationWriteVersion: 0 } });
    if (tuition) res.json(tuition);
    else res.status(404).json({ error: "Tuition not found." });
  });

  router.patch("/:id/active", async (req, res) => {
    const input = activeState.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Choose an active or inactive state." });
      return;
    }
    const tuition = await posts.findOneAndUpdate(
      res.locals.tuitionFilter, { $set: { ...input.data, updatedAt: new Date() } }, { returnDocument: "after", projection: { applicationWriteVersion: 0 } },
    );
    if (tuition) res.json(tuition);
    else res.status(404).json({ error: "Tuition not found." });
  });

  router.delete("/:id", async (_req, res) => {
    const { deletedCount } = await posts.deleteOne(res.locals.tuitionFilter);
    if (deletedCount) res.sendStatus(204);
    else res.status(404).json({ error: "Tuition not found." });
  });

  router.use(tuitionError);
  return router;
}
