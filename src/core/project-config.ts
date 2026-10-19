import { parseSecurityConfig, type SecurityConfig } from "./security-rules.js";
import { validateExtract, type ExtractPatterns } from "./config-patterns.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { ArchLayer } from "../types/analysis.js";
import { fnmatch } from "./clarifydoc-ignore.js";
import { trimTrailingSlashes } from "../extractors/plugins/shared/path-utils.js";

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
 * `refactor-pressure.ts` (`resolveRefactorPressureConfig`); `layers`,
 * `exempt` and `generated` by `layer-analyzer.ts` / the analyzer through
 * `resolveArchitectureOverrides`. Add a section by adding its key to
 * `KNOWN_SECTIONS` and typing it here.
 *
 * Glob patterns follow the ignore-file dialect (`*`, `**`, `?`, `[abc]`) and
 * are matched against the posix project-relative path. Anchoring works as it
 * does in gitignore: a pattern carrying a `/` is fixed to the project root,
 * while a slash-less one (`*.generated.ts`, `dist`) also matches the bare file
 * name at any depth.
 */

export const PROJECT_CONFIG_RELATIVE_PATH = ".clarifydoc/config.json";

/** Deep partial of a config shape — every leaf optional. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/**
 * The `refactorPressure` section of `.clarifydoc/config.json`: partial
 * overrides of the weights, ceilings, bands and gates in
 * `DEFAULT_REFACTOR_PRESSURE_CONFIG`. Unknown keys and bad numbers are
 * warned about and ignored, never fatal.
 */
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

/** One architecture-layer assignment: files matching any pattern belong to `layer`. */
export interface LayerRuleInput {
  layer: ArchLayer;
  patterns: string[];
  /** Optional note for the team; ignored by the tool. */
  description?: string;
}

/**
 * A team's own dependency rule: files matching `from` must not import files
 * matching `to` (`features/billing/**` must not import `features/payroll/**`).
 * `except` lifts it for the files it names on either side.
 */
export interface DependencyRuleInput {
  name: string;
  from: string[];
  to: string[];
  except?: string[];
  /** How a breach is reported; `error` by default. */
  severity?: "error" | "warn";
  /** Optional note for the team; ignored by the tool. */
  description?: string;
}

/**
 * The shape of `.clarifydoc/config.json`, a team's hand-written overrides for
 * the quality analyses. Every section is optional; globs are project-relative
 * (see the module comment for the dialect).
 */
export interface ProjectConfig {
  /** Free-form; ignored by the tool. Lets a team note why thresholds were changed. */
  $comment?: string;
  refactorPressure?: RefactorPressureConfigInput;
  /**
   * Explicit layer assignments, checked in order before the path heuristics.
   * Names must be the built-in layers: ui, components, services, data, utils,
   * config (test and unknown are accepted but rarely useful).
   */
  layers?: LayerRuleInput[];
  /** Paths outside the layered application (tooling, scripts, prototypes): never a violation source or target. */
  exempt?: string[];
  /** Generated code: excluded from every quality signal (patterns, duplicates, violations, pressure, health). */
  generated?: string[];
  /** The team's own import rules, checked over the dependency graph and reported as layer violations. */
  rules?: DependencyRuleInput[];
  /** What the team's own wrappers mean: HTTP clients, route registrars, database helpers (core/config-patterns.ts). */
  extract?: ExtractPatterns;
  /** Security rules turned off or re-graded, by rule id (core/security-rules.ts). */
  security?: SecurityConfig;
}

const KNOWN_SECTIONS: ReadonlySet<string> = new Set([
  "$comment", "$schema", "refactorPressure", "layers", "exempt", "generated", "rules", "extract", "security",
]);

const ARCH_LAYERS: ReadonlySet<string> = new Set<ArchLayer>([
  "ui", "components", "services", "data", "utils", "config", "test", "unknown",
]);

