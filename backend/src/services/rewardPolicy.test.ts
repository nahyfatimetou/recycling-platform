import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WEI_PER_ECO,
  computeRewardWei,
  ecoAmountToWei,
  normalizeMaterial,
  parseAdminOverrideWei,
  quantityKgToMillis,
  quantityInputToString,
  weiToEcoString
} from "./rewardPolicy";

describe("rewardPolicy — integer wei math", () => {
  it("computes 2.5 kg plastic = 30 ECO exactly", () => {
    const { rewardWei, materialKey, rateEcoPerKg } = computeRewardWei("plastic", "2.5");
    assert.equal(materialKey, "plastic");
    assert.equal(rateEcoPerKg, 12);
    assert.equal(rewardWei, 30n * WEI_PER_ECO);
    assert.equal(weiToEcoString(rewardWei), "30");
  });

  it("maps French aliases", () => {
    assert.equal(normalizeMaterial("Plastique"), "plastic");
    assert.equal(normalizeMaterial("verre"), "glass");
    assert.equal(normalizeMaterial("électronique"), "electronic");
    assert.equal(normalizeMaterial("inconnu-xyz"), "other");
  });

  it("uses catalog rates", () => {
    assert.equal(computeRewardWei("aluminum", "1").rewardWei, 18n * WEI_PER_ECO);
    assert.equal(computeRewardWei("electronic", "1").rewardWei, 25n * WEI_PER_ECO);
    assert.equal(computeRewardWei("organic", "1").rewardWei, 2n * WEI_PER_ECO);
  });

  it("rejects quantity below 0.1 kg", () => {
    assert.throws(() => computeRewardWei("plastic", "0.09"), /Quantité minimale/);
  });

  it("rejects reward above 1000 ECO cap", () => {
    // 100 kg plastic = 1200 ECO > 1000
    assert.throws(() => computeRewardWei("plastic", "100"), /plafond/);
  });

  it("accepts quantity at exactly 0.1 kg", () => {
    const { rewardWei } = computeRewardWei("paper", "0.1");
    // 0.1 * 5 = 0.5 ECO
    assert.equal(rewardWei, ecoAmountToWei("0.5"));
  });

  it("parses quantity millis without floats", () => {
    assert.equal(quantityKgToMillis("2.5"), 2500n);
    assert.equal(quantityKgToMillis("0.1"), 100n);
    assert.equal(quantityInputToString("1.250"), "1.250");
  });

  it("bounds ADMIN override to 1000 ECO", () => {
    assert.equal(parseAdminOverrideWei("30"), 30n * WEI_PER_ECO);
    assert.throws(() => parseAdminOverrideWei("1000.1"), /plafonné/);
    assert.throws(() => parseAdminOverrideWei("0"), /positif/);
  });
});
