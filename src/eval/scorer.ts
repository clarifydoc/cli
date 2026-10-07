/**
 * Scoring math for the accuracy eval (`eval/`).
 *
 * This lives in `src/` rather than next to the harness scripts for one reason:
 * it is the part that must be *right*. A benchmark that quietly computes recall
 * as precision produces a number nobody can catch by eye, and the whole point
 * of the eval is that its numbers are trustworthy. Here it is typechecked and
 * unit-tested by the same CI gate as the extractors.
 *
 * Everything below is pure: no I/O, no analysis types, no knowledge of what a
 * "link" or a "route" is. Benchmarks reduce their domain objects to keys and
 * hand them over.
 */

/** Precision / recall / F1 over two sets of opaque keys. */
export interface SetScore {
  /** Labelled items the tool also found. */
  truePositives: number;
  /** Items the tool reported that are not in the labels. */
  falsePositives: number;
  /** Labelled items the tool missed. */
  falseNegatives: number;
  /** tp / (tp + fp) — of what it reported, how much was right. 1 when it reported nothing. */
  precision: number;
  /** tp / (tp + fn) — of what is true, how much it found. 1 when there is nothing to find. */
  recall: number;
  /** Harmonic mean; 0 when precision and recall are both 0. */
  f1: number;
  /** The actual keys, so a report can name what was missed instead of only counting it. */
  missed: string[];
  spurious: string[];
}

/**
 * Score a predicted set against a labelled set.
 *
 * Both degenerate cases return 1 rather than 0 or NaN: a tool that reports
 * nothing when there is nothing to report is correct, and dividing by zero
 * would otherwise poison the mean across repos.
 */
export function scoreSet(predicted: Iterable<string>, labelled: Iterable<string>): SetScore {
  const pred = new Set(predicted);
  const truth = new Set(labelled);

  const missed = [...truth].filter((k) => !pred.has(k)).sort();
  const spurious = [...pred].filter((k) => !truth.has(k)).sort();
  const truePositives = pred.size - spurious.length;

  const precision = pred.size === 0 ? 1 : truePositives / pred.size;
  const recall = truth.size === 0 ? 1 : truePositives / truth.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    truePositives,
    falsePositives: spurious.length,
    falseNegatives: missed.length,
    precision,
    recall,
    f1,
    missed,
    spurious,
  };
}

/** One search query's outcome: where in the ranking the expected answer appeared. */
export interface RankResult {
  query: string;
  /** 1-based rank of the first acceptable hit, or 0 when it never appeared. */
  rank: number;
  /** 1/rank, or 0 for a miss. */
  reciprocalRank: number;
}

/**
 * Rank of the first result the label accepts, as Mean Reciprocal Rank's input.
 *
 * `results` is the ranked list exactly as the agent receives it; `accepts`
 * decides whether one of them is the answer. Rank 0 means "not found at any
 * rank", which scores 0 — not `1/∞`, which would be the same number but says
 * something different in a report.
 */
export function rankOf(query: string, results: readonly string[], accepts: (result: string) => boolean): RankResult {
  const index = results.findIndex(accepts);
  const rank = index === -1 ? 0 : index + 1;
  return { query, rank, reciprocalRank: rank === 0 ? 0 : 1 / rank };
}

/**
 * Mean Reciprocal Rank: the average of 1/rank across queries.
 *
 * 1.0 means every query's answer was the top hit; 0.5 means it was typically
 * second. An empty query set scores 0, not 1 — no evidence is not success.
 */
export function meanReciprocalRank(results: readonly RankResult[]): number {
  if (results.length === 0) return 0;
  return results.reduce((sum, r) => sum + r.reciprocalRank, 0) / results.length;
}

/** What an agent paid to get an answer, one way versus the other. */
export interface TokenScore {
  /** Tokens in the answer the MCP tool returned. */
  viaTool: number;
  /** Tokens in the source an agent would otherwise have had to read. */
  viaSource: number;
  /** viaTool / viaSource. Below 1 means the tool was cheaper. */
  ratio: number;
  /** Percentage saved, negative when the tool cost more. */
  reductionPercent: number;
}

export function scoreTokens(viaTool: number, viaSource: number): TokenScore {
  const ratio = viaSource === 0 ? 1 : viaTool / viaSource;
  return {
    viaTool,
    viaSource,
    ratio,
    reductionPercent: (1 - ratio) * 100,
  };
}

/**
 * Token estimate, deliberately crude and deliberately shared.
 *
 * ~4 characters per token is the usual rule of thumb for English prose and
 * code. It is wrong in the third digit, which does not matter: both sides of
 * the ratio are measured the same way, so the *comparison* survives an estimate
 * that a real tokenizer would move by a few percent. Pulling in a tokenizer
 * dependency to sharpen a number nobody reads absolutely would cost more than
 * it is worth — but if that changes, changing it here changes both sides at
 * once, which is the reason this is a function and not an inline `/ 4`.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Arithmetic mean, or 0 for an empty list. Used to roll repo scores up. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate several set scores by pooling their counts rather than averaging
 * their ratios.
 *
 * Averaging per-repo precision lets a repo with three labels swing the total as
 * hard as one with three hundred. Pooling the raw tp/fp/fn counts weights each
 * repo by how much evidence it actually carries.
 */
