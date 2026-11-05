// Role allowlists. Operator code NEVER builds a role bitmap from caller input: the registry's register()
// grants the new owner whatever bits it is given (even ALL_ROLES) without checking the caller's own
// roles, so every bitmap used by this package is one of the named constants below.
import rolesJson from "../../../config/roles.json" with { type: "json" };
import type { Address } from "viem";

const reg = rolesJson.registry as Record<string, string>;
const res = rolesJson.resolver as Record<string, string>;
const RR = (k: string): bigint => {
  const v = reg[k];
  if (v === undefined) throw new Error(`unknown registry role ${k}`);
  return BigInt(v);
};
const RS = (k: string): bigint => {
  const v = res[k];
  if (v === undefined) throw new Error(`unknown resolver role ${k}`);
  return BigInt(v);
};

export const ALL_ROLES = BigInt(rolesJson.ALL_ROLES);

export const REGISTRY_ROLE = {
  REGISTRAR: RR("ROLE_REGISTRAR"),
  UNREGISTER: RR("ROLE_UNREGISTER"),
  RENEW: RR("ROLE_RENEW"),
  SET_PARENT: RR("ROLE_SET_PARENT"),
  SET_RESOLVER: RR("ROLE_SET_RESOLVER"),
  SET_SUBREGISTRY: RR("ROLE_SET_SUBREGISTRY"),
  CAN_TRANSFER_ADMIN: RR("ROLE_CAN_TRANSFER_ADMIN"),
} as const;

export const RESOLVER_ROLE = {
  SET_ADDRESS: RS("ROLE_SET_ADDRESS"),
  SET_TEXT: RS("ROLE_SET_TEXT"),
} as const;

/** A role's admin counterpart is `role << 128`. */
export const withAdmin = (roles: bigint): bigint => roles | (roles << 128n);

/**
 * Roles the user holds on their own name token `<user>.nanitecom.eth` (set by register()).
 * = "D3" from T0.4 (SET_RESOLVER | SET_SUBREGISTRY + their admin roles + CAN_TRANSFER_ADMIN) plus a plain
 * ROLE_RENEW (no admin), confirmed by Vikrant Nov 6: users can renew their own name without Nanite.
 * The operator keeps its own root RENEW on the nanitecom registry for auto-renewal. Deliberately NOT
 * granted: UPGRADE, UNREGISTER, REGISTRAR (on the parent registry), or RENEW's admin role.
 */
export const USER_NAME_ROLES: bigint =
  withAdmin(REGISTRY_ROLE.SET_RESOLVER | REGISTRY_ROLE.SET_SUBREGISTRY) |
  REGISTRY_ROLE.CAN_TRANSFER_ADMIN |
  REGISTRY_ROLE.RENEW;

/** Root roles on the USER's own registry (the one deployed per username). */
export const USER_REGISTRY_GRANTS = {
  /** The user owns their registry outright (can delegate, upgrade, or eject the operator). */
  user: ALL_ROLES,
  /**
   * The operator needs, on the user registry:
   *  - REGISTRAR: register agent names (no user signature per agent);
   *  - RENEW: keep agent names alive;
   *  - SET_PARENT: one-time setParent(nanitecomRegistry, username) at creation (without it the user
   *    would have to sign, and the registry would not know its canonical name). The user holds the
   *    matching admin role and can revoke it;
   *  - UNREGISTER: revokeAgent({unregister:true}) from the dashboard without a user signature.
   * Deliberately NOT granted: any admin role, SET_RESOLVER, SET_SUBREGISTRY, CAN_TRANSFER_ADMIN, UPGRADE.
   */
  operator:
    REGISTRY_ROLE.REGISTRAR | REGISTRY_ROLE.RENEW | REGISTRY_ROLE.SET_PARENT | REGISTRY_ROLE.UNREGISTER,
} as const;

/**
 * Roles on the agent name token `<agent>.<user>.nanitecom.eth`. The token is owned by the USER, not the
 * agent wallet, so the agent can never repoint or sell itself. The user may change the resolver and
 * transfer the token; there is no subregistry role (agent names have no children).
 */
export const AGENT_NAME_ROLES: bigint = withAdmin(REGISTRY_ROLE.SET_RESOLVER) | REGISTRY_ROLE.CAN_TRANSFER_ADMIN;

const RESOLVER_SET = RESOLVER_ROLE.SET_TEXT | RESOLVER_ROLE.SET_ADDRESS;
/** Root roles on each agent's own PermissionedResolver: operator and user, never UPGRADE, never the agent. */
export const RESOLVER_GRANTS = {
  operator: withAdmin(RESOLVER_SET),
  user: withAdmin(RESOLVER_SET),
} as const;

/** Text keys the agent wallet may write (key-scoped ROLE_SET_TEXT via grantSetterRoles). Nothing else. */
export const AGENT_SETTER_KEYS = ["agent-context"] as const;
export type AgentSetterKey = (typeof AGENT_SETTER_KEYS)[number];

export interface Grant {
  account: Address;
  roleBitmap: bigint;
}
