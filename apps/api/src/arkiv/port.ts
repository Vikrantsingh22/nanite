/*
 * Port to the Arkiv operator writer. The inbound pipeline codes against this interface only.
 * Real implementation: ./arkiv-writer.ts (wraps `@nanite/arkiv/writer`, one shared instance per process).
 * Test/dev fallback: InMemoryArkivWriter below.
 */

/** Compatible with @nanite/arkiv EmailType. Inbound only produces "otp" | "conversation". */
export type EmailType = "otp" | "conversation" | "sent";

/** Entity fields of schema nanite.email.v1. Only ciphertext + opaque/blind values. */
export interface ArkivEmailFields {
  /** Agent ENS name. */
  agentId: string;
  /** The user's wallet (lowercase 0x...). */
  ownerId: string;
  type: EmailType;
  /** Unix seconds. */
  receivedAt: number;
  /** HMAC-derived opaque id (32 hex). */
  threadId: string;
  /** Per-user blind index of the sender (64 hex). */
  senderHash: string;
  /** Recipient keyIds exactly as `encryptEmail(...).keyIds` returns them (sorted, 16 hex each). */
  keyIds: string[];
  ciphertext: Uint8Array;
  wrappedKeys: Uint8Array;
  nonce: Uint8Array;
}

export interface WriteEmailInput {
  fields: ArkivEmailFields;
  /** Entity ends up owned by this wallet (operator stays $creator). */
  ownerWallet: string;
  /** true for everything except OTPs. */
  permissionlessExtension: boolean;
}

export interface WriteEmailOutput {
  entityKey: string;
  txHash: string;
}

export interface ArkivWriterPort {
  /** Resolves once the write is confirmed on chain (or throws; errors never carry content). */
  writeEmail(input: WriteEmailInput): Promise<WriteEmailOutput>;
}

/** Dev/test fake: keeps the last writes in memory and returns fake entity keys. */
export class InMemoryArkivWriter implements ArkivWriterPort {
  readonly writes: WriteEmailInput[] = [];
  private counter = 0;
  constructor(private readonly keep = 100) {}

  async writeEmail(input: WriteEmailInput): Promise<WriteEmailOutput> {
    this.writes.push(input);
    if (this.writes.length > this.keep) this.writes.shift();
    this.counter += 1;
    const n = this.counter.toString(16).padStart(60, "0");
    return { entityKey: `0xfake${n}`, txHash: `0xfade${n}` };
  }
}
