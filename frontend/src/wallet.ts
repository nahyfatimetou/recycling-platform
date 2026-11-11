import { BrowserProvider, formatUnits } from "ethers";

export const HEDERA_TESTNET = {
  chainId: "0x128", // 296
  chainName: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: ["https://testnet.hashio.io/api"],
  blockExplorerUrls: ["https://hashscan.io/testnet"]
};

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<any>;
      isMetaMask?: boolean;
    };
  }
}

export function hasMetaMask(): boolean {
  return Boolean(window.ethereum);
}

export async function connectMetaMask(): Promise<string> {
  if (!window.ethereum) {
    throw new Error("MetaMask n'est pas installé. Installez l'extension puis réessayez.");
  }
  const accounts: string[] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) throw new Error("Aucun compte MetaMask sélectionné");

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: HEDERA_TESTNET.chainId }]
    });
  } catch (error: any) {
    if (error?.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [HEDERA_TESTNET]
      });
    } else if (error?.code !== 4001) {
      // User rejected or other — continue with address; backend only needs the EVM address.
      console.warn("Switch réseau Hedera:", error);
    }
  }

  return address;
}

export function formatEcoFromWei(wei: string | null | undefined): string {
  if (!wei) return "—";
  try {
    const v = formatUnits(wei, 18);
    const n = Number(v);
    if (!Number.isFinite(n)) return v;
    return n.toLocaleString("fr-FR", { maximumFractionDigits: 4 });
  } catch {
    return wei;
  }
}

export async function getProvider(): Promise<BrowserProvider> {
  if (!window.ethereum) throw new Error("MetaMask indisponible");
  return new BrowserProvider(window.ethereum);
}
