import { json, Router, type RequestHandler } from "express";
import { ObjectId, type Db, type Filter } from "mongodb";
import { z } from "zod";
import { verifyAdmin } from "../middleware/authorization.js";
import { listQueryFields, literalSearch } from "./admin-query.js";
import { idSchema, tuitionError } from "./tuitions.js";

const roles = z.enum(["student", "tutor", "admin"]);
const filters = z.strictObject({
  ...listQueryFields, role: roles.optional(), access: z.enum(["active", "disabled"]).optional(),
});
const changes = z.union([z.strictObject({ role: roles }), z.strictObject({ disabled: z.boolean() })]);
type User = {
  _id: ObjectId; name: string; email: string; plan?: string;
  role: z.infer<typeof roles>; disabled?: boolean; createdAt?: Date; updatedAt?: Date;
};
const fields = { name: 1, email: 1, plan: 1, role: 1, disabled: 1, createdAt: 1 };
const guardId = "admin-users";

export async function ensureAdminGuard(db: Db) {
  await db.collection<{ _id: string }>("admin_guards").updateOne({ _id: guardId }, { $setOnInsert: { _id: guardId } }, { upsert: true });
}

export function adminUserRoutes(db: Db, verifyToken: RequestHandler) {
  const router = Router();
  const users = db.collection<User>("user");
  const sessions = db.collection<{ userId: ObjectId | string }>("session");
  const guards = db.collection<{ _id: string; version?: ObjectId }>("admin_guards");
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  }, verifyToken, verifyAdmin);

  router.get("/", async (req, res) => {
    const input = filters.safeParse(req.query);
    if (!input.success) {
      res.status(400).json({ error: "Invalid user filters or pagination." });
      return;
    }
    const { page, limit, search, role, access } = input.data;
    const filter: Filter<User> = {};
    if (role) filter.role = role;
    if (access) filter.disabled = access === "disabled" ? true : { $ne: true };
    if (search) {
      const pattern = literalSearch(search);
      filter.$or = [{ name: pattern }, { email: pattern }];
      if (idSchema.safeParse(search).success) filter.$or.push({ _id: new ObjectId(search) });
    }
    const [items, total] = await Promise.all([
      users.find(filter, { projection: fields }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      users.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  });

  const update: RequestHandler = async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const input = changes.safeParse(req.body);
    if (!id.success || !input.success) {
      res.status(400).json({ error: "Invalid user ID or account change." });
      return;
    }
    const actorId: ObjectId = res.locals.authUserId;
    const targetId = new ObjectId(id.data);
    const change = input.data;
    const result = await db.client.withSession((session) => session.withTransaction(async () => {
      // All role and access changes write the same document before checking admin membership.
      const locked = await guards.updateOne({ _id: guardId }, { $set: { version: new ObjectId() } }, { session });
      if (!locked.matchedCount) throw new Error("Admin guard is unavailable");
      const actor = await users.findOne({ _id: actorId, role: "admin", disabled: { $ne: true } }, { session, projection: { _id: 1 } });
      if (!actor) return { code: 403, error: "Forbidden." };
      const target = await users.findOne({ _id: targetId }, { session, projection: fields });
      if (!target) return { code: 404, error: "User not found." };

      const removesAdmin = ("role" in change && change.role !== "admin") || ("disabled" in change && change.disabled);
      if (target.role === "admin" && target.disabled !== true && removesAdmin) {
        if (await users.countDocuments({ role: "admin", disabled: { $ne: true } }, { session, limit: 2 }) <= 1) {
          return { code: 409, error: "Keep at least one active admin." };
        }
        if (actorId.equals(targetId)) return { code: 409, error: "You cannot demote or disable your own account." };
      }

      const item = await users.findOneAndUpdate(
        { _id: targetId }, { $set: change, $currentDate: { updatedAt: true } },
        { session, projection: fields, returnDocument: "after" },
      );
      if ("disabled" in change && change.disabled) {
        await sessions.deleteMany({ userId: { $in: [targetId, targetId.toHexString()] } }, { session });
      }
      return { code: 200, item };
    }));
    res.status(result.code).json(result.code === 200 ? result.item : { error: result.error });
  };

  router.patch("/:id", json({ limit: "2kb" }), update);
  router.use(tuitionError);
  return router;
}
