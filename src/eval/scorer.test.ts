import { describe, it, expect } from "vitest";
import {
  scoreSet,
  rankOf,
  meanReciprocalRank,
  scoreTokens,
  estimateTokens,
  mean,
  poolSetScores,
  scoreSampledLinks,
  type PredictedLink,
} from "./scorer.js";

describe("scoreSet", () => {
  it("separates what was missed from what was invented", () => {
    const s = scoreSet(["a", "b", "x"], ["a", "b", "c"]);
    expect(s.truePositives).toBe(2);
    expect(s.falsePositives).toBe(1);
    expect(s.falseNegatives).toBe(1);
    expect(s.missed).toEqual(["c"]);
    expect(s.spurious).toEqual(["x"]);
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.recall).toBeCloseTo(2 / 3);
    expect(s.f1).toBeCloseTo(2 / 3);
  });

  it("scores a perfect prediction 1 across the board", () => {
    const s = scoreSet(["a", "b"], ["b", "a"]);
    expect(s).toMatchObject({ precision: 1, recall: 1, f1: 1, falsePositives: 0, falseNegatives: 0 });
  });

  it("does not let duplicates inflate the counts", () => {
    // A tool that reports the same link twice has not found it twice.
    const s = scoreSet(["a", "a", "a"], ["a"]);
    expect(s.truePositives).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
  });

  it("calls recall 1 when there was nothing to find", () => {
    // Otherwise 0/0 poisons every mean this repo takes part in.
    expect(scoreSet([], []).recall).toBe(1);
    expect(scoreSet([], []).precision).toBe(1);
    expect(scoreSet([], []).f1).toBe(1);
  });

  it("gives no credit for finding nothing when there was something", () => {
    const s = scoreSet([], ["a", "b"]);
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
    expect(s.missed).toEqual(["a", "b"]);
  });

  it("scores pure invention as zero precision", () => {
    const s = scoreSet(["x", "y"], []);
    expect(s.precision).toBe(0);
    expect(s.recall).toBe(1); // nothing to find, and it found all of it
    expect(s.spurious).toEqual(["x", "y"]);
  });
});

describe("rankOf / meanReciprocalRank", () => {
  const hitsPath = (p: string) => (result: string) => result.includes(p);

  it("reports a 1-based rank and its reciprocal", () => {
    const results = ["miss.ts:1", "miss.ts:2", "target.ts:30"];
    expect(rankOf("q", results, hitsPath("target.ts:30"))).toEqual({
      query: "q",
      rank: 3,
      reciprocalRank: 1 / 3,
    });
  });

  it("scores a miss 0, not 1/∞", () => {
    // Rank 0 reads as "never appeared" in the report; 1/Infinity would be the
    // same number saying something different.
    const r = rankOf("q", ["a", "b"], hitsPath("nope"));
    expect(r.rank).toBe(0);
    expect(r.reciprocalRank).toBe(0);
  });

  it("takes the first acceptable hit when several match", () => {
    expect(rankOf("q", ["t.ts:1", "t.ts:1"], hitsPath("t.ts:1")).rank).toBe(1);
  });

  it("averages reciprocal ranks", () => {
    const results = [
      { query: "a", rank: 1, reciprocalRank: 1 },
      { query: "b", rank: 2, reciprocalRank: 0.5 },
      { query: "c", rank: 0, reciprocalRank: 0 },
    ];
    expect(meanReciprocalRank(results)).toBeCloseTo(0.5);
  });

  it("scores an empty query set 0 — no evidence is not success", () => {
    expect(meanReciprocalRank([])).toBe(0);
  });
});

describe("scoreTokens", () => {
  it("reports the saving as a percentage", () => {
    const s = scoreTokens(250, 1000);
    expect(s.ratio).toBeCloseTo(0.25);
    expect(s.reductionPercent).toBeCloseTo(75);
  });

  it("reports a negative saving when the tool cost more", () => {
    expect(scoreTokens(2000, 1000).reductionPercent).toBeCloseTo(-100);
  });

  it("does not divide by zero when there was no source to read", () => {
    expect(scoreTokens(10, 0).ratio).toBe(1);
  });
});

describe("estimateTokens", () => {
  it("rounds up, so a non-empty string never costs zero", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("12345678")).toBe(2);
  });
});

describe("poolSetScores", () => {
  it("weights each repo by its evidence, not equally", () => {
    // One repo with a single label and one with a hundred. Averaging the two
    // precisions would give 0.5; pooling gives the honest 0.99.
    const tiny = scoreSet(["wrong"], ["right"]);
    const big = scoreSet(
      Array.from({ length: 99 }, (_, i) => `k${i}`),
      Array.from({ length: 99 }, (_, i) => `k${i}`),
    );
    const pooled = poolSetScores([tiny, big]);
    expect(pooled.truePositives).toBe(99);
    expect(pooled.falsePositives).toBe(1);
    expect(pooled.precision).toBeCloseTo(0.99);
    expect(mean([tiny.precision, big.precision])).toBeCloseTo(0.5); // the wrong way
  });

  it("keeps every missed key so the report can name them", () => {
    const pooled = poolSetScores([scoreSet([], ["a"]), scoreSet([], ["b"])]);
    expect(pooled.missed.sort()).toEqual(["a", "b"]);
    expect(pooled.recall).toBe(0);
  });

  it("is 1 across the board for an empty list of scores", () => {
    expect(poolSetScores([])).toMatchObject({ precision: 1, recall: 1, f1: 1 });
  });
});

