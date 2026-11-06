/*
 * Real ArkivWriterPort backed by `@nanite/arkiv/writer`.
 *
 * Create ONE of these per process: the underlying writer owns the single-flight queue that keeps
 * the operator's nonce (and so the predicted entity keys) race-free. Never create a second writer
 * for the same operator key.
 */
import { createArkivWriter } from "@nanite/arkiv/writer";
import type { Address, Hex } from "viem";
import type { ArkivWriterPort } from "./port.js";

export interface RealArkivWriterConfig {
  /** Operator private key (0x + 64 hex). Never logged. */
  privateKey: string;
  /** Rate-limit key only. */
  accessKey?: string | undefined;
  rpcUrl?: string | undefined;
}

export function createRealArkivWriter(config: RealArkivWriterConfig) {
  const writer = createArkivWriter({
    privateKey: config.privateKey as Hex,
    ...(config.accessKey ? { accessKey: config.accessKey } : {}),
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
  });
  const port: ArkivWriterPort = {
    async writeEmail({ fields, ownerWallet, permissionlessExtension, expiresInSeconds }) {
      const r = await writer.writeEmail({
        fields: { ...fields, ownerId: fields.ownerId as Address },
        owner: ownerWallet as Address,
        permissionlessExtension,
        ...(expiresInSeconds !== undefined ? { expiresIn: expiresInSeconds } : {}),
      });
      return { entityKey: r.entityKey, txHash: r.txHash };
    },
    async extendEmail(entityKey, seconds) {
      const r = await writer.extendEmail(entityKey as Hex, { expiresIn: seconds });
      return { txHash: r.txHash, expiresAtBlock: r.expiresAtBlock ?? null };
    },
  };
  /** `operatorAddress` and `reader` (creator-pinned) are for dev tooling and tests. */
  return { port, operatorAddress: writer.address, reader: writer.reader, writer };
}

export type RealArkivWriter = ReturnType<typeof createRealArkivWriter>;
