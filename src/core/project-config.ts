import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Project-local ClarifyDoc configuration: `<projectRoot>/.clarifydoc/config.json`.
 *
 * Kept next to the analysis and the `.clarifydoc/ignore` file, so a team can
 * commit the map of how ITS codebase should be read (scoring thresholds,
 * later: architecture layers) the way it commits `tsconfig.json`. Everything
 * is optional; a missing file means defaults. Malformed input never fails an
 * analysis — it is reported as a warning and ignored.
 *
 * Sections are consumed by their owners: `refactorPressure` by
 * `refactor-pressure.ts` (`resolveRefactorPressureConfig`). Add a section by
 * adding its key to `KNOWN_SECTIONS` and typing it here.
 */

export const PROJECT_CONFIG_RELATIVE_PATH = ".clarifydoc/config.json";

/** Deep partial of a config shape — every leaf optional. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface RefactorPressureConfigInput {
  weights?: Partial<Record<"complexity" | "size" | "responsibility" | "coupling" | "churn", number>>;
  ceilings?: Partial<
    Record<
      | "maxCognitive" | "totalCognitive" | "nestingDepth" | "maxCyclomatic" | "totalCyclomatic"
      | "loc" | "concerns" | "fanIn" | "fanOut" | "layerViolations" | "commits" | "authors",
      number
    >
  >;
  bands?: Partial<Record<"observe" | "suggest" | "strong" | "urgent", number>>;
  gates?: Partial<
    Record<
      | "godClassLoc" | "godClassCognitive" | "concernOverload" | "hubFanIn" | "hubFanOut"
      | "churnHotspotPercentile" | "churnHotspotMinCommits" | "churnHotspotComplexity",
      number
    >
  >;
  /** A component sub-score above this (0–100) is reported as a driver. */
  driverThreshold?: number;
}

export interface ProjectConfig {
  /** Free-form; ignored by the tool. Lets a team note why thresholds were changed. */
  $comment?: string;
  refactorPressure?: RefactorPressureConfigInput;
}

const KNOWN_SECTIONS: ReadonlySet<string> = new Set(["$comment", "$schema", "refactorPressure"]);

export interface LoadedProjectConfig {
  config: ProjectConfig;
  /** Absolute path of the file that was read, or null when none exists. */
  path: string | null;
  warnings: string[];
}

/** Read and loosely validate the project config. Never throws. */
export function loadProjectConfig(projectRoot: string): LoadedProjectConfig {
  const path = join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH);
  if (!existsSync(path)) return { config: {}, path: null, warnings: [] };

  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return { config: {}, path, warnings: [`${PROJECT_CONFIG_RELATIVE_PATH}: not valid JSON (${(err as Error).message}); using defaults`] };
  }
  if (!isPlainObject(parsed)) {
    return { config: {}, path, warnings: [`${PROJECT_CONFIG_RELATIVE_PATH}: expected a JSON object; using defaults`] };
  }

  const config: ProjectConfig = {};
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_SECTIONS.has(key)) warnings.push(`${PROJECT_CONFIG_RELATIVE_PATH}: unknown section "${key}" ignored`);
  }
  if (parsed.refactorPressure !== undefined) {
    if (isPlainObject(parsed.refactorPressure)) {
      config.refactorPressure = parsed.refactorPressure as RefactorPressureConfigInput;
    } else {
      warnings.push(`${PROJECT_CONFIG_RELATIVE_PATH}: "refactorPressure" must be an object; ignored`);
    }
  }
  return { config, path, warnings };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Overlay user-supplied numbers onto a defaults record. Non-finite or
 * negative values and unknown keys are skipped with a warning naming the
 * section, so one typo cannot silently zero a weight.
 */
export function overlayNumbers<T extends Record<string, number>>(
  section: string,
  defaults: T,
  input: Partial<Record<string, unknown>> | undefined,
  warn: (msg: string) => void,
): T {
  if (!input) return { ...defaults };
  const out: Record<string, number> = { ...defaults };
  for (const [k, v] of Object.entries(input)) {
    if (!(k in defaults)) {
      warn(`${section}: unknown key "${k}" ignored`);
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      warn(`${section}.${k}: expected a non-negative number, got ${JSON.stringify(v)}; default kept`);
      continue;
    }
    out[k] = v;
  }
  return out as T;
}
