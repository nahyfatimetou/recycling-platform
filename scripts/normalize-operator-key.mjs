/**
 * Normalize Hedera/MetaMask operator private key formats into 0x+64 hex.
 * Never prints the private key. Optionally rewrites backend/.env in place.
 *
 * Usage:
 *   node scripts/normalize-operator-key.mjs
 *   node scripts/normalize-operator-key.mjs --write
 */
import fs from "fs";
import { Wallet } from "ethers";

const write = process.argv.includes("--write");
const envPath = new URL("../backend/.env", import.meta.url);
const text = fs.readFileSync(envPath, "utf8");
const match = text.match(/^BACKEND_OPERATOR_PRIVATE_KEY=(.*)$/m);
if (!match) {
  console.error("BACKEND_OPERATOR_PRIVATE_KEY line missing");
  process.exit(1);
}

let raw = match[1].trim().replace(/^["']|["']$/g, "");
const expectedMatch = text.match(/^OPERATOR_EVM_ADDRESS=(.*)$/m);
const expected = (expectedMatch?.[1] || "").trim().toLowerCase();

function candidatesFrom(value) {
  const out = new Set();
  let v = value.trim();
  if (/^0x/i.test(v)) v = v.slice(2);
  v = v.replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]+$/.test(v)) return [];

  if (v.length === 64) out.add("0x" + v.toLowerCase());

  // DER OCTET STRING of 32 bytes: ...0420<64 hex>
  const octet = [...v.matchAll(/0420([0-9a-fA-F]{64})/gi)];
  for (const m of octet) out.add("0x" + m[1].toLowerCase());

  // Trailing 32-byte key (common for Hedera ECDSA DER hex dumps)
  if (v.length > 64) out.add("0x" + v.slice(-64).toLowerCase());

  return [...out];
}

const candidates = candidatesFrom(raw);
const results = [];
for (const key of candidates) {
  try {
    const wallet = new Wallet(key);
    results.push({
      address: wallet.address,
      matchesExpected: expected ? wallet.address.toLowerCase() === expected : null
    });
  } catch {
    // ignore invalid candidates
  }
}

const hit = results.find((r) => r.matchesExpected) || (results.length === 1 ? results[0] : null);

console.log(
  JSON.stringify(
    {
      inputLength: raw.replace(/^0x/i, "").length,
      candidateCount: candidates.length,
      derivedAddresses: results.map((r) => r.address),
      expectedAddress: expected || null,
      matched: Boolean(hit && (hit.matchesExpected || hit.matchesExpected === null)),
      matchedAddress: hit?.address || null
    },
    null,
    2
  )
);

if (!hit) {
  console.error(
    "\nCould not derive a valid EVM key matching OPERATOR_EVM_ADDRESS.\nExport the ECDSA private key again, or use MetaMask Account details → export private key for 0x59b9…f132."
  );
  process.exit(1);
}

if (!write) {
  console.log("\nDry-run OK. Re-run with --write to save normalized 0x+64 key into backend/.env");
  process.exit(0);
}

// Rebuild normalized key for the matched address only (recompute from candidates)
let normalized = null;
for (const key of candidates) {
  try {
    const wallet = new Wallet(key);
    if (wallet.address.toLowerCase() === hit.address.toLowerCase()) {
      normalized = key;
      break;
    }
  } catch {
    // continue
  }
}

if (!normalized) {
  console.error("Internal error: matched address but lost normalized key");
  process.exit(1);
}

const next = text.replace(
  /^BACKEND_OPERATOR_PRIVATE_KEY=.*$/m,
  `BACKEND_OPERATOR_PRIVATE_KEY=${normalized}`
);
fs.writeFileSync(envPath, next, "utf8");
console.log("\nNormalized operator key written to backend/.env (0x + 64 hex). Key not printed.");
