// Canonical strings for verifiable outbound mail (X-Nanite-Signature). Pure functions, browser- and Node-safe.
// Defined here (not in @nanite/ens) so the self-hosted agent kit can sign without pulling in the chain code;
// @nanite/ens re-exports them next to the verifier. See packages/ens/src/signature.ts for the scheme.
import { sha256, toBytes } from 'viem';

/** Current signature version (sent in X-Nanite-Sig-Version). */
export const SIG_VERSION = '3';
/** Legacy version: signs the `Message-ID` header, which Resend/SES replaces. Still verifiable, usually fails. */
export const SIG_VERSION_V2 = '2';

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
  return ['nanite-send-v2', f.ensName, f.from, f.to, sha256Hex(f.subject), sha256Hex(f.body), f.date, f.messageId].join('\n');
}

export interface CanonicalFieldsV3 {
  ensName: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
  /** The X-Nanite-Message-Id header, verbatim (including angle brackets). */
  naniteMessageId: string;
}

/**
 * `nanite-send-v3\n<ens>\n<from>\n<to>\n<sha256(subject)>\n<sha256(body)>\n<date>\n<x-nanite-message-id>`
 * Same layout as v2, but the last line is the `X-Nanite-Message-Id` header (our own id, kept by providers)
 * instead of `Message-ID` (replaced by Resend/SES).
 */
export function canonicalSendStringV3(f: CanonicalFieldsV3): string {
  return ['nanite-send-v3', f.ensName, f.from, f.to, sha256Hex(f.subject), sha256Hex(f.body), f.date, f.naniteMessageId].join('\n');
}
