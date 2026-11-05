// Browser-safe entrypoint: schema + reads + types. Writes live in '@nanite/arkiv/writer'.
export {
  EMAIL_TYPES,
  EmailSchema,
  MAX_PAYLOAD_BYTES,
  SCHEMA_NAME,
  formatKeyIds,
  parseKeyIds,
} from './schema';
export type { EmailType } from './schema';
export {
  MAX_PAGE,
  RABDI_CHAIN_ID,
  RABDI_EXPLORER,
  RABDI_RPC_URL,
  createArkivReader,
  decodeCursor,
  encodeCursor,
  rowToRecord,
} from './reader';
export type {
  ArkivPublicClient,
  ArkivReader,
  ArkivReaderConfig,
  EmailRecord,
  InboxFilter,
  InboxPage,
  ListInboxOptions,
  WaitOptions,
} from './reader';
export {
  ArkivError,
  ArkivWriteError,
  EntityTooLargeError,
  InvalidEmailFieldsError,
  QueryTimeoutError,
  UntrustedEntityError,
} from './errors';
