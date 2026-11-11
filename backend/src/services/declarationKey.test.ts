import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { id, keccak256, toUtf8Bytes } from "ethers";
import { declarationKey, declarationKeyFromKeccak } from "./declarationKey";

describe("declarationKey — cross-stack canonical bytes32", () => {
  it("matches ethers.id(lowercase) and keccak256(utf8)", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    const key = declarationKey(uuid);
    assert.equal(key, id(uuid.toLowerCase()));
    assert.equal(key, keccak256(toUtf8Bytes(uuid.toLowerCase())));
    assert.equal(key, declarationKeyFromKeccak(uuid));
    assert.match(key, /^0x[a-f0-9]{64}$/);
  });

  it("normalizes UUID casing so backend and contracts never diverge", () => {
    const lower = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const upper = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const mixed = "AaAaAaAa-BbBb-CcCc-DdDd-EeEeEeEeEeEe";
    assert.equal(declarationKey(lower), declarationKey(upper));
    assert.equal(declarationKey(lower), declarationKey(mixed));
  });
});
