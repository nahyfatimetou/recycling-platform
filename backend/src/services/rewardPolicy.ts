/**
 * ECO reward policy — integer-only wei math (18 decimals).
 * Configuration comes exclusively from env.ts (single source of truth).
 */

import { env } from "../config/env";

export const ECO_DECIMALS = 18n;
export const WEI_PER_ECO = 10n ** ECO_DECIMALS;
export const QUANTITY_SCALE = 1000n; // quantity stored with up to 3 decimal places (kg)

const DEFAULT_RATES_ECO_PER_KG: Record<string, number> = {
  plastic: 12,
  metal: 15,
  aluminum: 18,
  glass: 8,
  paper: 5,
  cardboard: 4,
  organic: 2,
  electronic: 25,
  other: 3
};

const MATERIAL_ALIASES: Record<string, string> = {
  plastic: "plastic",
  plastique: "plastic",
  metal: "metal",
  métal: "metal",
  metaux: "metal",
  métaux: "metal",
  aluminum: "aluminum",
  aluminium: "aluminum",
  glass: "glass",
  verre: "glass",
  paper: "paper",
  papier: "paper",
  cardboard: "cardboard",
  carton: "cardboard",
  organic: "organic",
  organique: "organic",
  electronic: "electronic",
  electronique: "electronic",
  électronique: "electronic",
  other: "other",
  autre: "other",
  mixed: "other",
  mixte: "other"
};

export type RewardPolicyConfig = {
  ratesEcoPerKg: Record<string, number>;
  maxEcoPerDeclaration: bigint;
  minQuantityKgMillis: bigint;
};

function parsePositiveIntEnv(raw: string | undefined, fallback: bigint): bigint {
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  return BigInt(raw.trim());
}

function loadRatesFromEnv(): Record<string, number> {
  const raw = env.rewardRatesJson;
  if (!raw) return { ...DEFAULT_RATES_ECO_PER_KG };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rates: Record<string, number> = { ...DEFAULT_RATES_ECO_PER_KG };
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid rate for ${key}`);
      }
      rates[key.toLowerCase()] = value;
    }
    return rates;
  } catch (error) {
    throw new Error(`REWARD_RATES_JSON invalide: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function getRewardPolicyConfig(): RewardPolicyConfig {
  return {
    ratesEcoPerKg: loadRatesFromEnv(),
    maxEcoPerDeclaration: parsePositiveIntEnv(env.rewardMaxEcoPerDeclaration, 1000n),
    minQuantityKgMillis: parsePositiveIntEnv(env.rewardMinQuantityMillis, 100n)
  };
}

/** Normalize free-text material to a catalog key. */
export function normalizeMaterial(material: string): string {
  const key = material.trim().toLowerCase();
  return MATERIAL_ALIASES[key] || "other";
}

/**
 * Parse a non-negative decimal string with at most `maxFractionDigits` fractional digits
 * into an integer scaled by 10^maxFractionDigits. Rejects scientific notation and floats.
 */
export function parseDecimalToScaled(raw: string, maxFractionDigits: number): bigint {
  const value = raw.trim();
  if (!value || value.startsWith("-")) {
    throw Object.assign(new Error("Nombre décimal invalide"), { statusCode: 400 });
  }
  if (!new RegExp(`^\\d+(\\.\\d{1,${maxFractionDigits}})?$`).test(value)) {
    throw Object.assign(
      new Error(`Format décimal invalide (max ${maxFractionDigits} décimales)`),
      { statusCode: 400 }
    );
  }
  const [wholePart, fractionPart = ""] = value.split(".");
  const paddedFraction = (fractionPart + "0".repeat(maxFractionDigits)).slice(0, maxFractionDigits);
  return BigInt(wholePart) * 10n ** BigInt(maxFractionDigits) + BigInt(paddedFraction || "0");
}

/** Convert quantity kg (string) to millis (×1000). */
export function quantityKgToMillis(quantityRaw: string): bigint {
  return parseDecimalToScaled(quantityRaw, 3);
}

/** Convert ECO amount (string, up to 18 decimals) to wei. */
export function ecoAmountToWei(ecoRaw: string): bigint {
  return parseDecimalToScaled(ecoRaw, 18);
}

export function weiToEcoString(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / WEI_PER_ECO;
  const frac = abs % WEI_PER_ECO;
  if (frac === 0n) return `${negative ? "-" : ""}${whole.toString()}`;
  const fracStr = frac.toString().padStart(Number(ECO_DECIMALS), "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}.${fracStr}`;
}

export function assertQuantityAllowed(quantityRaw: string, config = getRewardPolicyConfig()): bigint {
  const millis = quantityKgToMillis(quantityRaw);
  if (millis < config.minQuantityKgMillis) {
    const minKg = `${config.minQuantityKgMillis / 1000n}.${(config.minQuantityKgMillis % 1000n)
      .toString()
      .padStart(3, "0")
      .replace(/0+$/, "")
      .replace(/\.$/, "")}`;
    throw Object.assign(new Error(`Quantité minimale: ${minKg} kg`), { statusCode: 400 });
  }
  return millis;
}

/**
 * Informative or definitive reward from material + quantity.
 * wei = quantity_millis * rate * 10^15  (= qty_kg * rate * 10^18)
 */
export function computeRewardWei(
  material: string,
  quantityRaw: string,
  config = getRewardPolicyConfig()
): {
  materialKey: string;
  rateEcoPerKg: number;
  quantityMillis: bigint;
  rewardWei: bigint;
} {
  const quantityMillis = assertQuantityAllowed(quantityRaw, config);
  const materialKey = normalizeMaterial(material);
  const rateEcoPerKg = config.ratesEcoPerKg[materialKey] ?? config.ratesEcoPerKg.other;
  const rewardWei = quantityMillis * BigInt(rateEcoPerKg) * 10n ** 15n;
  const maxWei = config.maxEcoPerDeclaration * WEI_PER_ECO;
  if (rewardWei > maxWei) {
    throw Object.assign(
      new Error(`Récompense calculée supérieure au plafond de ${config.maxEcoPerDeclaration.toString()} ECO`),
      { statusCode: 400 }
    );
  }
  if (rewardWei <= 0n) {
    throw Object.assign(new Error("Récompense calculée nulle"), { statusCode: 400 });
  }
  return { materialKey, rateEcoPerKg, quantityMillis, rewardWei };
}

/** ADMIN override: ECO amount string → wei, capped, never from raw wei client input. */
export function parseAdminOverrideWei(amountEcoRaw: string, config = getRewardPolicyConfig()): bigint {
  const wei = ecoAmountToWei(amountEcoRaw);
  if (wei <= 0n) {
    throw Object.assign(new Error("Le montant override doit être strictement positif"), { statusCode: 400 });
  }
  const maxWei = config.maxEcoPerDeclaration * WEI_PER_ECO;
  if (wei > maxWei) {
    throw Object.assign(
      new Error(`Override plafonné à ${config.maxEcoPerDeclaration.toString()} ECO`),
      { statusCode: 400 }
    );
  }
  return wei;
}

/**
 * Normalize API quantity to a decimal string with ≤3 fractional digits.
 * Prefer string input from clients; number is accepted only after toFixed(3) serialization
 * so subsequent wei math never uses JS floats.
 */
export function quantityInputToString(quantity: string | number): string {
  if (typeof quantity === "string") return quantity.trim();
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw Object.assign(new Error("Quantité invalide"), { statusCode: 400 });
  }
  return quantity.toFixed(3).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}
