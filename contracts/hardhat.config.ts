import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
dotenv.config({ path: "../backend/.env" });

function operatorAccounts(): string[] {
  const key = (process.env.BACKEND_OPERATOR_PRIVATE_KEY || "").trim();
  // Accept only a real 32-byte hex key; placeholders must not break local `hardhat test`.
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return [];
  return [key];
}

const config: HardhatUserConfig = {
  solidity: "0.8.24",
  networks: {
    hardhat: {},
    hederaTestnet: {
      url: process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api",
      chainId: 296,
      accounts: operatorAccounts()
    }
  }
};
export default config;
