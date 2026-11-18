import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, it } from "node:test";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { MongoClient, MongoServerError, ObjectId } from "mongodb";
import { jwtAlgorithm } from "../dist/config/jwt.js";
import { createVerifyToken } from "../dist/middleware/authorization.js";
import { applicationRoutes, ensureApplicationIndexes } from "../dist/routes/applications.js";
import { adminTuitionRoutes } from "../dist/routes/admin-tuitions.js";
import { publicTuitionRoutes } from "../dist/routes/public-tuitions.js";
import { ensureTuitionIndexes, tuitionRoutes } from "../dist/routes/tuitions.js";

const issuer = "http://localhost:5000";
const accounts = {
  tutor: { _id: new ObjectId(), name: "Nadia Rahman", role: "tutor", plan: "free" },
  other: { _id: new ObjectId(), role: "tutor", plan: "free" },
  student: { _id: new ObjectId(), name: "Fixture Student", role: "student", plan: "free" },
  otherStudent: { _id: new ObjectId(), role: "student", plan: "free" },
  admin: { _id: new ObjectId(), role: "admin", plan: "free" },
};
const post = {
  title: "Class 9 Mathematics",
  subject: "Mathematics",
  location: "Dhaka",
  format: "Home tuition",
  daysPerWeek: 3,
  monthlyFee: 6000,
  description: "Weekly classes and exam preparation.",
  imageUrl: null,
};
const tokens = {};
const uri = process.env.TUITION_TEST_MONGODB_URI;
const client = uri ? new MongoClient(uri) : null;
const db = client ? client.db("mentorlagbe_tuition_test_" + new ObjectId()) : memoryDatabase();
let server;
let base;

before(async () => {
  if (client) {
    await client.connect();
    await ensureTuitionIndexes(db);
    await ensureApplicationIndexes(db);
    await db.collection("user").insertMany(Object.values(accounts));
  }
  const { publicKey, privateKey } = await generateKeyPair(jwtAlgorithm);
  const jwks = { keys: [await exportJWK(publicKey)] };
  for (const [name, user] of Object.entries(accounts)) {
    tokens[name] = await new SignJWT({ role: "admin" }).setProtectedHeader({ alg: jwtAlgorithm })
      .setIssuer(issuer).setAudience(issuer).setSubject(user._id.toString()).setExpirationTime("5m").sign(privateKey);
  }
  const app = express();
  const verifyToken = createVerifyToken(db, issuer, async () => jwks);
  app.use("/api/tutor/tuitions", tuitionRoutes(db, verifyToken));
  app.use("/api/admin/tuitions", adminTuitionRoutes(db, verifyToken));
  app.use("/api/tuitions", publicTuitionRoutes(db));
  app.use("/api", applicationRoutes(db, verifyToken));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (client) {
    try {
      await db.dropDatabase();
    } finally {
      await client.close();
    }
  }
});

function request(account, method = "GET", path = "", body, area = "tutor") {
  const headers = {};
  if (account) headers.authorization = "Bearer " + tokens[account];
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(base + "/api/" + area + "/tuitions" + path, { method, headers, body: JSON.stringify(body) });
}

it("requires authentication and the current tutor role for CRUD and upload", async () => {
  for (const [method, path] of [
    ["GET", ""], ["POST", ""], ["GET", "/" + new ObjectId()], ["POST", "/image"],
    ["PATCH", "/" + new ObjectId()], ["PATCH", "/" + new ObjectId() + "/active"], ["DELETE", "/" + new ObjectId()],
  ]) {
    assert.equal((await request(null, method, path)).status, 401);
    for (const account of ["student", "admin"]) {
      assert.equal((await request(account, method, path)).status, 403);
    }
  }
  assert.equal((await request("tutor", "POST", "/image")).status, 415);
});

it("rejects invalid IDs, field values, and client-controlled ownership, plan or status", async () => {
  for (const invalid of [
    { monthlyFee: 0 }, { daysPerWeek: "3" }, { title: "  " }, { imageUrl: "https://other.example/image.png" },
    { tutorId: accounts.other._id }, { plan: "pro" }, { approvalStatus: "approved" }, { isActive: false },
  ]) {
    assert.equal((await request("tutor", "POST", "", { ...post, ...invalid })).status, 400);
  }
  assert.equal((await request("tutor", "GET", "/invalid")).status, 400);
});

