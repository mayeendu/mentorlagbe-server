import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { MongoClient, ObjectId } from "mongodb";

const fixture = [
  ["ssc-maths", "SSC Mathematics Exam Practice", "Mathematics", "Class 10", "Home tuition", "Dhanmondi, Dhaka", 3, 6500, "Practice algebra, geometry and past SSC questions. Each week includes a timed exercise and a review of mistakes."],
  ["junior-algebra", "Fractions and Introductory Algebra", "Mathematics", "Class 7", "Online", "Anywhere in Bangladesh", 2, 4200, "Build confidence with fractions, ratios and algebra through guided problem solving and short practice assignments."],
  ["english-writing", "English Reading and Paragraph Writing", "English", "Class 8", "Home tuition", "Mohammadpur, Dhaka", 2, 4800, "Read short passages and practise paragraph writing with structured feedback and a weekly vocabulary exercise."],
  ["o-level-english", "O Level English Paper Practice", "English", "O Level", "Online", "Anywhere in Bangladesh", 2, 8500, "Work through comprehension and directed-writing papers with individual feedback on structure, clarity and timing."],
  ["general-science", "General Science Revision", "Science", "Class 6", "Home tuition", "Uttara, Dhaka", 2, 4000, "Review school science topics through everyday examples, short quizzes and a revision plan for the upcoming exam."],
  ["hsc-physics", "HSC Physics Problem Solving", "Physics", "HSC", "Online", "Anywhere in Bangladesh", 2, 7500, "Work through mechanics and electricity questions with written solutions and feedback on exam technique."],
  ["hsc-chemistry", "HSC Chemistry Revision", "Chemistry", "HSC", "Home tuition", "Bashundhara, Dhaka", 3, 7800, "Review chemical bonding and organic chemistry with worked examples, reaction maps and topic quizzes."],
  ["ict-foundations", "ICT Fundamentals and Spreadsheets", "ICT", "Class 9", "Online", "Anywhere in Bangladesh", 2, 5000, "Learn formulas, spreadsheet organisation and core ICT concepts through weekly hands-on exercises."],
  ["bangla-grammar", "Bangla Grammar and Composition", "Bangla", "Class 8", "Home tuition", "Mirpur, Dhaka", 3, 4800, "Review grammar and composition with structured feedback on short answers and extended writing."],
  ["bangla-reading", "Bangla Reading and Creative Writing", "Bangla", "Class 5", "Home tuition", "Panchlaish, Chattogram", 2, 3500, "Read short stories and practise age-appropriate creative writing through guided prompts and discussion."],
  ["accounting", "HSC Accounting Foundations", "Accounting", "HSC", "Online", "Anywhere in Bangladesh", 2, 6200, "Learn journal entries, ledgers and trial balances by working through sample transactions and exam problems."],
  ["business", "Business Studies Case Practice", "Business Studies", "Class 10", "Home tuition", "Kazla, Rajshahi", 2, 5200, "Review entrepreneurship, basic accounting and business organisation with short cases and structured revision."],
];

export const demoTuitions = fixture.map(([slug, title, subject, classLevel, format, location, daysPerWeek, monthlyFee, description]) => ({
  seedKey: "mentorlagbe-demo-v1:" + slug,
  title, subject, classLevel, format, location, daysPerWeek, monthlyFee, description,
  imageUrl: null, approvalStatus: "approved", isActive: true,
}));

export function seedConfig(env) {
  if (env.NODE_ENV === "production") throw new Error("Demo seeding is disabled in production.");
  if (env.PAYMENT_MODE !== "mock") throw new Error("Set PAYMENT_MODE=mock for the isolated demo database.");
  const uri = env.SEED_MONGODB_URI;
  const allowed = /^mongodb:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/\?replicaSet=[A-Za-z0-9_-]+$/;
  const match = allowed.exec(uri ?? "");
  if (!match || Number(match[1]) > 65535) {
    throw new Error("Use an explicit loopback SEED_MONGODB_URI with a replicaSet option.");
  }
  const email = env.SEED_TUTOR_EMAIL?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Set SEED_TUTOR_EMAIL to a local demo tutor.");
  return { uri, email };
}

export async function seedDemoTuitions(users, posts, email, session) {
  const tutor = await users.findOne({ email, role: "tutor", plan: "pro", disabled: { $ne: true } }, { session, projection: { _id: 1 } });
  if (!tutor) throw new Error("Create an active Pro tutor in the mock database before seeding.");
  let inserted = 0;
  const now = Date.now();
  for (const [index, tuition] of demoTuitions.entries()) {
    const id = new ObjectId(createHash("sha256").update(tuition.seedKey).digest("hex").slice(0, 24));
    const timestamp = new Date(now - index * 1000);
    // Include the fixture marker and owner in the match. An unrelated ID collision aborts the transaction.
    const result = await posts.updateOne({ _id: id, seedKey: tuition.seedKey, tutorId: tutor._id }, {
      $setOnInsert: { ...tuition, tutorId: tutor._id, createdAt: timestamp, updatedAt: timestamp },
    }, { upsert: true, session });
    inserted += result.upsertedCount;
  }
  return { inserted, preserved: demoTuitions.length - inserted };
}

async function main(args) {
  if (process.env.NODE_ENV === "production") throw new Error("Demo seeding is disabled in production.");
  if (!args.length || (args.length === 1 && args[0] === "--dry-run")) {
    console.table(demoTuitions.map(({ title, classLevel, format, location, monthlyFee }) => ({ title, classLevel, format, location, monthlyFee })));
    console.log("Dry run: " + demoTuitions.length + " approved, active fixtures. No MongoDB connection opened.");
    return;
  }
  if (args.length !== 1 || args[0] !== "--apply") throw new Error("Use --dry-run or --apply.");
  const { uri, email } = seedConfig(process.env);
  const mongo = new MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 3000 });
  try {
    await mongo.connect();
    const db = mongo.db("mentorlagbe_mock");
    const result = await mongo.withSession((session) =>
      session.withTransaction(() => seedDemoTuitions(db.collection("user"), db.collection("tuitions"), email, session)),
    );
    console.log("Inserted " + result.inserted + " fixtures; preserved " + result.preserved + " existing fixtures.");
  } finally {
    await mongo.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    // Only print messages this script generated. Driver errors may contain connection details.
    const message = error instanceof Error && ["Demo seeding", "Set ", "Use ", "Create "].some((prefix) => error.message.startsWith(prefix))
      ? error.message : "Demo seed failed. Check the local replica set or fixture ownership.";
    console.error(message);
    process.exitCode = 1;
  });
}
