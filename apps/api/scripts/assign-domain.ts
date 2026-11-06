/*
 * DEV ONLY: assign an existing mail domain to an existing user in the LOCAL database (T3.6), e.g. the demo user
 * `nanitedemo` -> the platform domain, so the user can create agents without going through the wizard.
 *
 *   docker compose run --rm tools npx tsx apps/api/scripts/assign-domain.ts --user=nanitedemo --domain=nanitecom.itsvikrant.tech
 *
 * Never creates anything in Resend. With RESEND_API_KEY set it does read-only GETs (list + get) and marks the row
 * `verified` only if Resend reports the domain as verified; without a key the row is stored as `not_started` with no
 * records. Existing rows of the user are left alone (delete via the API or SQL first). Prints ids and statuses only.
 */
import { createDb, getUserDomain, insertUserDomain, users } from "@nanite/db";
import { eq } from "drizzle-orm";
import { normalizeDomain } from "../src/domains/hostname.js";
import { createResendDomains } from "../src/domains/resend-domains.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  const username = arg("user")?.toLowerCase();
  const n = normalizeDomain(arg("domain"));
  if (!username || !n.ok) throw new Error("usage: assign-domain.ts --user=<username> --domain=<name>");
  if (process.env.NODE_ENV === "production") throw new Error("dev only: refusing to run with NODE_ENV=production");
  const url = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
  const handle = createDb(url, { max: 1 });
  try {
    const [user] = await handle.db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!user) throw new Error(`no user named ${username} in this database`);
    if (await getUserDomain(handle.db, user.id)) throw new Error(`${username} already has a mail domain`);

    let row = { resendDomainId: `local:${n.name}`, region: "ap-northeast-1", status: "not_started", records: [] as unknown[] };
    const key = process.env.RESEND_API_KEY?.trim();
    if (key) {
      const resend = createResendDomains({ apiKey: key });
      const found = (await resend.listDomains()).find((d) => d.name === n.name);
      if (found) {
        const d = await resend.getDomain(found.id);
        row = { resendDomainId: d.id, region: d.region || row.region, status: d.status, records: d.records };
      } else console.log("domain not found in Resend (read-only lookup): stored as not_started");
    } else console.log("RESEND_API_KEY not set: stored as not_started, nothing was read from Resend");

    const inserted = await insertUserDomain(handle.db, { userId: user.id, name: n.name, ...row });
    if (!inserted) throw new Error("could not insert (the domain name is used by another user)");
    console.log(`assigned ${n.name} to ${username}: status ${inserted.status}`);
  } finally {
    await handle.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "failed");
  process.exit(1);
});