it("lists, reads, edits, toggles and deletes only the tutor's own posts", async () => {
  const response = await request("tutor", "POST", "", post);
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.tutorId, accounts.tutor._id.toString());
  assert.equal(created.approvalStatus, "pending");
  assert.equal(created.isActive, true);
  const path = "/" + created._id;

  assert.equal((await (await request("tutor")).json()).length, 1);
  assert.deepEqual(await (await request("other")).json(), []);
  assert.equal((await request("other", "GET", path)).status, 404);
  assert.equal((await request("other", "PATCH", path, { title: "Other tutor" })).status, 404);
  assert.equal((await request("other", "PATCH", path + "/active", { isActive: false })).status, 404);
  assert.equal((await request("other", "DELETE", path)).status, 404);

  assert.equal((await request("tutor", "PATCH", path, {})).status, 400);
  assert.equal((await request("tutor", "PATCH", path + "/active", { isActive: "false" })).status, 400);
  await db.collection("tuitions").updateOne({ _id: new ObjectId(created._id) }, { $set: { approvalStatus: "approved" } });

  const unchanged = await (await request("tutor", "PATCH", path, { title: " " + created.title })).json();
  assert.equal(unchanged.approvalStatus, "approved");
  const toggled = await (await request("tutor", "PATCH", path + "/active", { isActive: false })).json();
  assert.equal(toggled.isActive, false);
  assert.equal(toggled.approvalStatus, "approved");

  const edited = await (await request("tutor", "PATCH", path, { title: "$New title" })).json();
  assert.equal(edited.title, "$New title");
  assert.equal(edited.approvalStatus, "pending");
  assert.equal(edited.isActive, false);
  assert.equal((await (await request("tutor", "GET", path)).json()).title, "$New title");
  assert.equal((await request("tutor", "DELETE", path)).status, 204);
  assert.equal((await request("tutor", "GET", path)).status, 404);
});

it("caps concurrent free creates, includes inactive posts, and reads plan changes from the database", async () => {
  const responses = await Promise.all(Array.from({ length: 6 }, () => request("tutor", "POST", "", post)));
  assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 201, 409, 409, 409, 409]);
  const [first] = await (await request("tutor")).json();
  assert.equal((await request("tutor", "PATCH", "/" + first._id + "/active", { isActive: false })).status, 200);
  assert.equal((await request("tutor", "POST", "", post)).status, 409);
  assert.equal((await request("tutor", "DELETE", "/" + first._id)).status, 204);
  assert.equal((await request("tutor", "POST", "", post)).status, 201);
  assert.equal((await request("other", "POST", "", post)).status, 201);

  await db.collection("user").updateOne({ _id: accounts.tutor._id }, { $set: { plan: "pro" } });
  const pro = await Promise.all(Array.from({ length: 4 }, () => request("tutor", "POST", "", post)));
  assert.ok(pro.every(({ status }) => status === 201));
  await db.collection("user").updateOne({ _id: accounts.tutor._id }, { $set: { plan: "free" } });
  assert.equal((await request("tutor", "POST", "", post)).status, 409);
});

function adminRequest(account, method = "GET", path = "", body) {
  return request(account, method, path, body, "admin");
}

it("uses the current database role to authorize admin lists and decisions", async () => {
  const path = "/" + new ObjectId();
  for (const [method, suffix] of [["GET", ""], ["PATCH", path + "/approve"], ["PATCH", path + "/reject"]]) {
    assert.equal((await adminRequest(null, method, suffix)).status, 401);
    for (const role of ["student", "tutor"]) {
      assert.equal((await adminRequest(role, method, suffix)).status, 403);
    }
  }
  await db.collection("user").updateOne({ _id: accounts.admin._id }, { $set: { role: "student" } });
  try {
    assert.equal((await adminRequest("admin")).status, 403);
  } finally {
    await db.collection("user").updateOne({ _id: accounts.admin._id }, { $set: { role: "admin" } });
  }
});

