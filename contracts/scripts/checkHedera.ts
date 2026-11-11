/**
 * Preflight Hedera Testnet config (no private key printed, no deploy).
 * Usage: npm run check:hedera -w contracts
 *
 * Exit codes:
 *  0 — operator wallet OK (and contracts OK if configured)
 *  1 — operator misconfigured / RPC issue / address mismatch / contract mismatch
 */
import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config({ path: "../backend/.env" });

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;
const PLACEHOLDER = /YOUR_TESTNET|PLACEHOLDER|CHANGE_ME|REPLACE|EXAMPLE/i;

async function main() {
  const rpc = process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api";
  const chainIdEnv = Number(process.env.HEDERA_CHAIN_ID || 296);
  const key = (process.env.BACKEND_OPERATOR_PRIVATE_KEY || "").trim();
  const expectedAddress = (process.env.OPERATOR_EVM_ADDRESS || "").trim();
  const accountId = (process.env.OPERATOR_ACCOUNT_ID || "").trim();
  const registry = (process.env.REGISTRY_CONTRACT_ADDRESS || "").trim();
  const token = (process.env.TOKEN_CONTRACT_ADDRESS || "").trim();

  const operatorKeyConfigured = HEX_KEY.test(key) && !PLACEHOLDER.test(key);
  const expectedAddressConfigured = ethers.isAddress(expectedAddress);

  const report: Record<string, unknown> = {
    rpc,
    expectedChainId: chainIdEnv,
    operatorAccountId: accountId || null,
    expectedOperatorAddress: expectedAddressConfigured ? ethers.getAddress(expectedAddress) : null,
    operatorKeyConfigured,
    registryConfigured: ethers.isAddress(registry),
    tokenConfigured: ethers.isAddress(token)
  };

  const provider = new ethers.JsonRpcProvider(rpc, chainIdEnv);
  const network = await provider.getNetwork();
  report.rpcChainId = Number(network.chainId);
  report.rpcReachable = Number(network.chainId) === chainIdEnv;

  let addressMatchesExpected: boolean | null = null;
  if (operatorKeyConfigured) {
    const wallet = new ethers.Wallet(key, provider);
    const balance = await provider.getBalance(wallet.address);
    report.operatorAddress = wallet.address;
    report.operatorBalanceWei = balance.toString();
    report.operatorHasHbar = balance > 0n;
    if (expectedAddressConfigured) {
      addressMatchesExpected =
        wallet.address.toLowerCase() === ethers.getAddress(expectedAddress).toLowerCase();
      report.addressMatchesExpected = addressMatchesExpected;
    }
  }

  if (report.registryConfigured && report.tokenConfigured) {
    const registryContract = await ethers.getContractAt("RecyclingRegistry", registry, provider);
    const tokenContract = await ethers.getContractAt("EcoToken", token, provider);
    report.registryOwner = await registryContract.owner();
    report.tokenMinter = await tokenContract.minter();
    report.minterMatchesRegistry =
      String(report.tokenMinter).toLowerCase() === registry.toLowerCase();
  }

  const operatorReady =
    report.rpcReachable === true &&
    operatorKeyConfigured === true &&
    report.operatorHasHbar === true &&
    (addressMatchesExpected === null || addressMatchesExpected === true);

  const contractsReady =
    report.registryConfigured === true &&
    report.tokenConfigured === true &&
    (report.minterMatchesRegistry === undefined || report.minterMatchesRegistry === true);

  report.operatorReady = operatorReady;
  report.readyForMint = operatorReady && contractsReady;

  console.log(JSON.stringify(report, null, 2));

  if (!operatorReady) {
    console.error("\nOperator preflight FAILED.");
    if (!report.rpcReachable) console.error("- RPC unreachable or wrong chainId (expected 296).");
    if (!operatorKeyConfigured) {
      console.error(
        "- Set BACKEND_OPERATOR_PRIVATE_KEY in backend/.env to a real 0x+64 hex ECDSA key (no placeholder)."
      );
    }
    if (operatorKeyConfigured && report.operatorHasHbar !== true) {
      console.error("- Operator wallet has 0 HBAR on testnet — fund it before deploy.");
    }
    if (addressMatchesExpected === false) {
      console.error(
        "- Derived address does not match OPERATOR_EVM_ADDRESS — wrong private key for this account."
      );
    }
    process.exitCode = 1;
    return;
  }

  if (!contractsReady) {
    console.log("\nOperator preflight OK — wallet funded and coherent.");
    console.log("Contracts not deployed yet (expected). Do not mint until deploy + addresses are set.");
    return;
  }

  console.log("\nHedera preflight OK — mint path can run.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