describe("mean", () => {
  it("averages, and treats empty as 0", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBe(0);
  });
});

describe("scoreSampledLinks", () => {
  const p = (over: Partial<PredictedLink>): PredictedLink => ({
    source: "web/api.ts",
    sourceLine: 1,
    target: "srv/Ctl.cs",
    targetLine: 20,
    matchedVia: "exact",
    confidence: "EXTRACTED",
    ...over,
  });

  it("accepts a route anchored on an attribute a few lines above the handler", () => {
    const s = scoreSampledLinks([p({ targetLine: 17 })], [
      { source: "web/api.ts", sourceLine: 1, targets: [{ file: "srv/Ctl.cs", line: 20 }] },
    ]);
    expect(s).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0, precision: 1, recall: 1 });
  });

  it("does not accept a line after the handler or outside the window", () => {
    const s = scoreSampledLinks([p({ targetLine: 21 }), p({ sourceLine: 2, targetLine: 5 })], [
      { source: "web/api.ts", sourceLine: 1, targets: [{ file: "srv/Ctl.cs", line: 20 }] },
      { source: "web/api.ts", sourceLine: 2, targets: [{ file: "srv/Ctl.cs", line: 20 }] },
    ]);
    expect(s).toMatchObject({ truePositives: 0, falsePositives: 2, falseNegatives: 2 });
  });

  it("counts a wrong link against precision and recall both", () => {
    const s = scoreSampledLinks([p({ target: "srv/Other.cs" })], [
      { source: "web/api.ts", sourceLine: 1, targets: [{ file: "srv/Ctl.cs", line: 20 }] },
    ]);
    expect(s).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 1, precision: 0, recall: 0 });
  });

  it("credits a landing on an accepted twin, such as the OpenAPI row for the same endpoint", () => {
    const s = scoreSampledLinks([p({ target: "openapi.json", targetLine: 400 })], [
      {
        source: "web/api.ts",
        sourceLine: 1,
        targets: [{ file: "srv/Ctl.cs", line: 20, accept: [{ file: "openapi.json", line: 401 }] }],
      },
    ]);
    expect(s.truePositives).toBe(1);
  });

  it("scores a must-not-link call: silence is a TN, any link an FP", () => {
    const s = scoreSampledLinks([p({ sourceLine: 2 })], [
      { source: "web/api.ts", sourceLine: 1, targets: [] },
      { source: "web/api.ts", sourceLine: 2, targets: [] },
    ]);
    expect(s).toMatchObject({ trueNegatives: 1, falsePositives: 1, truePositives: 0, falseNegatives: 0 });
  });

  it("scores a fanned-out call target by target", () => {
    const s = scoreSampledLinks([p({ target: "a.py", targetLine: 3 }), p({ target: "c.py", targetLine: 3 })], [
      {
        source: "web/api.ts",
        sourceLine: 1,
        targets: [
          { file: "a.py", line: 3 },
          { file: "b.py", line: 3 },
        ],
      },
    ]);
    expect(s).toMatchObject({ truePositives: 1, falseNegatives: 1, falsePositives: 1 });
  });

  it("ignores links from calls nobody labelled", () => {
    const s = scoreSampledLinks([p({ sourceLine: 99, target: "x" })], [
      { source: "web/api.ts", sourceLine: 1, targets: [{ file: "srv/Ctl.cs", line: 20 }] },
    ]);
    expect(s).toMatchObject({ truePositives: 0, falsePositives: 0, falseNegatives: 1 });
  });

  it("breaks results down by matching tier", () => {
    const s = scoreSampledLinks(
      [p({}), p({ sourceLine: 2, target: "wrong.cs", matchedVia: "base-prefix:/api", confidence: "INFERRED" })],
      [
        { source: "web/api.ts", sourceLine: 1, targets: [{ file: "srv/Ctl.cs", line: 20 }] },
        { source: "web/api.ts", sourceLine: 2, targets: [{ file: "srv/Ctl.cs", line: 40 }] },
      ],
    );
    expect(s.byTier).toEqual({ exact: { tp: 1, fp: 0 }, "base-prefix:/api": { tp: 0, fp: 1 } });
    expect(s.byConfidence).toEqual({ EXTRACTED: { tp: 1, fp: 0 }, INFERRED: { tp: 0, fp: 1 } });
  });
});