it("validates admin filters and paginates results with tutor names and literal search", async () => {
  for (const query of ["status=draft", "page=0", "page=1.5", "limit=51", "status=pending&status=approved", "role=admin"]) {
    assert.equal((await adminRequest("admin", "GET", "?" + query)).status, 400);
  }
  const first = await adminRequest("admin", "GET", "?status=pending&search=nadia&limit=2");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const { items, total, page, limit } = await first.json();
  assert.ok(total > 2);
  assert.equal(page, 1);
  assert.equal(limit, 2);
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.tutorName === "Nadia Rahman" && item.approvalStatus === "pending"));
  assert.ok(items.every((item) => !Object.hasOwn(item, "tutorId") && !Object.hasOwn(item, "email")));
  const second = await (await adminRequest("admin", "GET", "?status=pending&search=nadia&limit=2&page=2")).json();
  assert.equal(second.total, total);
  assert.ok(second.items.length > 0);
  assert.ok(second.items.every((item) => items.every(({ _id }) => _id !== item._id)));
  assert.equal((await (await adminRequest("admin", "GET", "?search=Mathematics")).json()).total > 0, true);
  assert.deepEqual((await (await adminRequest("admin", "GET", "?search=.*")).json()).items, []);
});

it("persists approve and reject decisions, rejects stale and invalid transitions, and preserves tutor behavior", async () => {
  const fixtures = ["Approve fixture", "Reject fixture", "Race fixture"].map((title) => ({
    ...post, title, tutorId: accounts.tutor._id, approvalStatus: "pending", isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }));
  const [approve, reject, race] = await Promise.all(fixtures.map(async (fixture) =>
    "/" + (await db.collection("tuitions").insertOne(fixture)).insertedId,
  ));

  assert.equal((await adminRequest("admin", "PATCH", "/invalid/approve")).status, 400);
  assert.equal((await adminRequest("admin", "PATCH", "/" + new ObjectId() + "/reject")).status, 404);
  assert.equal((await adminRequest("admin", "PATCH", approve + "/approve", { role: "admin" })).status, 400);
  assert.equal((await adminRequest("admin", "PATCH", approve + "/approve", { expectedUpdatedAt: "invalid" })).status, 400);
  assert.equal((await adminRequest("admin", "PATCH", approve + "/approve", { expectedUpdatedAt: "2025-01-01T00:00:00Z" })).status, 409);
  const approved = await adminRequest("admin", "PATCH", approve + "/approve", { expectedUpdatedAt: fixtures[0].updatedAt });
  assert.equal(approved.status, 200);
  const approvedPost = await approved.json();
  assert.equal(approvedPost.approvalStatus, "approved");
  assert.ok(new Date(approvedPost.updatedAt) > fixtures[0].updatedAt);
  assert.equal((await adminRequest("admin", "PATCH", reject + "/reject")).status, 200);
  assert.equal((await adminRequest("admin", "PATCH", approve + "/approve")).status, 409);
  assert.equal((await adminRequest("admin", "PATCH", approve + "/reject")).status, 409);
  assert.equal((await adminRequest("admin", "PATCH", reject + "/approve")).status, 409);
  assert.equal((await adminRequest("admin", "PATCH", reject + "/reject")).status, 409);

  const decisions = await Promise.all(["approve", "reject"].map((action) => adminRequest("admin", "PATCH", race + "/" + action)));
  assert.deepEqual(decisions.map(({ status }) => status).sort(), [200, 409]);
  const winner = await decisions.find(({ status }) => status === 200).json();
  assert.equal((await (await request("tutor", "GET", race)).json()).approvalStatus, winner.approvalStatus);
  assert.equal((await (await request("tutor", "GET", approve)).json()).approvalStatus, "approved");
  assert.equal((await (await request("tutor", "GET", reject)).json()).approvalStatus, "rejected");

  assert.equal((await (await adminRequest("admin", "GET", "?status=approved&search=Approve+fixture")).json()).total, 1);
  assert.equal((await (await adminRequest("admin", "GET", "?status=pending&search=Approve+fixture")).json()).total, 0);
  const edited = await request("tutor", "PATCH", reject, { title: "Resubmitted fixture" });
  assert.equal((await edited.json()).approvalStatus, "pending");
  assert.equal((await adminRequest("admin", "PATCH", reject + "/approve", { expectedUpdatedAt: fixtures[1].updatedAt })).status, 409);
  assert.equal((await adminRequest("admin", "PATCH", reject + "/approve")).status, 200);
});

function publicRequest(suffix = "", account, method = "GET") {
  return fetch(base + "/api/tuitions" + suffix, {
    method,
    headers: account ? { authorization: "Bearer " + tokens[account] } : {},
  });
}

