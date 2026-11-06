import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { canonicalSendStringV2, canonicalSendStringV3, verifyNaniteSignature, type TextReader } from "../src/signature.js";

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

const NID = "<3f2b9c1e-0000-4000-8000-000000000001@mail.nanite.test>";

/** v3 headers (the current format). */
async function signedHeaders(key = signerKey, f = {}) {
  const account = privateKeyToAccount(key);
  const canonical = canonicalSendStringV3({ ensName: ENS, ...MAIL, date: DATE, naniteMessageId: NID, ...f });
  return {
    "X-Nanite-Agent": ENS,
    "X-Nanite-Message-Id": NID,
    "X-Nanite-Date": DATE,
    "X-Nanite-Sig-Version": "3",
    "X-Nanite-Signature": await account.signMessage({ message: canonical }),
  };
}

/** Legacy v2 headers: the signed id is the Message-ID header. */
async function signedHeadersV2(key = signerKey) {
  const account = privateKeyToAccount(key);
  const canonical = canonicalSendStringV2({ ensName: ENS, ...MAIL, date: DATE, messageId: MID });
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

describe("canonicalSendStringV3", () => {
  it("is the v2 layout with the X-Nanite-Message-Id on the last line", () => {
    const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
    const c = canonicalSendStringV3({ ensName: ENS, ...MAIL, date: DATE, naniteMessageId: NID });
    expect(c.split("\n")).toEqual(["nanite-send-v3", ENS, MAIL.from, MAIL.to, sha(MAIL.subject), sha(MAIL.body), DATE, NID]);
  });
});

describe("verifyNaniteSignature v2 (legacy)", () => {
  it("still verifies when the Message-ID is the one that was signed", async () => {
    expect(await verify(await signedHeadersV2())).toEqual({ valid: true, agent: ENS, signer: signer.address, reason: "ok" });
  });
  it("fails with a hint when the provider replaced the Message-ID (Resend/SES)", async () => {
    const h = await signedHeadersV2();
    const ses = "<010601a1ae8f54f4-4a31c82b-34bf-4fbd-9042-2bfe758ecb83-000000@ap-northeast-1.amazonses.com>";
    const r = await verify({ ...h, "Message-ID": ses });
    expect(r).toMatchObject({ valid: false, reason: "signer_mismatch", signer: signer.address });
    expect(r.hint).toMatch(/Resend/);
  });
  it("v2 needs Message-ID; v3 headers with Sig-Version 2 are missing it", async () => {
    const { "X-Nanite-Message-Id": _n, ...rest } = await signedHeaders();
    void _n;
    expect((await verify({ ...rest, "X-Nanite-Sig-Version": "2" })).reason).toBe("missing_headers");
  });
  it("a v2 signature presented as v3 (or the reverse) does not verify", async () => {
    const v2 = await signedHeadersV2();
    expect((await verify({ ...v2, "X-Nanite-Sig-Version": "3", "X-Nanite-Message-Id": MID })).reason).toBe("signer_mismatch");
    const v3 = await signedHeaders();
    expect((await verify({ ...v3, "X-Nanite-Sig-Version": "2", "Message-ID": NID })).reason).toBe("signer_mismatch");
  });
  it("v3 mail survives the provider replacing Message-ID", async () => {
    const h = await signedHeaders();
    const r = await verify({ ...h, "Message-ID": "<010601a1ae8f54f4-x-000000@ap-northeast-1.amazonses.com>" });
    expect(r.valid).toBe(true);
    expect(r.hint).toBeUndefined();
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
  it("tampered date, X-Nanite-Message-Id or agent name: invalid", async () => {
    const h = await signedHeaders();
    expect((await verify({ ...h, "X-Nanite-Date": "Fri, 06 Nov 2026 12:00:01 GMT" })).reason).toBe("signer_mismatch");
    expect((await verify({ ...h, "X-Nanite-Message-Id": "<other@mail.nanite.test>" })).reason).toBe("signer_mismatch");
  });
  it("the Message-ID header is not part of v3: changing it changes nothing", async () => {
    const h = await signedHeaders();
    expect((await verify({ ...h, "Message-ID": "<anything@else>" })).valid).toBe(true);
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
    for (const drop of ["X-Nanite-Agent", "X-Nanite-Date", "X-Nanite-Signature", "X-Nanite-Message-Id", "X-Nanite-Sig-Version"]) {
      const { [drop as keyof typeof h]: _omit, ...rest } = h;
      void _omit;
      expect((await verify(rest)).reason).toBe("missing_headers");
    }
    expect((await verify({ ...h, "X-Nanite-Sig-Version": "1" })).reason).toBe("unsupported_version");
    expect((await verify({ ...h, "X-Nanite-Sig-Version": "4" })).reason).toBe("unsupported_version");
    expect((await verify({ ...h, "X-Nanite-Signature": "0x1234" })).reason).toBe("malformed_signature");
    expect((await verify(h, {}, new Error("rpc down"))).reason).toBe("signer_record_unavailable");
  });
});
