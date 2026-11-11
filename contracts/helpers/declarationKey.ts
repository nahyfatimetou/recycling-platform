import { id } from "ethers";

/**
 * Canonical declarationId for RecyclingRegistry (bytes32).
 * MUST stay identical to backend/src/services/declarationKey.ts:
 *   keccak256(toUtf8Bytes(uuid.toLowerCase()))  ≡  ethers.id(uuid.toLowerCase())
 */
export function declarationKey(uuid: string): string {
  return id(uuid.toLowerCase());
}
