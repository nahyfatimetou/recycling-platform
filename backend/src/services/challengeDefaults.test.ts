import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_WEEKLY_TASKS,
  DAY_LABELS_FR,
  mondayOf,
  sundayFromMonday,
  defaultBonusRewardWei,
  defaultTaskRewardWei
} from "./challengeDefaults";

describe("challengeDefaults", () => {
  it("defines exactly 7 daily tasks Monday→Sunday", () => {
    assert.equal(DEFAULT_WEEKLY_TASKS.length, 7);
    assert.deepEqual(
      DEFAULT_WEEKLY_TASKS.map((t) => t.dayOfWeek),
      [1, 2, 3, 4, 5, 6, 7]
    );
    assert.equal(DAY_LABELS_FR[1], "Lundi");
    assert.equal(DAY_LABELS_FR[7], "Dimanche");
  });

  it("computes Monday/Sunday of a known week", () => {
    // Wednesday 5 Nov 2025 UTC → Monday 3 Nov → Sunday 9 Nov
    const monday = mondayOf(new Date("2025-11-05T12:00:00.000Z"));
    assert.equal(monday, "2025-11-03");
    assert.equal(sundayFromMonday(monday), "2025-11-09");
  });

  it("converts default ECO rewards to positive wei", () => {
    assert.equal(defaultTaskRewardWei("2"), (2n * 10n ** 18n).toString());
    assert.equal(defaultBonusRewardWei("10"), (10n * 10n ** 18n).toString());
  });
});
