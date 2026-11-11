import { Contract, JsonRpcProvider, Wallet, getAddress, isAddress } from "ethers";
import { env } from "../config/env";
import { assertChainReadyForMint, getChainReadiness, isOperatorKeyConfigured } from "./chainReadiness";

const registryAbi = [
  "function reward(bytes32 declarationId,address beneficiary,uint256 amount) external",
  "function isProcessed(bytes32 declarationId) view returns (bool)",
  "event Rewarded(bytes32 indexed declarationId,address indexed beneficiary,uint256 amount)"
];
const tokenAbi = ["function balanceOf(address account) view returns (uint256)"];

export type RewardedProof = {
  txHash: string;
  beneficiary: string;
  amount: bigint;
  declarationId: string;
};

export { getChainReadiness, isOperatorKeyConfigured };

function getProvider() {
  return new JsonRpcProvider(env.rpcUrl, env.chainId);
}

function getSigner() {
  assertChainReadyForMint();
  if (!isOperatorKeyConfigured()) {
    throw Object.assign(new Error("BACKEND_OPERATOR_PRIVATE_KEY is not configured"), { statusCode: 503 });
  }
  return new Wallet(env.operatorKey.trim(), getProvider());
}

function getRegistry(signerOrProvider?: Wallet | JsonRpcProvider) {
  const readiness = getChainReadiness();
  if (!readiness.registryConfigured) {
    throw Object.assign(new Error("REGISTRY_CONTRACT_ADDRESS is invalid"), { statusCode: 503 });
  }
  const runner = signerOrProvider ?? getSigner();
  return new Contract(env.registryAddress, registryAbi, runner);
}

/** Normalize and validate an EVM address; throws if invalid. */
export function requireValidWallet(wallet: string): string {
  if (!wallet || !isAddress(wallet)) {
    throw Object.assign(new Error("Adresse wallet invalide"), { statusCode: 400 });
  }
  return getAddress(wallet);
}

export async function submitReward(declarationId: string, wallet: string, amount: bigint) {
  assertChainReadyForMint();
  const beneficiary = requireValidWallet(wallet);
  const registry = getRegistry();
  const tx = await registry.reward(declarationId, beneficiary, amount);
  // Persist tx.hash immediately in the caller. Wait is separate so a timeout
  // does not erase the fact that a transaction was broadcast.
  return { txHash: tx.hash as string, wait: () => tx.wait(env.confirmations, env.txTimeoutMs) };
}

export async function isDeclarationProcessed(declarationId: string): Promise<boolean> {
  if (!getChainReadiness().registryConfigured) {
    throw Object.assign(new Error("REGISTRY_CONTRACT_ADDRESS is invalid"), { statusCode: 503 });
  }
  return Boolean(await getRegistry(getProvider()).isProcessed(declarationId));
}

export async function getRewardReceipt(txHash: string) {
  return getProvider().getTransactionReceipt(txHash);
}

/**
 * Look up the on-chain Rewarded event for a declaration key.
 * Read-only — never mints / never submits a transaction.
 */
export async function findRewardedProof(declarationId: string): Promise<RewardedProof | null> {
  const registry = getRegistry(getProvider());
  const filter = registry.filters.Rewarded(declarationId);
  const events = await registry.queryFilter(filter);
  if (!events.length) return null;
  const last = events[events.length - 1]!;
  const args = (last as { args?: { declarationId?: string; beneficiary?: string; amount?: bigint } }).args;
  if (!args?.beneficiary || args.amount === undefined) return null;
  return {
    declarationId,
    txHash: last.transactionHash,
    beneficiary: getAddress(String(args.beneficiary)),
    amount: BigInt(args.amount.toString())
  };
}

export async function findRewardedTxHash(declarationId: string): Promise<string | null> {
  const proof = await findRewardedProof(declarationId);
  return proof?.txHash ?? null;
}

export async function readEcoBalance(wallet: string): Promise<string> {
  const account = requireValidWallet(wallet);
  if (!getChainReadiness().tokenConfigured) {
    throw Object.assign(new Error("TOKEN_CONTRACT_ADDRESS is invalid"), { statusCode: 503 });
  }
  const token = new Contract(env.tokenAddress, tokenAbi, getProvider());
  return (await token.balanceOf(account)).toString();
}
