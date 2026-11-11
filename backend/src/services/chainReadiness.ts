import { isAddress } from "ethers";
import { env } from "../config/env";

const PLACEHOLDER_KEY_RE = /YOUR_TESTNET|PLACEHOLDER|CHANGE_ME|REPLACE|EXAMPLE/i;
const HEX_PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export type ChainReadiness = {
  chainId: number;
  rpcUrl: string;
  operatorKeyConfigured: boolean;
  registryConfigured: boolean;
  tokenConfigured: boolean;
  readyForMint: boolean;
  blockers: string[];
};

/** Never logs or returns the private key. */
export function isOperatorKeyConfigured(raw = env.operatorKey): boolean {
  const key = (raw || "").trim();
  if (!HEX_PRIVATE_KEY_RE.test(key)) return false;
  if (PLACEHOLDER_KEY_RE.test(key)) return false;
  return true;
}

export function getChainReadiness(): ChainReadiness {
  const operatorKeyConfigured = isOperatorKeyConfigured();
  const registryConfigured = isAddress(env.registryAddress || "");
  const tokenConfigured = isAddress(env.tokenAddress || "");
  const blockers: string[] = [];
  if (!operatorKeyConfigured) {
    blockers.push("BACKEND_OPERATOR_PRIVATE_KEY manquante ou placeholder (attendu: 0x + 64 hex)");
  }
  if (!registryConfigured) {
    blockers.push("REGISTRY_CONTRACT_ADDRESS manquante ou invalide");
  }
  if (!tokenConfigured) {
    blockers.push("TOKEN_CONTRACT_ADDRESS manquante ou invalide");
  }
  return {
    chainId: env.chainId,
    rpcUrl: env.rpcUrl,
    operatorKeyConfigured,
    registryConfigured,
    tokenConfigured,
    readyForMint: operatorKeyConfigured && registryConfigured && tokenConfigured,
    blockers
  };
}

export function assertChainReadyForMint(): void {
  const readiness = getChainReadiness();
  if (readiness.readyForMint) return;
  throw Object.assign(
    new Error(`Intégration Hedera incomplète: ${readiness.blockers.join("; ")}`),
    { statusCode: 503 }
  );
}
