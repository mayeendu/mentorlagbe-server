import { Router } from "express";
import { ObjectId, type Db, type Filter } from "mongodb";
import { z } from "zod";
import { idSchema, tuitionError, type Tuition } from "./tuitions.js";

const positiveInteger = (max: number) => z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(max));
const querySchema = z.strictObject({
  search: z.string().trim().max(100).default(""),
  subject: z.string().trim().min(1).max(80).optional(),
  classLevel: z.string().trim().min(1).max(80).optional(),
  mode: z.enum(["home", "online"]).optional(),
  page: positiveInteger(1_000_000).default(1),
  limit: positiveInteger(50).default(12),
});
export const publicTuitionVisibility = { approvalStatus: "approved", isActive: true } as const;
const formats = { home: "Home tuition", online: "Online" } as const;
const cardFields = { title: 1, subject: 1, classLevel: 1, format: 1, daysPerWeek: 1, monthlyFee: 1, location: 1, createdAt: 1 } as const;

function literalPattern(value: string, exact = false) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(exact ? "^" + escaped + "$" : escaped, "i");
}

export function publicTuitionRoutes(db: Db) {
  const router = Router();
  const posts = db.collection<Tuition>("tuitions");
  const users = db.collection<{ _id: ObjectId; name?: string }>("user");

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/", async (req, res) => {
    const query = querySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid tuition filters or pagination." });
      return;
    }

    const { search, subject, classLevel, mode, page, limit } = query.data;
    const filter: Filter<Tuition> = { ...publicTuitionVisibility };
    if (search) {
      const pattern = literalPattern(search);
      filter.$or = [{ title: pattern }, { subject: pattern }];
    }
    if (subject) filter.subject = literalPattern(subject, true);
    if (classLevel) filter.classLevel = literalPattern(classLevel, true);
    if (mode) filter.format = formats[mode];

    const [items, total] = await Promise.all([
      posts.find(filter, { projection: cardFields }).sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit).limit(limit).toArray(),
      posts.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  });

  router.get("/:id", async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "Invalid tuition ID." });
      return;
    }
    const post = await posts.findOne(
      { _id: new ObjectId(id.data), ...publicTuitionVisibility },
      { projection: { ...cardFields, tutorId: 1, description: 1, imageUrl: 1 } },
    );
    if (!post) {
      res.status(404).json({ error: "Tuition not found." });
      return;
    }
    const { tutorId, ...details } = post;
    const tutor = await users.findOne({ _id: tutorId }, { projection: { name: 1 } });
    res.json({ ...details, tutorName: tutor?.name ?? null });
  });

  router.use(tuitionError);
  return router;
}