it("publishes only approved and active tuitions and exposes only public detail fields", async () => {
  const fixtures = [
    { approvalStatus: "approved", isActive: true, title: "Public calculus" },
    { approvalStatus: "approved", isActive: true, title: "Public + chemistry", format: "Online", classLevel: "HSC" },
    { approvalStatus: "approved", isActive: true, title: "Public geometry" },
    { approvalStatus: "approved", isActive: false, title: "Hidden inactive" },
    { approvalStatus: "pending", isActive: true, title: "Hidden pending" },
    { approvalStatus: "rejected", isActive: true, title: "Hidden rejected" },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    fixture._id = new ObjectId();
    await db.collection("tuitions").insertOne({
      ...post,
      tutorId: accounts.tutor._id,
      subject: "Public science",
      location: "Unique area",
      createdAt: new Date(index === 0 ? "2099-01-01" : "2099-01-02"),
      updatedAt: new Date("2099-01-02"),
      ...fixture,
    });
  }

  const ids = [fixtures[2], fixtures[1], fixtures[0]].map(({ _id }) => _id.toString());
  const response = await publicRequest("?subject=public+science&limit=2");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { items, total, page, limit } = await response.json();
  assert.equal(total, 3);
  assert.equal(page, 1);
  assert.equal(limit, 2);
  assert.deepEqual(items.map(({ _id }) => _id), ids.slice(0, 2));
  assert.ok(items.every((item) => !Object.hasOwn(item, "tutorId") && !Object.hasOwn(item, "description")));

  const next = await (await publicRequest("?subject=public+science&page=2&limit=2")).json();
  assert.deepEqual(next.items.map(({ _id }) => _id), ids.slice(2));
  assert.equal(next.total, 3);
  const beyond = await (await publicRequest("?subject=public+science&page=3&limit=2")).json();
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.total, 3);
  const featured = await (await publicRequest("?limit=6")).json();
  assert.deepEqual(featured.items.slice(0, 3).map(({ _id }) => _id), ids);
  assert.ok(featured.items.length <= 6);

  for (const [query, expected] of [
    ["search=CHEMISTRY", [ids[1]]],
    ["search=Public+SCIENCE", ids],
    ["search=%2B", [ids[1]]],
    ["search=.%2A", []],
    ["search=Unique+area", []],
    ["subject=public", []],
    ["subject=.%2A", []],
    ["classLevel=hsc&mode=online&subject=Public+science", [ids[1]]],
    ["classLevel=hs", []],
    ["classLevel=.%2A", []],
    ["mode=home&subject=Public+science", [ids[0], ids[2]]],
    ["classLevel=hsc&mode=home&subject=Public+science", []],
  ]) {
    const result = await publicRequest("?" + query);
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).items.map(({ _id }) => _id), expected, query);
  }

  const detailsResponse = await publicRequest("/" + ids[1]);
  assert.equal(detailsResponse.status, 200);
  const details = await detailsResponse.json();
  assert.equal(details.tutorName, "Nadia Rahman");
  assert.equal(details.description, post.description);
  assert.equal(details.classLevel, "HSC");
  for (const field of ["tutorId", "email", "role", "plan", "approvalStatus", "isActive", "updatedAt"]) {
    assert.equal(Object.hasOwn(details, field), false, field);
  }

  for (const fixture of fixtures.slice(3)) {
    for (const account of [undefined, "tutor", "student", "admin"]) {
      assert.equal((await publicRequest("/" + fixture._id, account)).status, 404);
    }
  }
  assert.equal((await publicRequest("/" + new ObjectId())).status, 404);
  assert.equal((await publicRequest("/bad-id")).status, 400);
  assert.equal((await publicRequest("/" + ids[1], "admin", "PATCH")).status, 404);
  assert.equal((await request("tutor", "GET", "/" + fixtures[4]._id)).status, 200);
  assert.equal((await adminRequest("admin", "GET", "?search=Hidden+pending")).status, 200);

  assert.equal((await request("tutor", "PATCH", "/" + ids[1] + "/active", { isActive: false })).status, 200);
  assert.equal((await publicRequest("/" + ids[1])).status, 404);
  assert.equal((await request("tutor", "PATCH", "/" + ids[2], { classLevel: "Class 9" })).status, 200);
  assert.equal((await publicRequest("/" + ids[2])).status, 404);
  assert.equal((await adminRequest("admin", "PATCH", "/" + ids[2] + "/approve")).status, 200);
  const resubmitted = await (await publicRequest("?subject=public+science&classLevel=class+9")).json();
  assert.deepEqual(resubmitted.items.map(({ _id }) => _id), [ids[2]]);
});

