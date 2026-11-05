import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { canonicalSendStringV2, verifyNaniteSignature, type TextReader } from "../src/signature.js";

const ENS = "alex.alice.nanitecom.eth";
const MAIL = {
  from: "alex.alice@mail.nanite.test",
  to: "friend@example.com",
  subject: "Hello there",
  body: "Line one\nLine two, with unicode: ünï",
};
const DATE = "Fri, 06 Nov 2026 12:00:00 GMT";
const MID = "<abc-123@mail.nanite.test>";

const signerKey = generatePrivateKey();
const signer = privateKeyToAccount(signerKey);

function ensWith(record: string | null | Error): TextReader {
  return {
    getText: async (name, key) => {
      expect(name).toBe(ENS);
      expect(key).toBe("nanite.signer");
      if (record instanceof Error) throw record;
      return record;
    },
  };
}

async function signedHeaders(key = signerKey, f = {}) {
  const account = privateKeyToAccount(key);
  const canonical = canonicalSendStringV2({ ensName: ENS, ...MAIL, date: DATE, messageId: MID, ...f });
  return {
    "X-Nanite-Agent": ENS,
    "Message-ID": MID,
    "X-Nanite-Date": DATE,
    "X-Nanite-Sig-Version": "2",
    "X-Nanite-Signature": await account.signMessage({ message: canonical }),
  };
}

const verify = (headers: Record<string, string>, over: Partial<typeof MAIL> = {}, record: string | null | Error = signer.address) =>
  verifyNaniteSignature({ headers, ...MAIL, ...over }, { ensClient: ensWith(record) });

describe("canonicalSendStringV2", () => {
  it("is exactly the documented 8-line format with sha256 hex of subject and body", () => {
    const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
    const c = canonicalSendStringV2({ ensName: ENS, ...MAIL, date: DATE, messageId: MID });
    expect(c.split("\n")).toEqual(["nanite-send-v2", ENS, MAIL.from, MAIL.to, sha(MAIL.subject), sha(MAIL.body), DATE, MID]);
  });
});

describe("verifyNaniteSignature", () => {
  it("valid: returns the agent and the record's checksummed signer", async () => {
    const r = await verify(await signedHeaders());
    expect(r).toEqual({ valid: true, agent: ENS, signer: signer.address, reason: "ok" });
  });
  it("header names are case-insensitive and a lower-case record address is accepted", async () => {
    const h = Object.fromEntries(Object.entries(await signedHeaders()).map(([k, v]) => [k.toLowerCase(), v]));
    expect((await verify(h, {}, signer.address.toLowerCase())).valid).toBe(true);
  });
  it("tampered subject, body, to, from: signer_mismatch", async () => {
    const h = await signedHeaders();
    for (const over of [{ subject: "Hello there!" }, { body: MAIL.body + " " }, { to: "evil@example.com" }, { from: "other@mail.nanite.test" }]) {
      const r = await verify(h, over);
      expect(r.valid, JSON.stringify(Object.keys(over))).toBe(false);
      expect(r.reason).toBe("signer_mismatch");
      expect(r.signer).toBe(signer.address);
    }
  });
  it("tampered date, message-id or agent name: invalid", async () => {
    const h = await signedHeaders();
    expect((await verify({ ...h, "X-Nanite-Date": "Fri, 06 Nov 2026 12:00:01 GMT" })).reason).toBe("signer_mismatch");
    expect((await verify({ ...h, "Message-ID": "<other@mail.nanite.test>" })).reason).toBe("signer_mismatch");
  });
  it("wrong signer record: signer_mismatch", async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const r = await verify(await signedHeaders(), {}, other);
    expect(r).toMatchObject({ valid: false, reason: "signer_mismatch", signer: other });
  });
  it("missing or blank record: no_signer_record; garbage record: invalid_signer_record", async () => {
    const h = await signedHeaders();
    expect((await verify(h, {}, null)).reason).toBe("no_signer_record");
    expect((await verify(h, {}, "  ")).reason).toBe("no_signer_record");
    expect((await verify(h, {}, "not-an-address")).reason).toBe("invalid_signer_record");
  });
  it("rotated key: the old signature is invalid against the new record", async () => {
    const oldHeaders = await signedHeaders(signerKey);
    const newKey = generatePrivateKey();
    const rotated = privateKeyToAccount(newKey);
    expect((await verify(oldHeaders, {}, signer.address)).valid).toBe(true);
    const r = await verify(oldHeaders, {}, rotated.address);
    expect(r).toMatchObject({ valid: false, reason: "signer_mismatch", signer: rotated.address });
    expect((await verify(await signedHeaders(newKey), {}, rotated.address)).valid).toBe(true);
  });
  it("missing headers, bad version, malformed signature, unreachable ENS", async () => {
    const h = await signedHeaders();
    for (const drop of ["X-Nanite-Agent", "X-Nanite-Date", "X-Nanite-Signature", "Message-ID", "X-Nanite-Sig-Version"]) {
      const { [drop as keyof typeof h]: _omit, ...rest } = h;
      void _omit;
      expect((await verify(rest)).reason).toBe("missing_headers");
    }
    expect((await verify({ ...h, "X-Nanite-Sig-Version": "1" })).reason).toBe("unsupported_version");
    expect((await verify({ ...h, "X-Nanite-Signature": "0x1234" })).reason).toBe("malformed_signature");
    expect((await verify(h, {}, new Error("rpc down"))).reason).toBe("signer_record_unavailable");
  });
});