export function poolSetScores(scores: readonly SetScore[]): SetScore {
  const truePositives = scores.reduce((n, s) => n + s.truePositives, 0);
  const falsePositives = scores.reduce((n, s) => n + s.falsePositives, 0);
  const falseNegatives = scores.reduce((n, s) => n + s.falseNegatives, 0);

  const predicted = truePositives + falsePositives;
  const actual = truePositives + falseNegatives;
  const precision = predicted === 0 ? 1 : truePositives / predicted;
  const recall = actual === 0 ? 1 : truePositives / actual;

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    missed: scores.flatMap((s) => s.missed),
    spurious: scores.flatMap((s) => s.spurious),
  };
}

// ─── Sampled cross-tier links ────────────────────────────────────────────────

/**
 * A place in the source a label points at. `line` is the handler's declaration
 * line as a human reads it; a tool may anchor a route on an attribute or
 * decorator stacked above it, so `line` accepts the `window` lines before it
 * too. `lines` overrides that with an explicit inclusive range.
 */
export interface LabelLocation {
  file: string;
  line: number;
  lines?: readonly [number, number];
}

/** One route a labelled call reaches, plus equally right places to land (an API contract's twin row). */
export interface LabelTarget extends LabelLocation {
  accept?: readonly LabelLocation[];
}

/**
 * One frontend call, read by hand. `targets` is every route it reaches — one
 * for an ordinary call, several for a call in a base class that each subclass
 * aims elsewhere, and none for a call that must NOT link (a test mock, a
 * third-party URL, a call ClarifyDoc once linked wrongly).
 */
export interface SampledCallLabel {
  source: string;
  sourceLine: number;
  targets: readonly LabelTarget[];
}

export interface PredictedLink {
  source: string;
  sourceLine: number;
  target: string;
  targetLine: number;
  matchedVia?: string;
  confidence?: string;
}

export interface SampledLinkOutcome {
  call: string;
  /** What landed where: `tp` right, `fp` landed somewhere unlabelled, `fn` missing, `tn` correctly unlinked. */
  outcome: "tp" | "fp" | "fn" | "tn";
  /** Where the tool landed (tp / fp) or where it should have (fn). */
  at: string;
  matchedVia?: string;
  confidence?: string;
}

export interface SampledLinkScore {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Must-not-link calls the tool rightly left alone. */
  trueNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  /** tp / fp per matching tier — the evidence for keeping or killing a tier. */
  byTier: Record<string, { tp: number; fp: number }>;
  byConfidence: Record<string, { tp: number; fp: number }>;
  outcomes: SampledLinkOutcome[];
}

function within(loc: LabelLocation, file: string, line: number, window: number): boolean {
  if (loc.file !== file) return false;
  const [lo, hi] = loc.lines ?? [loc.line - window, loc.line];
  return line >= lo && line <= hi;
}

/**
 * Score links against a SAMPLE of hand-labelled calls.
 *
 * `scoreSet` needs labels that cover the whole repo (`complete: true`), which
 * is fine for a 23-call RealWorld frontend and impossible for a 400-call one.
 * Here only the labelled calls are scored: whatever the tool linked from a
 * labelled `source:sourceLine` is compared with that call's targets, and every
 * other link in the repo is out of scope — neither credit nor blame.
 *
 * Per call: each target matched by a link is a TP; each target nothing landed
 * on is an FN; each link that landed on none of them is an FP (so a wrong link
 * counts against both precision and recall). A must-not-link call with no link
 * is a TN, which is reported but, like every TN, moves neither ratio.
 */
export function scoreSampledLinks(
  predicted: readonly PredictedLink[],
  labels: readonly SampledCallLabel[],
  { window = 8 }: { window?: number } = {},
): SampledLinkScore {
  const bySite = new Map<string, PredictedLink[]>();
  for (const p of predicted) {
    const key = `${p.source}:${p.sourceLine}`;
    (bySite.get(key) ?? bySite.set(key, []).get(key)!).push(p);
  }

  const outcomes: SampledLinkOutcome[] = [];
  const byTier: Record<string, { tp: number; fp: number }> = {};
  const byConfidence: Record<string, { tp: number; fp: number }> = {};
  const tally = (p: PredictedLink, kind: "tp" | "fp") => {
    const tier = p.matchedVia ?? "exact";
    (byTier[tier] ??= { tp: 0, fp: 0 })[kind]++;
    const conf = p.confidence ?? "unknown";
    (byConfidence[conf] ??= { tp: 0, fp: 0 })[kind]++;
  };

  for (const label of labels) {
    const call = `${label.source}:${label.sourceLine}`;
    const links = [...(bySite.get(call) ?? [])];
    if (label.targets.length === 0 && links.length === 0) {
      outcomes.push({ call, outcome: "tn", at: "" });
      continue;
    }
    for (const t of label.targets) {
      const places = [t, ...(t.accept ?? [])];
      const hit = links.findIndex((p) => places.some((loc) => within(loc, p.target, p.targetLine, window)));
      if (hit === -1) {
        outcomes.push({ call, outcome: "fn", at: `${t.file}:${t.line}` });
        continue;
      }
      const [p] = links.splice(hit, 1);
      tally(p, "tp");
      outcomes.push({ call, outcome: "tp", at: `${p.target}:${p.targetLine}`, matchedVia: p.matchedVia, confidence: p.confidence });
    }
    for (const p of links) {
      tally(p, "fp");
      outcomes.push({ call, outcome: "fp", at: `${p.target}:${p.targetLine}`, matchedVia: p.matchedVia, confidence: p.confidence });
    }
  }

  const count = (k: SampledLinkOutcome["outcome"]) => outcomes.filter((o) => o.outcome === k).length;
  const truePositives = count("tp");
  const falsePositives = count("fp");
  const falseNegatives = count("fn");
  const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives: count("tn"),
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    byTier,
    byConfidence,
    outcomes,
  };
}
