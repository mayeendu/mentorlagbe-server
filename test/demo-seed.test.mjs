import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectId } from "mongodb";
import { demoTuitions, seedConfig, seedDemoTuitions } from "../scripts/seed-demo-tuitions.mjs";

const env = { PAYMENT_MODE: "mock", SEED_MONGODB_URI: "mongodb://127.0.0.1:27017/?replicaSet=rs0", SEED_TUTOR_EMAIL: "demo@example.test" };

test("rejects production, remote MongoDB, and non-mock configuration", () => {
  assert.equal(seedConfig(env).email, env.SEED_TUTOR_EMAIL);
  assert.throws(() => seedConfig({ ...env, NODE_ENV: "production" }), /disabled in production/);
  assert.throws(() => seedConfig({ ...env, PAYMENT_MODE: "disabled" }), /mock/);
  assert.throws(() => seedConfig({ ...env, SEED_MONGODB_URI: "mongodb+srv://remote.example.test" }), /loopback/);
  assert.throws(() => seedConfig({ ...env, SEED_MONGODB_URI: env.SEED_MONGODB_URI + "&tls=false" }), /loopback/);
});

test("creates 12 approved active fixtures and preserves edits and unrelated records on a rerun", async () => {
  const tutor = { _id: new ObjectId() };
  const session = {};
  const records = new Map();
  records.set("unrelated", { title: "Existing tuition" });
  const users = { findOne: async (filter, opts) => {
    assert.deepEqual(filter, { email: env.SEED_TUTOR_EMAIL, role: "tutor", plan: "pro", disabled: { $ne: true } });
    assert.equal(opts.session, session);
    return tutor;
  } };
  const posts = { updateOne: async (filter, change, opts) => {
    assert.equal(opts.session, session);
    assert.equal(opts.upsert, true);
    assert.deepEqual(Object.keys(change), ["$setOnInsert"]);
    const key = filter._id.toHexString();
    const current = records.get(key);
    if (current) {
      if (current.seedKey !== filter.seedKey || current.tutorId !== filter.tutorId) throw new Error("Duplicate key");
      return { upsertedCount: 0 };
    }
    records.set(key, change.$setOnInsert);
    return { upsertedCount: 1 };
  } };
  assert.deepEqual(await seedDemoTuitions(users, posts, env.SEED_TUTOR_EMAIL, session), { inserted: 12, preserved: 0 });
  const seeded = [...records.values()].filter(({ seedKey }) => seedKey);
  assert.equal(seeded.length, demoTuitions.length);
  assert.ok(seeded.every(({ approvalStatus, isActive }) => approvalStatus === "approved" && isActive === true));
  seeded[0].title = "Tutor edited the demo title";
  assert.deepEqual(await seedDemoTuitions(users, posts, env.SEED_TUTOR_EMAIL, session), { inserted: 0, preserved: 12 });
  assert.equal(seeded[0].title, "Tutor edited the demo title");
  assert.equal(records.get("unrelated").title, "Existing tuition");
  await assert.rejects(seedDemoTuitions({ findOne: async () => ({ _id: new ObjectId() }) }, posts, env.SEED_TUTOR_EMAIL, session), /Duplicate key/);
  assert.equal(records.size, 13);
});
