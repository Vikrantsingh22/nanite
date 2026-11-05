import { createDb } from "../client.js";
import { runMigrations } from "../migrate.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const { db, close } = createDb(url, { max: 1 });
try {
  await runMigrations(db);
  console.log("migrations applied");
} finally {
  await close();
}
