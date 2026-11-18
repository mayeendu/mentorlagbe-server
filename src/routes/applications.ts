import { json, Router, type RequestHandler } from "express";
import { MongoServerError, ObjectId, type Db } from "mongodb";
import { z } from "zod";
import { verifyStudent, verifyTutor } from "../middleware/authorization.js";
import { publicTuitionVisibility } from "./public-tuitions.js";
import { idSchema, tuitionError, type Tuition } from "./tuitions.js";

const applicationInput = z.strictObject({
  phone: z.string().trim().max(24).refine((value) => {
    const normalized = value.replace(/[\s().-]/g, "");
    return /^\+?\d{7,15}$/.test(normalized);
  }, "Enter a valid phone number."),
  preferredSchedule: z.string().trim().min(3).max(200),
  studentNote: z.string().trim().max(1000).default(""),
});

type Application = z.infer<typeof applicationInput> & {
  tuitionId: ObjectId;
  studentId: ObjectId;
  tutorId: ObjectId;
  studentName: string | null;
  tutorName: string | null;
  tuition: Pick<Tuition, "title" | "subject" | "monthlyFee" | "format">;
  status: "pending" | "accepted" | "rejected";
  createdAt: Date;
  updatedAt: Date;
};

const privateFields = { studentId: 0, tutorId: 0 } as const;
const privateResponse: RequestHandler = (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};

export async function ensureApplicationIndexes(db: Db) {
  await db.collection("applications").createIndexes([
    { key: { tuitionId: 1, studentId: 1 }, unique: true },
    { key: { studentId: 1, createdAt: -1, _id: -1 } },
    { key: { tutorId: 1, createdAt: -1, _id: -1 } },
  ]);
}

export function applicationRoutes(db: Db, verifyToken: RequestHandler) {
  const router = Router();
  const applications = db.collection<Application>("applications");
  const posts = db.collection<Tuition>("tuitions");
  const users = db.collection<{ _id: ObjectId; name?: string; role?: string }>("user");
  const student = [privateResponse, verifyToken, verifyStudent];
  const tutor = [privateResponse, verifyToken, verifyTutor];

  const create: RequestHandler = async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const input = applicationInput.safeParse(req.body);
    if (!id.success || !input.success) {
      res.status(400).json({ error: id.success ? "Check your application details." : "Invalid tuition ID." });
      return;
    }

    const studentId: ObjectId = res.locals.authUserId;
    const tuitionId = new ObjectId(id.data);
    try {
      const result = await db.client.withSession((session) => session.withTransaction(async () => {
        const applicant = await users.findOne({ _id: studentId, role: "student" }, { session, projection: { name: 1 } });
        if (!applicant) return { status: 403, body: { error: "Forbidden" } };

        // Write the source document in the transaction so changes to visibility and applications serialize.
        const tuition = await posts.findOneAndUpdate(
          { _id: tuitionId, ...publicTuitionVisibility },
          { $set: { applicationWriteVersion: new ObjectId() } },
          { session, projection: { tutorId: 1, title: 1, subject: 1, monthlyFee: 1, format: 1 } },
        );
        if (!tuition) return { status: 404, body: { error: "Tuition not found." } };

        const owner = await users.findOne({ _id: tuition.tutorId }, { session, projection: { name: 1 } });
        const { title, subject, monthlyFee, format, tutorId } = tuition;
        const now = new Date();
        const submitted = {
          ...input.data,
          tuitionId,
          studentName: applicant.name ?? null,
          tutorName: owner?.name ?? null,
          tuition: { title, subject, monthlyFee, format },
          status: "pending" as const,
          createdAt: now,
          updatedAt: now,
        };
        const { insertedId } = await applications.insertOne({ ...submitted, studentId, tutorId }, { session });
        return { status: 201, body: { ...submitted, _id: insertedId } };
      }));
      res.status(result.status).json(result.body);
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      res.status(409).json({ error: "You already applied for this tuition." });
    }
  };

  const list = (owner: "studentId" | "tutorId"): RequestHandler => async (_req, res) => {
    const results = await applications.find({ [owner]: res.locals.authUserId }, { projection: privateFields })
      .sort({ createdAt: -1, _id: -1 }).toArray();
    res.json(results);
  };

  const update = (action: "cancel" | "accepted" | "rejected"): RequestHandler => async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "Invalid application ID." });
      return;
    }

    const ownerId: ObjectId = res.locals.authUserId;
    const owner = action === "cancel" ? { studentId: ownerId } : { tutorId: ownerId };
    const filter = { _id: new ObjectId(id.data), ...owner };
    const pending = { ...filter, status: "pending" as const };
    if (action === "cancel") {
      if ((await applications.deleteOne(pending)).deletedCount) {
        res.sendStatus(204);
        return;
      }
    } else {
      const result = await applications.findOneAndUpdate(
        pending,
        { $set: { status: action }, $currentDate: { updatedAt: true } },
        { returnDocument: "after", projection: privateFields },
      );
      if (result) {
        res.json(result);
        return;
      }
    }

    const existing = await applications.findOne(filter, { projection: { _id: 1 } });
    if (!existing) res.status(404).json({ error: "Application not found." });
    else res.status(409).json({ error: action === "cancel" ? "Only pending applications can be cancelled." : "Only pending applications can be reviewed." });
  };

  router.post("/tuitions/:id/applications", student, json({ limit: "8kb" }), create);
  router.get("/student/my-applications", student, list("studentId"));
  router.delete("/student/my-applications/:id", student, update("cancel"));
  router.get("/tutor/applicants", tutor, list("tutorId"));
  router.patch("/tutor/applicants/:id/accept", tutor, update("accepted"));
  router.patch("/tutor/applicants/:id/reject", tutor, update("rejected"));
  router.use(tuitionError);

  return router;
}
