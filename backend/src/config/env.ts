import dotenv from "dotenv";
dotenv.config();

const required = ["DATABASE_URL", "JWT_SECRET"] as const;
for (const key of required) if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);

export const env = {
  port: Number(process.env.PORT || 4001),
  databaseUrl: process.env.DATABASE_URL!,
  jwtSecret: process.env.JWT_SECRET!,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "1d",
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
  rpcUrl: process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api",
  chainId: Number(process.env.HEDERA_CHAIN_ID || 296),
  operatorKey: process.env.BACKEND_OPERATOR_PRIVATE_KEY || "",
  registryAddress: process.env.REGISTRY_CONTRACT_ADDRESS || "",
  tokenAddress: process.env.TOKEN_CONTRACT_ADDRESS || "",
  confirmations: Number(process.env.TX_CONFIRMATIONS || 1),
  txTimeoutMs: Number(process.env.TX_WAIT_TIMEOUT_MS || 120000),
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  rewardMaxEcoPerDeclaration: process.env.REWARD_MAX_ECO_PER_DECLARATION || "1000",
  rewardMinQuantityMillis: process.env.REWARD_MIN_QUANTITY_MILLIS || "100",
  rewardRatesJson: process.env.REWARD_RATES_JSON || "",
  reconcileOnStartup: (process.env.RECONCILE_ON_STARTUP || "true").toLowerCase() !== "false"
};