/** A read config together with where it came from and what was wrong with it. */
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
  if (parsed.layers !== undefined) {
    if (!Array.isArray(parsed.layers)) {
      warnings.push(`${PROJECT_CONFIG_RELATIVE_PATH}: "layers" must be an array; ignored`);
    } else {
      const rules: LayerRuleInput[] = [];
      parsed.layers.forEach((rule, i) => {
        if (!isPlainObject(rule) || typeof rule.layer !== "string" || !ARCH_LAYERS.has(rule.layer)) {
          warnings.push(`${PROJECT_CONFIG_RELATIVE_PATH}: layers[${i}] needs a "layer" of ${[...ARCH_LAYERS].join("|")}; ignored`);
          return;
        }
        const patterns = stringList(rule.patterns);
        if (patterns.length === 0) {
          warnings.push(`${PROJECT_CONFIG_RELATIVE_PATH}: layers[${i}] (${rule.layer}) has no string "patterns"; ignored`);
          return;
        }
        rules.push({ layer: rule.layer as ArchLayer, patterns });
      });
      config.layers = rules;
    }
  }
  if (parsed.security !== undefined) {
    const got = parseSecurityConfig(parsed.security, PROJECT_CONFIG_RELATIVE_PATH);
    config.security = got.config;
    warnings.push(...got.warnings);
  }
  if (parsed.rules !== undefined) {
    if (!Array.isArray(parsed.rules)) {
      warnings.push(`${PROJECT_CONFIG_RELATIVE_PATH}: "rules" must be an array; ignored`);
    } else {
      const rules: DependencyRuleInput[] = [];
      parsed.rules.forEach((rule, i) => {
        const globs = (v: unknown): string[] => (typeof v === "string" && v.trim() ? [v] : stringList(v));
        if (!isPlainObject(rule) || typeof rule.name !== "string" || !rule.name.trim()) {
          warnings.push(`${PROJECT_CONFIG_RELATIVE_PATH}: rules[${i}] needs a "name"; ignored`);
          return;
        }
        const from = globs(rule.from);
        const to = globs(rule.to);
        if (from.length === 0 || to.length === 0) {
          warnings.push(`${PROJECT_CONFIG_RELATIVE_PATH}: rules[${i}] (${rule.name}) needs "from" and "to" globs; ignored`);
          return;
        }
        const severity = rule.severity === "warn" ? "warn" : "error";
        if (rule.severity !== undefined && rule.severity !== "warn" && rule.severity !== "error") {
          warnings.push(`${PROJECT_CONFIG_RELATIVE_PATH}: rules[${i}] (${rule.name}) severity must be "error" or "warn"; using "error"`);
        }
        const except = globs(rule.except);
        rules.push({ name: rule.name, from, to, ...(except.length ? { except } : {}), severity });
      });
      config.rules = rules;
    }
  }
  const extract = validateExtract(parsed.extract, (m) => warnings.push(`${PROJECT_CONFIG_RELATIVE_PATH}: ${m}`));
  if (extract) config.extract = extract;
  for (const key of ["exempt", "generated"] as const) {
    if (parsed[key] === undefined) continue;
    const list = stringList(parsed[key]);
    if (!Array.isArray(parsed[key]) || list.length !== (parsed[key] as unknown[]).length) {
      warnings.push(`${PROJECT_CONFIG_RELATIVE_PATH}: "${key}" must be an array of glob strings; non-strings ignored`);
    }
    config[key] = list;
  }
  return { config, path, warnings };
}

/** The non-blank strings of an array-valued config field; anything else → empty. */
function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

/** Validated architecture overrides, ready for `classifyFileLayers` and the generated-code filter. */
export interface ArchitectureOverrides {
  layers: Array<{ layer: ArchLayer; patterns: string[] }>;
  exempt: string[];
  generated: string[];
  rules: Array<Required<Pick<DependencyRuleInput, "name" | "from" | "to" | "severity">> & { except: string[] }>;
}

/**
 * Normalize the config's layer, exempt and generated globs to posix form so
 * the layer classifier and the generated-code filter can match them.
 *
 * @param config - A loaded (already validated) project config
 * @returns The three glob lists, empty when the config has none
 */
export function resolveArchitectureOverrides(config: ProjectConfig): ArchitectureOverrides {
  return {
    layers: (config.layers ?? []).map((r) => ({ layer: r.layer, patterns: r.patterns.map(normalizeGlob) })),
    exempt: (config.exempt ?? []).map(normalizeGlob),
    generated: (config.generated ?? []).map(normalizeGlob),
    rules: (config.rules ?? []).map((r) => ({
      name: r.name,
      from: r.from.map(normalizeGlob),
      to: r.to.map(normalizeGlob),
      except: (r.except ?? []).map(normalizeGlob),
      severity: r.severity ?? "error",
    })),
  };
}

/**
 * Posix separators. The leading `/` is KEPT: patterns are project-relative
 * either way, but the slash is what says the pattern is anchored, and dropping
 * it here would leave `matchesAnyGlob` unable to tell `/dist` from `dist`.
 */
function normalizeGlob(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/");
}

/**
 * Does a project-relative posix path match any of the (normalized) globs?
 * A pattern with no `/` in it is unanchored, so it is matched against the bare
 * file name as well, the way gitignore treats `*.generated.ts`. One that does
 * carry a `/` is anchored to the project root and gets no such fallback.
 */
export function matchesAnyGlob(filePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const path = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const base = path.slice(path.lastIndexOf("/") + 1);
  for (const pat of patterns) {
    // A trailing `/` marks a directory; it must not count as the interior
    // slash that anchors, so it comes off before the anchoring test.
    const trimmed = trimTrailingSlashes(pat);
    const anchored = trimmed.includes("/");
    const glob = trimmed.replace(/^\/+/, "");
    if (!glob) continue;
    if (fnmatch(path, glob)) return true;
    if (!anchored && fnmatch(base, glob)) return true;
  }
  return false;
}

/** Narrow an unknown JSON value to a non-array object. */
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
