import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOperatorKeyConfigured } from "./chainReadiness";

describe("chainReadiness — operator key validation", () => {
  it("rejects empty, short, and placeholder keys", () => {
    assert.equal(isOperatorKeyConfigured(""), false);
    assert.equal(isOperatorKeyConfigured("0xYOUR_TESTNET_PRIVATE_KEY"), false);
    assert.equal(isOperatorKeyConfigured("0xabc"), false);
    assert.equal(isOperatorKeyConfigured("not-a-key"), false);
  });

  it("accepts a well-formed 32-byte hex key", () => {
    const key = "0x" + "11".repeat(32);
    assert.equal(isOperatorKeyConfigured(key), true);
  });
});
