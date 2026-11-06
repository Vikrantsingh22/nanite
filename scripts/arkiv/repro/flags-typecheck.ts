// Does TypeScript catch a numeric `flags` value? Run: docker compose run --rm tools npx tsc --noEmit
// If the @ts-expect-error below is "unused", tsc fails and the claim "TypeScript accepts it" would be true.
import type { CreationFlags } from "@arkiv-network/sdk";

// @ts-expect-error a bitmask number is not a CreationFlags object
export const bad: CreationFlags = 2;
export const good: CreationFlags = { permissionlessExtension: true };
