import { json, Router, type RequestHandler } from "express";
import type { Db, ObjectId } from "mongodb";
import { z } from "zod";
import { isHostedImage, readImage, uploadImage } from "./tuition-images.js";
import { tuitionError } from "./tuitions.js";

const phone = z.string().trim().max(24).refine((value) => {
  return value === "" || /^\+?\d{7,15}$/.test(value.replace(/[\s().-]/g, ""));
});
const changes = z.strictObject({
  name: z.string().trim().min(2).max(80).optional(),
  phone: phone.optional(),
  bio: z.string().trim().max(500).optional(),
  location: z.string().trim().max(120).optional(),
  image: z.string().max(2048).refine(isHostedImage).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0);

type User = z.infer<typeof changes> & {
  _id: ObjectId;
  email: string;
  emailVerified?: boolean;
  role?: string;
  plan?: string;
  createdAt?: Date;
  updatedAt?: Date;
};
const fields = {
  name: 1, phone: 1, bio: 1, location: 1, image: 1, email: 1, emailVerified: 1,
  role: 1, plan: 1, createdAt: 1, updatedAt: 1,
} as const;

function profile(user: User) {
  return {
    id: user._id.toHexString(),
    name: user.name ?? "",
    phone: user.phone ?? "",
    bio: user.bio ?? "",
    location: user.location ?? "",
    image: user.image ?? null,
    email: user.email,
    emailVerified: user.emailVerified === true,
    role: user.role,
    plan: user.plan ?? "free",
    createdAt: user.createdAt ?? null,
    updatedAt: user.updatedAt ?? null,
  };
}

export function profileRoutes(db: Db, verifyToken: RequestHandler) {
  const router = Router();
  // Better Auth's MongoDB adapter uses this collection and the canonical name and image fields.
  const users = db.collection<User>("user");

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  }, verifyToken);

  router.get("/", async (_req, res) => {
    const user = await users.findOne({ _id: res.locals.authUserId }, { projection: fields });
    if (!user) res.status(404).json({ error: "Profile not found." });
    else res.json(profile(user));
  });

  router.post("/avatar", readImage, uploadImage);
  router.patch("/", json({ limit: "8kb" }), async (req, res) => {
    const input = changes.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Check your profile details.", issues: input.error.flatten().fieldErrors });
      return;
    }
    const user = await users.findOneAndUpdate(
      { _id: res.locals.authUserId },
      { $set: input.data, $currentDate: { updatedAt: true } },
      { projection: fields, returnDocument: "after" },
    );
    if (!user) res.status(404).json({ error: "Profile not found." });
    else res.json(profile(user));
  });

  router.use(tuitionError);
  return router;
}
