import { createDb } from "../client.js";
import { seedDemo } from "../seed.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const { db, close } = createDb(url, { max: 1 });
try {
  const result = await seedDemo(db, { sharedDomain: process.env.SHARED_MAIL_DOMAIN || "nanite.test" });
  console.log("seeded", result);
} finally {
  await close();
}
