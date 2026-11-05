/*
 * Verifiable outbound mail (signing option B). Pure functions, no I/O except the injected text reader.
 *
 * Lives in @nanite/ens (not in apps/api) because the SAME canonical string must be built by the sender (the API)
 * and by every verifier (CLI, other services), and the verifier needs exactly what this package already has: viem
 * and the Universal Resolver reads. Putting both halves next to the `nanite.signer` record definition keeps them
 * from drifting apart.
 *
 * Scheme: the API signs (EIP-191 personal_sign) a canonical string with a per-agent signer key and sends
 *   X-Nanite-Agent       the agent's ENS name
 *   X-Nanite-Date        the date used in the canonical string (verbatim)
 *   X-Nanite-Signature   0x signature
 *   X-Nanite-Sig-Version 2
 * (plus the normal Message-ID). A verifier resolves the ENS name, reads the `nanite.signer` text record, and
 * checks that the signature recovers to that address. The record is written only by the user or the operator.
 */
import { getAddress, isAddress, recoverMessageAddress, sha256, toBytes, type Address, type Hex } from "viem";

export const SIGNER_KEY = "nanite.signer";
export const SIG_VERSION = "2";

const sha256Hex = (s: string): string => sha256(toBytes(s)).slice(2);

export interface CanonicalFields {
  /** Agent ENS name (X-Nanite-Agent). */
  ensName: string;
  /** The From address of the mail. */
  from: string;
  /** The (single) recipient address. */
  to: string;
  subject: string;
  body: string;
  /** X-Nanite-Date, verbatim. */
  date: string;
  /** The Message-ID header, verbatim (including angle brackets). */
  messageId: string;
}

/**
 * `nanite-send-v2\n<ens>\n<from>\n<to>\n<sha256(subject)>\n<sha256(body)>\n<date>\n<message-id>`
 * Subject and body are hashed as UTF-8 and written as lower-case hex. Fields are joined by a single \n.
 */
export function canonicalSendStringV2(f: CanonicalFields): string {
  return [
    "nanite-send-v2",
    f.ensName,
    f.from,
    f.to,
    sha256Hex(f.subject),
    sha256Hex(f.body),
    f.date,
    f.messageId,
  ].join("\n");
}

export type SignatureFailure =
  | "missing_headers"
  | "unsupported_version"
  | "malformed_signature"
  | "signer_record_unavailable"
  | "no_signer_record"
  | "invalid_signer_record"
  | "signer_mismatch";

export interface VerifyResult {
  valid: boolean;
  /** The agent ENS name from X-Nanite-Agent, if present. */
  agent: string | null;
  /** The address published in `nanite.signer` (null if it could not be read). */
  signer: string | null;
  /** "ok" when valid, otherwise a SignatureFailure. */
  reason: "ok" | SignatureFailure;
}

/** Anything that can read an ENS text record fresh (NameReader, or `{ getText }` over a viem client). */
export interface TextReader {
  getText(name: string, key: string): Promise<string | null>;
}

const header = (headers: Record<string, string | string[] | undefined>, name: string): string | undefined => {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) continue;
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s.length > 0) return s;
  }
  return undefined;
};

/**
 * Verify the signature headers of one mail. `from`, `to`, `subject` and `body` are the values the verifier
 * actually received. Never throws for bad input: it returns `{valid:false, reason}`.
 *
 * It proves that the holder of the agent's current `nanite.signer` key signed exactly these fields. It does not
 * check the date's freshness and it does not decide whether the agent name itself is one you trust.
 */
export async function verifyNaniteSignature(
  mail: {
    headers: Record<string, string | string[] | undefined>;
    from: string;
    to: string;
    subject: string;
    body: string;
  },
  opts: { ensClient: TextReader },
): Promise<VerifyResult> {
  const agent = header(mail.headers, "X-Nanite-Agent") ?? null;
  const date = header(mail.headers, "X-Nanite-Date");
  const sig = header(mail.headers, "X-Nanite-Signature");
  const version = header(mail.headers, "X-Nanite-Sig-Version");
  const messageId = header(mail.headers, "Message-ID");
  const fail = (reason: SignatureFailure, signer: string | null = null): VerifyResult => ({ valid: false, agent, signer, reason });

  if (!agent || !date || !sig || !messageId || !version) return fail("missing_headers");
  if (version !== SIG_VERSION) return fail("unsupported_version");
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return fail("malformed_signature");

  let record: string | null;
  try {
    record = await opts.ensClient.getText(agent, SIGNER_KEY);
  } catch {
    return fail("signer_record_unavailable");
  }
  const rec = record?.trim();
  if (!rec) return fail("no_signer_record");
  if (!isAddress(rec, { strict: false })) return fail("invalid_signer_record");
  const signer = getAddress(rec);

  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: canonicalSendStringV2({ ensName: agent, from: mail.from, to: mail.to, subject: mail.subject, body: mail.body, date, messageId }),
      signature: sig as Hex,
    });
  } catch {
    return fail("malformed_signature", signer);
  }
  if (recovered !== signer) return fail("signer_mismatch", signer);
  return { valid: true, agent, signer, reason: "ok" };
}
