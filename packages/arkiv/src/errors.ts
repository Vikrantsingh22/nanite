// Typed errors. Messages never include ciphertext or any email content.
export class ArkivError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** ciphertext + wrappedKeys + nonce exceeds the per-entity budget. Chunking is not implemented. */
export class EntityTooLargeError extends ArkivError {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`entity payload is ${size} bytes, over the ${limit}-byte limit`);
  }
}

/** A field failed validation before anything was sent. */
export class InvalidEmailFieldsError extends ArkivError {}

/** An entity was found but is not trusted: wrong $creator or not our schema. */
export class UntrustedEntityError extends ArkivError {
  constructor(
    readonly entityKey: string,
    readonly reason: 'creator' | 'schema',
  ) {
    super(`entity ${entityKey} rejected: ${reason} mismatch`);
  }
}

/** A write failed after the bounded retries. `cause` is the sanitized last error message. */
export class ArkivWriteError extends ArkivError {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
  }
}

export class QueryTimeoutError extends ArkivError {}
