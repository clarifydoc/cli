import { describe, it, expect } from "vitest";
import { pressureFixLine } from "./overview.js";
import type { FileChurnInfo } from "../../types/analysis.js";

const churnRow = (file: string, lastFix?: string): FileChurnInfo => ({
  file,
  commits: 3,
  additions: 10,
  deletions: 2,
  lastTouched: "2026-09-30T10:00:00Z",
  authors: ["Coach"],
  authorCount: 1,
  ...(lastFix ? { fixes: 1, lastFix } : {}),
});
const pressureRow = (filePath: string, score: number) => ({ filePath, score });

describe("pressureFixLine", () => {
  const files = Array.from({ length: 40 }, (_, i) => `src/league/club${String(i).padStart(2, "0")}.ts`);
  // Clubs 00–03 were fixed in the last six months, club 39 only two years ago.
  const churn = files.map((f, i) => churnRow(f, i < 4 ? "2026-08-01T10:00:00Z" : i === 39 ? "2024-08-01T10:00:00Z" : undefined));
  const pressure = files.slice(0, 12).map((f, i) => pressureRow(f, 90 - i));

  it("counts the top ten that had a recent fix, against the base rate", () => {
    expect(pressureFixLine({ fileChurn: churn, refactorPressure: pressure })).toBe(
      "fixes: 4 of the 10 highest refactor-pressure files had a fix in the last 6 months of history, against 10.0% of the 40 files with history (in-sample: fixes feed the score)",
    );
  });

  it("stays silent with too little history or no recent fix", () => {
    expect(pressureFixLine({ fileChurn: churn.slice(0, 20), refactorPressure: pressure })).toBeNull();
    expect(pressureFixLine({ fileChurn: churn.map((c) => churnRow(c.file)), refactorPressure: pressure })).toBeNull();
    expect(pressureFixLine({ fileChurn: churn, refactorPressure: pressure.slice(0, 5) })).toBeNull();
  });
});