it("rejects invalid public query values and attempts to override visibility", async () => {
  for (const query of [
    "page=0", "page=1000001", "limit=51", "limit=0", "limit=1&limit=2", "mode=unsupported",
    "search=" + "a".repeat(101), "classLevel=" + "a".repeat(81), "subject=A&subject=B",
    "approvalStatus=pending", "isActive=false", "subject%5B%24ne%5D=English",
  ]) {
    assert.equal((await publicRequest("?" + query)).status, 400, query);
  }
});

function applicationRequest(account, path, method = "GET", body) {
  return fetch(base + "/api" + path, {
    method,
    headers: {
      ...(account ? { authorization: "Bearer " + tokens[account] } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: JSON.stringify(body),
  });
}

const studentPath = "/student/my-applications";
const tutorPath = "/tutor/applicants";
const applicationInput = {
  phone: "+880 1700-000000",
  preferredSchedule: "Sunday and Tuesday evenings",
  studentNote: "Please let me know about availability.",
};

async function applicationTuition(overrides) {
  const now = new Date();
  const { insertedId } = await db.collection("tuitions").insertOne({
    ...post, tutorId: accounts.tutor._id, approvalStatus: "approved", isActive: true,
    createdAt: now, updatedAt: now, ...overrides,
  });
  return insertedId;
}

it("uses database roles on all application endpoints and validates the submission", async () => {
  const tuitionId = await applicationTuition();
  const create = "/tuitions/" + tuitionId + "/applications";
  const id = new ObjectId();
  for (const [path, method, wrongRole] of [
    [create, "POST", "tutor"], [studentPath, "GET", "tutor"], [studentPath + "/" + id, "DELETE", "tutor"],
    [tutorPath, "GET", "student"], [tutorPath + "/" + id + "/accept", "PATCH", "student"],
    [tutorPath + "/" + id + "/reject", "PATCH", "student"],
  ]) {
    assert.equal((await applicationRequest(null, path, method)).status, 401);
    assert.equal((await applicationRequest(wrongRole, path, method)).status, 403);
    assert.equal((await applicationRequest("admin", path, method)).status, 403);
  }
  for (const overrides of [
    { phone: "123abc" }, { phone: "123" }, { preferredSchedule: "  " }, { studentNote: "x".repeat(1001) },
    { studentId: id }, { tutorId: id }, { tuition: { title: "Forged" } }, { status: "accepted" },
  ]) {
    assert.equal((await applicationRequest("student", create, "POST", { ...applicationInput, ...overrides })).status, 400);
  }
  assert.equal((await applicationRequest("student", "/tuitions/invalid/applications", "POST", applicationInput)).status, 400);
  assert.equal((await applicationRequest("student", studentPath + "/invalid", "DELETE")).status, 400);
  assert.equal((await applicationRequest("tutor", tutorPath + "/invalid/accept", "PATCH")).status, 400);
  assert.equal((await applicationRequest("student", "/tuitions/" + id + "/applications", "POST", applicationInput)).status, 404);

  for (const overrides of [{ isActive: false }, { approvalStatus: "pending" }, { approvalStatus: "rejected" }]) {
    const hidden = await applicationTuition(overrides);
    assert.equal((await applicationRequest("student", "/tuitions/" + hidden + "/applications", "POST", applicationInput)).status, 404);
  }
});

it("stores server-derived application details and rejects concurrent duplicates", async () => {
  const tuitionId = await applicationTuition({ title: "Application snapshot" });
  const path = "/tuitions/" + tuitionId + "/applications";
  const responses = await Promise.all(Array.from({ length: 4 }, () => applicationRequest("student", path, "POST", applicationInput)));
  assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 409, 409, 409]);
  const created = await responses.find(({ status }) => status === 201).json();
  assert.equal(created.status, "pending");
  assert.equal(created.studentName, "Fixture Student");
  assert.equal(created.tutorName, "Nadia Rahman");
  assert.equal(created.tuition.title, "Application snapshot");
  assert.equal(created.tuition.monthlyFee, post.monthlyFee);

  assert.equal((await applicationRequest("otherStudent", path, "POST", applicationInput)).status, 201);
  const privateStudent = await applicationRequest("student", studentPath);
  assert.equal(privateStudent.headers.get("cache-control"), "no-store");
  const own = (await privateStudent.json()).filter((item) => item.tuitionId === tuitionId.toString());
  assert.deepEqual(own.map(({ _id }) => _id), [created._id]);
  assert.equal(own[0].phone, applicationInput.phone);
  assert.equal(Object.hasOwn(own[0], "studentId"), false);
  assert.equal(Object.hasOwn(own[0], "tutorId"), false);
  assert.deepEqual(await (await applicationRequest("other", tutorPath)).json(), []);

  const protectedPost = await (await request("tutor", "GET", "/" + tuitionId)).json();
  assert.equal(Object.hasOwn(protectedPost, "applicationWriteVersion"), false);
  assert.equal((await request("tutor", "PATCH", "/" + tuitionId, { title: "New tuition title" })).status, 200);
  const received = (await (await applicationRequest("tutor", tutorPath)).json()).find(({ _id }) => _id === created._id);
  assert.equal(received.tuition.title, "Application snapshot");
});

