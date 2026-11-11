import { id, keccak256, toUtf8Bytes } from "ethers";

/**
 * Canonical on-chain declarationId (bytes32 hex with 0x prefix).
 *
 * Formula (MUST match contracts/helpers/declarationKey.ts and Hardhat tests):
 *   keccak256(UTF-8 bytes of the declaration UUID in lowercase)
 * which is exactly `ethers.id(uuid.toLowerCase())`.
 *
 * The UUID itself is generated once at creation (`crypto.randomUUID`) and stored in
 * `declarations.id`; `declarations.declaration_key` persists this hash for the registry.
 */
export function declarationKey(uuid: string): string {
  return id(uuid.toLowerCase());
}

/** Explicit equivalent used in cross-stack compatibility tests. */
export function declarationKeyFromKeccak(uuid: string): string {
  return keccak256(toUtf8Bytes(uuid.toLowerCase()));
}
