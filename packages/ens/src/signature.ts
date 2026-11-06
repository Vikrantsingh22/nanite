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
 *   X-Nanite-Sig-Version 3
 *   X-Nanite-Message-Id  our own message id `<sendLogId@domain>` (signed)
 * A verifier resolves the ENS name, reads the `nanite.signer` text record, and checks that the signature
 * recovers to that address. The record is written only by the user or the operator.
 *
 * Why v3 (v2 is legacy): v2 signed the standard `Message-ID` header. Resend (Amazon SES) REPLACES that header
 * with its own id on delivery (seen on the first real email, 2026-11-06), so v2 mail that went through Resend can
 * never verify. v3 signs a custom header, `X-Nanite-Message-Id`, which providers keep, and the API no longer sets
 * `Message-ID` at all (the provider owns it).
 */
import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { SIG_VERSION, SIG_VERSION_V2, canonicalSendStringV2, canonicalSendStringV3 } from "@nanite/crypto";

export {
  SIG_VERSION,
  SIG_VERSION_V2,
  canonicalSendStringV2,
  canonicalSendStringV3,
  type CanonicalFields,
  type CanonicalFieldsV3,
} from "@nanite/crypto";

export const SIGNER_KEY = "nanite.signer";

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
  /** Extra explanation for a known cause of failure (set for legacy v2 mail that does not verify). */
  hint?: string;
}

const V2_HINT =
  "Sig-Version 2 signs the Message-ID header, which Resend/Amazon SES replaces on delivery, so v2 mail sent through Resend cannot verify. Only v3 (X-Nanite-Message-Id) survives.";

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
 * Verify the signature headers of one mail (v3 by default, legacy v2 by its Sig-Version header). `from`, `to`,
 * `subject` and `body` are the values the verifier actually received. Never throws for bad input: it returns `{valid:false, reason}`.
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
  // The id that is signed: X-Nanite-Message-Id for v3 (default), the Message-ID header for legacy v2.
  const idHeader = version === SIG_VERSION_V2 ? "Message-ID" : "X-Nanite-Message-Id";
  const signedId = header(mail.headers, idHeader);
  const fail = (reason: SignatureFailure, signer: string | null = null): VerifyResult => ({
    valid: false,
    agent,
    signer,
    reason,
    ...(version === SIG_VERSION_V2 && reason === "signer_mismatch" ? { hint: V2_HINT } : {}),
  });

  if (!agent || !date || !sig || !version || !signedId) return fail("missing_headers");
  if (version !== SIG_VERSION && version !== SIG_VERSION_V2) return fail("unsupported_version");
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
    const fields = { ensName: agent, from: mail.from, to: mail.to, subject: mail.subject, body: mail.body, date };
    recovered = await recoverMessageAddress({
      message: version === SIG_VERSION_V2 ? canonicalSendStringV2({ ...fields, messageId: signedId }) : canonicalSendStringV3({ ...fields, naniteMessageId: signedId }),
      signature: sig as Hex,
    });
  } catch {
    return fail("malformed_signature", signer);
  }
  if (recovered !== signer) return fail("signer_mismatch", signer);
  return { valid: true, agent, signer, reason: "ok" };
}