it("allows only owners to cancel or decide pending applications and preserves final decisions", async () => {
  const tuitionId = await applicationTuition();
  const create = "/tuitions/" + tuitionId + "/applications";
  async function apply(account) {
    const response = await applicationRequest(account, create, "POST", applicationInput);
    assert.equal(response.status, 201);
    return (await response.json())._id;
  }
  const first = await apply("student");
  assert.equal((await applicationRequest("otherStudent", studentPath + "/" + first, "DELETE")).status, 404);
  assert.equal((await applicationRequest("other", tutorPath + "/" + first + "/accept", "PATCH")).status, 404);
  assert.equal((await applicationRequest("other", tutorPath + "/" + first + "/reject", "PATCH")).status, 404);
  assert.equal((await applicationRequest("student", studentPath + "/" + first, "DELETE")).status, 204);
  assert.equal((await applicationRequest("student", studentPath + "/" + first, "DELETE")).status, 404);
  assert.equal((await applicationRequest("tutor", tutorPath + "/" + first + "/accept", "PATCH")).status, 404);

  const acceptedId = await apply("student");
  const rejectedId = await apply("otherStudent");
  const accepted = await applicationRequest("tutor", tutorPath + "/" + acceptedId + "/accept", "PATCH");
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).status, "accepted");
  const rejected = await applicationRequest("tutor", tutorPath + "/" + rejectedId + "/reject", "PATCH");
  assert.equal(rejected.status, 200);
  assert.equal((await rejected.json()).status, "rejected");

  for (const [id, student, status] of [[acceptedId, "student", "accepted"], [rejectedId, "otherStudent", "rejected"]]) {
    assert.equal((await applicationRequest(student, studentPath + "/" + id, "DELETE")).status, 409);
    for (const action of ["accept", "reject"]) {
      assert.equal((await applicationRequest("tutor", tutorPath + "/" + id + "/" + action, "PATCH")).status, 409);
    }
    const list = await (await applicationRequest(student, studentPath)).json();
    assert.equal(list.find(({ _id }) => _id === id).status, status);
  }

  const raceTuition = await applicationTuition();
  const raceCreate = await applicationRequest("student", "/tuitions/" + raceTuition + "/applications", "POST", applicationInput);
  const { _id: raceId } = await raceCreate.json();
  const [cancel, accept] = await Promise.all([
    applicationRequest("student", studentPath + "/" + raceId, "DELETE"),
    applicationRequest("tutor", tutorPath + "/" + raceId + "/accept", "PATCH"),
  ]);
  assert.ok((cancel.status === 204 && accept.status === 404) || (cancel.status === 409 && accept.status === 200));
});

// Model the moderation query against fixtures when no MongoDB URI is configured.
function reviewPage(posts, users, pipeline) {
  const status = pipeline[0].$match?.approvalStatus;
  const search = pipeline.find((step) => step.$match?.$or)?.$match.$or[0].title;
  const pattern = search && new RegExp(search.$regex, search.$options);
  const [skip, limit, ...pageStages] = pipeline.at(-1).$facet.items;
  const projection = pageStages.at(-1).$project;
  const tutorName = (post) => users.find(({ _id }) => _id.equals(post.tutorId))?.name ?? null;
  const matching = posts.filter((post) =>
    (!status || post.approvalStatus === status) &&
    (!pattern || [post.title, post.subject, tutorName(post) ?? ""].some((value) => pattern.test(value))),
  ).sort((a, b) => b.createdAt - a.createdAt || String(b._id).localeCompare(String(a._id)));
  const items = matching.slice(skip.$skip, skip.$skip + limit.$limit).map((post) => ({
    ...Object.fromEntries(Object.keys(projection).filter((key) => key !== "tutorName").map((key) => [key, post[key]])),
    _id: post._id, tutorName: tutorName(post),
  }));
  return { items, count: matching.length ? [{ total: matching.length }] : [] };
}

// Default runs verify HTTP behavior with a store double. Set the test URI to exercise MongoDB transactions and pipelines.
function memoryDatabase() {
  const collections = { user: Object.values(accounts).map((user) => ({ ...user })), tuitions: [], applications: [] };
  let previous = Promise.resolve();
  const matches = (item, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((branch) => matches(item, branch));
    if (value instanceof Date) return item[key]?.getTime() === value.getTime();
    if (value instanceof RegExp) return typeof item[key] === "string" && value.test(item[key]);
    return String(item[key]) === String(value);
  });
  const project = (item, projection) => {
    if (!item || !projection) return item ?? null;
    const includes = Object.values(projection).some(Boolean);
    return Object.fromEntries(Object.entries(item).filter(([key]) => key === "_id" || (includes ? projection[key] : projection[key] !== 0)));
  };
  return {
    client: {
      withSession: (run) => run({
        withTransaction(callback) {
          const transaction = previous.then(callback);
          previous = transaction.catch(() => {});
          return transaction;
        },
      }),
    },
    collection(name) {
      const items = collections[name];
      const find = (filter) => items.find((item) => matches(item, filter));
      return {
        findOne: async (filter, options) => project(find(filter), options?.projection),
        find: (filter, options) => {
          let offset = 0;
          let length;
          const cursor = {
            sort: () => cursor,
            skip(value) { offset = value; return cursor; },
            limit(value) { length = value; return cursor; },
            async toArray() {
              return items.filter((item) => matches(item, filter))
                .sort((a, b) => b.createdAt - a.createdAt || String(b._id).localeCompare(String(a._id)))
                .slice(offset, length === undefined ? undefined : offset + length)
                .map((item) => project(item, options?.projection));
            },
          };
          return cursor;
        },
        aggregate: (pipeline) => ({ next: async () => reviewPage(items, collections.user, pipeline) }),
        countDocuments: async (filter) => items.filter((item) => matches(item, filter)).length,
        insertOne: async (data) => {
          if (name === "applications" && find({ tuitionId: data.tuitionId, studentId: data.studentId })) {
            throw new MongoServerError({ code: 11000, message: "Duplicate application" });
          }
          const insertedId = data._id ?? new ObjectId();
          items.push({ ...data, _id: insertedId });
          return { insertedId };
        },
        updateOne: async (filter, update) => Object.assign(find(filter), update.$set),
        findOneAndUpdate: async (filter, update, options) => {
          const item = find(filter);
          if (!item) return null;
          const before = { ...item };
          const result = () => project(options?.returnDocument === "after" ? item : before, options?.projection);
          if (!Array.isArray(update)) {
            Object.assign(item, update.$set);
            if (update.$currentDate?.updatedAt) item.updatedAt = new Date();
            return result();
          }
          const evaluate = (expression) => {
            if (expression === "$$NOW") return new Date();
            if (typeof expression === "string" && expression.startsWith("$")) return item[expression.slice(1)];
            if (typeof expression !== "object" || expression === null) return expression;
            if ("$literal" in expression) return expression.$literal;
            if ("$ifNull" in expression) return evaluate(expression.$ifNull[0]) ?? evaluate(expression.$ifNull[1]);
            if ("$ne" in expression) return evaluate(expression.$ne[0]) !== evaluate(expression.$ne[1]);
            if ("$or" in expression) return expression.$or.some(evaluate);
            if ("$cond" in expression) return evaluate(expression.$cond[evaluate(expression.$cond[0]) ? 1 : 2]);
            throw new Error("Unsupported test expression");
          };
          const entries = Object.entries(update[0].$set).map(([key, expression]) => [key, evaluate(expression)]);
          Object.assign(item, Object.fromEntries(entries));
          return result();
        },
        deleteOne: async (filter) => {
          const index = items.findIndex((item) => matches(item, filter));
          if (index === -1) return { deletedCount: 0 };
          items.splice(index, 1);
          return { deletedCount: 1 };
        },
      };
    },
  };
}
