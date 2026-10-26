import type { FileAnalysis, ArchLayer, Language, LayerViolation } from "../types/analysis.js";
import { isApiContractLanguage } from "../extractors/registry.js";
import { isTestFile } from "./test-file-detector.js";
import { matchesAnyGlob, type ArchitectureOverrides } from "./project-config.js";

/** A layer token as a path segment — `.` counts as a separator so dotted
 *  .NET-style directories (`League.Models`) and file suffixes (`webpack.config.js`)
 *  participate. */
function seg(names: string): RegExp {
  return new RegExp(`(?:^|[/\\\\.])(?:${names})(?=[/\\\\.]|$)`, "i");
}

/**
 * Layer assignment patterns: regex → layer, first match wins.
 * Order matters for paths carrying several tokens: specific semantic tokens
 * (models, services) must beat generic containers — `views` under
 * `League.Models/LeagueDb/` holds SQL-view entities, not UI, and Rails
 * `app/models/` is data despite living under `app/`.
 */
const LAYER_PATTERNS: [RegExp, ArchLayer][] = [
  [seg("models?|entities|repositories|stores?|data|schemas?|serializers?|migrations?|persistence|dtos?"), "data"],
  [seg("services?|api|clients|httpclients?|hooks|controllers?|endpoints?|routers?|middleware|handlers?|signals?"), "services"],
  [seg("components|widgets"), "components"],
  // `routes` sits with ui: in FE frameworks route dirs hold pages, in BE
  // frameworks endpoint surfaces — both top-of-stack, so their imports of
  // components/services never read as upward violations.
  // Deliberately NO `app` token: Laravel/Rails/Kotlin `app/` is an application
  // CONTAINER (models, providers, enums, DTOs all live under it) — as ui it
  // made every `app/Enums/X.php` a phantom violation target.
  // `flows?` sits with ui for the same reason as `routes`: a Spring WebFlow
  // definition binds view-states to JSPs AND invokes services — top-of-stack,
  // so neither direction reads as an upward violation.
  [seg("pages|views|screens|forms|routes?|flows?"), "ui"],
  [seg("utils?|helpers?|lib|shared|common|types?|typings|interfaces?|enums?"), "utils"],
  [seg("config|settings|constants|env"), "config"],
];

/** Automation/tooling trees (CI pipelines, deploy scripts) are not part of
 *  the layered application — exempt like tests. */
const TOOLING_SEGMENT_RE = seg("cicd|ci[-_]cd|scripts?|tooling|devops|automation");

/** Build-tool config FILES (`vite.config.js`, `webpack.config.ts`) orchestrate
 *  the whole app and legitimately import anything — exempt as violation
 *  sources. Config DIRECTORIES (constants, settings) keep the config layer. */
const CONFIG_FILE_RE = /\.config\.\w+$/i;

/** Wiring/DI configuration CLASSES — `*Config`/`*Configuration` basenames —
 *  register the application's beans/resources; exempt as violation sources. */
const WIRING_CLASS_RE = /(Config|Configuration)\.\w+$/;

/** A layer token as a basename suffix — CamelCase (`TodoController`), an
 *  ALL-CAPS acronym (`AppSupportActivityDTO`), or separator-delimited
 *  (`user.service`, `users_controller`). The lowercase branch requires a
 *  leading separator so `Platform` never reads as `*Form`; the CamelCase and
 *  acronym branches require a compound name (at least one char before the
 *  suffix) so a bare `Page.kt` — a pagination util, not a screen — falls
 *  through to the directory tier. */
function suffix(names: string): RegExp {
  const tokens = names.split("|");
  const cap = tokens.map((n) => n[0]!.toUpperCase() + n.slice(1)).join("|");
  // Short tokens double as acronyms: `dto` also matches `…DTO`, `api` `…API`.
  const acronyms = tokens.filter((n) => n.length <= 4).map((n) => n.toUpperCase()).join("|");
  const acronymAlt = acronyms ? `|.(?:${acronyms})` : "";
  return new RegExp(`(?:(?:^|[._-])(?:${names})|.(?:${cap})${acronymAlt})$`);
}

/** Row predicate: some basename suffixes mean different things per language
 *  family, so a row can opt in/out based on whether the file is JVM source. */
const jvmOnly = (isJvm: boolean): boolean => isJvm;
const nonJvm = (isJvm: boolean): boolean => !isJvm;

/**
 * The file's own name is a more specific signal than any directory token:
 * `Sources/App/TodoController.swift` is services however generic its folder,
 * and Angular's `user.service.ts` / `app.component.ts` carry the layer in the
 * basename alone. Checked before LAYER_PATTERNS. Rows with a predicate apply
 * only where it holds:
 *  - `action|actions` is the Struts/WebFlow/Grails controller tier on the JVM
 *    (`SeasonCreateAction.java` — otherwise its `web/settings/` dir read
 *    as config importing services), but an `XxxActions.vue`/`.tsx` is a UI
 *    action-button cluster, not a controller.
 *  - `form` on the JVM is a form-backing BEAN (Struts ActionForm, WebFlow
 *    form object), not a window — it falls to the dir tier there, while
 *    `LoginForm.tsx` / Delphi `MainForm.pas` / WinForms `LoginForm.cs`
 *    stay ui.
 */
const BASENAME_PATTERNS: [RegExp, ArchLayer, ((isJvm: boolean) => boolean)?][] = [
  [suffix("controller|service|client|handler|middleware|router|api|endpoint|query|queries"), "services"],
  [suffix("action|actions"), "services", jvmOnly],
  [suffix("repository|entity|model|store|dao|dto|schema|migration"), "data"],
  [suffix("view|page|screen|window|dialog"), "ui"],
  [suffix("form"), "ui", nonJvm],
  [suffix("component|widget"), "components"],
  // Deliberately NO util/helper suffixes: a `*Util.cs` inside an application
  // project is application code — only a utils/ directory marks the layer.
  [suffix("type|types"), "utils"],
];

/**
 * .NET-style test scaffolding the generic test conventions miss: a segment
 * like `CommonTest`, `Foo.Tests`, `IntegrationTests` (capital-T suffix so
 * `Contest` never matches), or a `TestXxx` basename (`TestDataAccessHelper`,
 * but not `Testimonial`).
 */
const TEST_SEGMENT_RE = /(?:^|[/\\])(?:[^/\\]*Tests?|Test[A-Z_0-9][^/\\]*)(?=$|[/\\.])/;

/** Which rule placed a file in its layer: a test convention, the repository's config, its name, its folder, what it does, or none. */
export type LayerTier = "test" | "config" | "name" | "folder" | "content" | "none";

/** Layer hierarchy — lower number = lower layer */
const LAYER_LEVEL: Record<ArchLayer, number> = {
  config: 0,
  utils: 1,
  data: 2,
  services: 3,
  components: 4,
  ui: 5,
  test: -1,     // exempt from violations
  unknown: -1,  // exempt from violations
};

/**
 * Classify each file into an architectural layer based on its path.
 *
 * Order of authority: test conventions (a test is exempt wherever it lives),
 * then the repository's own `.clarifydoc/config.json` overrides (`exempt`
 * globs → unknown, `layers` rules first match wins), then the built-in path
 * heuristics. The heuristics carry every framework convention this tool has
 * met; the overrides are how a team fixes the ones it disagrees with for its
 * codebase without waiting for a new heuristic.
 */
export function classifyFileLayers(
  files: ReadonlyArray<string | { path: string; language?: Language }>,
  overrides?: Pick<ArchitectureOverrides, "layers" | "exempt">,
  /**
   * Last tier, for a file no path rule places: what it does — the routes it
   * declares, the entities it defines, the database it touches.
   */
  evidence?: (path: string) => { layer: ArchLayer; reason: string } | null,
  /** Filled with why each file got its layer. */
  reasonsOut?: Record<string, string>,
  /** Filled with which tier placed each file. */
  tiersOut?: Record<string, LayerTier>,
): Record<string, ArchLayer> {
  const result: Record<string, ArchLayer> = {};
  const rules = overrides?.layers ?? [];
  const exempt = overrides?.exempt ?? [];

  for (const entry of files) {
    const fp = typeof entry === "string" ? entry : entry.path;
    // The language unlocks the plugin-declared test conventions. Without it
    // only the generic and .NET patterns fire, so `server_test.go`,
    // `test_views.py` and `foo_spec.rb` were classified as real application
    // layers, could be layer-violation endpoints, and were scored for refactor
    // pressure like production code.
    const language = typeof entry === "string" ? undefined : entry.language;
    const normalized = fp.replace(/\\/g, "/");
    let assigned: ArchLayer = "unknown";
    let reason = "no path rule or file fact places it";
    let tier: LayerTier = "none";

    // Test conventions trump directory tokens — a spec that lives in `utils/`
    // is still a test, and tests are exempt from layer violations. Tooling
    // trees and build-config files are equally outside the layered app.
    const overridden = rules.find((r) => matchesAnyGlob(normalized, r.patterns));
    if (isTestFile(normalized, language) || TEST_SEGMENT_RE.test(normalized)) {
      assigned = "test";
      reason = "a test file by its name or folder";
      tier = "test";
    } else if (matchesAnyGlob(normalized, exempt)) {
      assigned = "unknown";
      reason = "exempt in .clarifydoc/config.json";
      tier = "config";
    } else if (overridden) {
      assigned = overridden.layer;
      reason = `a layers rule in .clarifydoc/config.json (${overridden.patterns.join(", ")})`;
      tier = "config";
    } else if (TOOLING_SEGMENT_RE.test(normalized)) {
      assigned = "unknown";
      reason = "a tooling or script tree, outside the layered app";
    } else {
      // Strip only the final extension: Angular-style compound names
      // (`user.service.ts`) carry the layer in their second segment.
      const baseName = (normalized.split("/").pop() ?? "").replace(/\.\w+$/, "");
      const isJvmFile = /\.(java|kt|kts)$/i.test(normalized);
      for (const [pattern, layer, applies] of BASENAME_PATTERNS) {
        if (applies && !applies(isJvmFile)) continue;
        if (pattern.test(baseName)) {
          assigned = layer;
          reason = `its file name (${baseName})`;
          tier = "name";
          break;
        }
      }
      if (assigned === "unknown") {
        for (const [pattern, layer] of LAYER_PATTERNS) {
          const m = pattern.exec(normalized);
          if (m) {
            assigned = layer;
            reason = `its folder (${m[0].replace(/^[/\\.]/, "")})`;
            tier = "folder";
            break;
          }
        }
      }
      if (assigned === "unknown") {
        const e = evidence?.(fp);
        if (e) {
          assigned = e.layer;
          reason = e.reason;
          tier = "content";
        }
      }
    }

    result[fp] = assigned;
    if (reasonsOut) reasonsOut[fp] = reason;
    if (tiersOut) tiersOut[fp] = tier;
  }

  return result;
}

/**
 * Detect layer violations: lower layers importing from higher layers.
 */
export function detectLayerViolations(
  analyses: FileAnalysis[],
  componentGraph: Record<string, string[]>,
  fileLayerMap: Record<string, ArchLayer>,
): LayerViolation[] {
  const violations: LayerViolation[] = [];

  for (const [sourceFile, targets] of Object.entries(componentGraph)) {
    // Build-tool config files keep their `config` layer for display, but as
    // violation SOURCES they're exempt — vite/webpack/tailwind configs
    // legitimately import app code from the very top of the world.
    if (CONFIG_FILE_RE.test(sourceFile)) continue;
    // Wiring/DI classes (`LeagueResourceConfig.java`, `AppConfiguration.kt`,
    // Guice `*Module`s registered by name) exist to import and register the
    // rest of the app — importing services is their job, same as a build
    // config file. They keep the config layer for display only.
    if (WIRING_CLASS_RE.test(sourceFile)) continue;
    const sourceLayer = fileLayerMap[sourceFile] ?? "unknown";
    const sourceLevel = LAYER_LEVEL[sourceLayer];
    if (sourceLevel < 0) continue; // exempt

    for (const targetFile of targets) {
      const targetLayer = fileLayerMap[targetFile] ?? "unknown";
      const targetLevel = LAYER_LEVEL[targetLayer];
      if (targetLevel < 0) continue; // exempt

      // Violation: source is in a lower layer and imports from a significantly higher layer
      // Allow 1-level proximity (e.g., services importing from components is ok)
      // Only flag 2+ level jumps (e.g., data importing from ui)
      if (sourceLevel < targetLevel && (targetLevel - sourceLevel) > 1) {
        const importLine = importLineOf(analyses, sourceFile, targetFile);

        violations.push({
          sourceFile,
          sourceLayer,
          targetFile,
          targetLayer,
          importSpecifier: targetFile.split("/").pop() ?? targetFile,
          line: importLine,
        });
      }
    }
  }

  return violations;
}

/** The line of the import in `sourceFile` that names `targetFile` (its base name), or 0. */
function importLineOf(analyses: readonly FileAnalysis[], sourceFile: string, targetFile: string): number {
  const analysis = analyses.find((a) => a.filePath === sourceFile);
  const base = targetFile.replace(/\.[^.]+$/, "").split("/").pop()!;
  return analysis?.imports.find((imp) => imp.source.includes(base))?.line ?? 0;
}

/**
 * The team's own import rules (`.clarifydoc/config.json` `rules`), checked over
 * the dependency graph and reported as layer violations that carry the rule's
 * name, so the Health tab and MCP list them beside the built-in layer-order
 * check. A `to` rule forbids an edge from a file matching `from` to one
 * matching `to`; an `allowOnly` rule forbids every edge out of `from` to a
 * project file it does not name; a rule over `each` elements with neither
 * keeps the elements apart. An edge within one `each` element never breaks a
 * rule, and `except` lifts any rule for the files it names on either end. A
 * `noCycles` rule reports every edge of a cycle among its files or elements.
 */
export function detectRuleViolations(
  analyses: readonly FileAnalysis[],
  componentGraph: Record<string, string[]>,
  fileLayerMap: Record<string, ArchLayer>,
  rules: ReadonlyArray<DependencyRule>,
): LayerViolation[] {
  if (rules.length === 0) return [];
  const out: LayerViolation[] = [];
  const violation = (rule: DependencyRule, sourceFile: string, targetFile: string, extra: Partial<LayerViolation> = {}): LayerViolation => ({
    sourceFile,
    sourceLayer: fileLayerMap[sourceFile] ?? "unknown",
    targetFile,
    targetLayer: fileLayerMap[targetFile] ?? "unknown",
    importSpecifier: targetFile.split("/").pop() ?? targetFile,
    line: importLineOf(analyses, sourceFile, targetFile),
    rule: rule.name,
    severity: rule.severity,
    ...extra,
  });
  const edgeRules = rules.filter((r) => !r.noCycles);
  for (const [sourceFile, targets] of Object.entries(componentGraph)) {
    for (const rule of edgeRules) {
      if (!covers(rule, sourceFile)) continue;
      const own = rule.each ? elementOf(sourceFile, rule.each) : null;
      for (const targetFile of targets) {
        if (targetFile === sourceFile || matchesAnyGlob(targetFile, rule.except)) continue;
        const theirs = rule.each ? elementOf(targetFile, rule.each) : null;
        if (own !== null && own === theirs) continue;
        const breach = rule.to.length > 0
          ? matchesAnyGlob(targetFile, rule.to)
          : rule.allowOnly
            ? !matchesAnyGlob(targetFile, rule.allowOnly)
            : theirs !== null;
        if (breach) out.push(violation(rule, sourceFile, targetFile));
      }
    }
  }
  for (const rule of rules.filter((r) => r.noCycles)) {
    // The unit a cycle is between: the `each` element, else the file itself.
    const unit = (file: string): string | null => (covers(rule, file) ? (rule.each ? elementOf(file, rule.each) : file) : null);
    const edges: Array<{ sourceFile: string; targetFile: string; from: string; to: string }> = [];
    const graph = new Map<string, Set<string>>();
    for (const [sourceFile, targets] of Object.entries(componentGraph)) {
      const from = unit(sourceFile);
      if (from === null) continue;
      for (const targetFile of targets) {
        const to = unit(targetFile);
        if (to === null || to === from) continue;
        edges.push({ sourceFile, targetFile, from, to });
        (graph.get(from) ?? graph.set(from, new Set()).get(from)!).add(to);
      }
    }
    const component = stronglyConnected(graph);
    const members = new Map<number, string[]>();
    for (const [u, c] of component) (members.get(c) ?? members.set(c, []).get(c)!).push(u);
    for (const e of edges) {
      const c = component.get(e.from);
      if (c === undefined || c !== component.get(e.to)) continue;
      out.push(violation(rule, e.sourceFile, e.targetFile, { cycle: [...members.get(c)!].sort() }));
    }
  }
  return out;
}

/** A team rule as `resolveArchitectureOverrides` hands it over. */
type DependencyRule = {
  name: string;
  from: string[];
  to: string[];
  except: string[];
  severity: "error" | "warn";
  each?: string;
  allowOnly?: string[];
  noCycles?: boolean;
};

/** Whether a rule speaks for edges out of `file`: it matches `from` (or lies in an `each` element when there is none) and `except` does not name it. */
function covers(rule: DependencyRule, file: string): boolean {
  if (matchesAnyGlob(file, rule.except)) return false;
  if (rule.from.length > 0) return matchesAnyGlob(file, rule.from);
  return rule.each !== undefined && elementOf(file, rule.each) !== null;
}

/**
 * The `each` element a file lies in: the directory, as many segments deep as
 * the pattern, that the pattern matches (`features/billing` for
 * `features/billing/api/bill.ts` under `features/*`); null outside every one.
 */
function elementOf(file: string, each: string): string | null {
  const depth = each.split("/").length;
  const segments = file.split("/");
  if (segments.length <= depth) return null;
  const dir = segments.slice(0, depth).join("/");
  return matchesAnyGlob(dir, [`/${each}`]) ? dir : null;
}

/** Tarjan's strongly connected components; each node in a component of two or more gets that component's number. */
function stronglyConnected(graph: ReadonlyMap<string, ReadonlySet<string>>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out = new Map<string, number>();
  let next = 0;
  let components = 0;
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const members: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        members.push(w);
      } while (w !== v);
      if (members.length > 1) {
        for (const m of members) out.set(m, components);
        components++;
      }
    }
  };
  for (const v of [...graph.keys()].sort()) if (!index.has(v)) visit(v);
  return out;
}

/** Generic source containers among the utils folder tokens, and the tokens that do claim a utility. */
const CONTAINER_FOLDER_RE = seg("lib|shared|common");
const UTILITY_FOLDER_RE = seg("utils?|helpers?");

/** One layer a file's content puts it in. */
export interface LayerEvidence {
  layer: ArchLayer;
  reason: string;
  /** Path layers this fact agrees with. */
  agrees: readonly ArchLayer[];
  /** A fact that contradicts a path on its own: serving an API, defining or querying data. */
  strong?: boolean;
  /** Never places a file by itself (the last tier of `classifyFileLayers` skips it). */
  notAlone?: boolean;
}

/**
 * A file's layer from what it does, for one no path rule places: the routes
 * it declares, the entities it defines, the template it renders — first fact
 * wins, in that order. A file declaring routes sits where a routes folder
 * does, at the top of the stack (`ui`), so the server wiring that mounts route
 * modules never reads as an upward import. Database access is not evidence
 * on its own: entry and wiring files touch it too.
 */
export function layerEvidence(a: FileAnalysis | undefined): { layer: ArchLayer; reason: string } | null {
  const first = layerEvidenceAll(a).find((e) => !e.notAlone);
  return first ? { layer: first.layer, reason: first.reason } : null;
}

/**
 * Every layer what a file DOES puts it in, strongest first — the routes it
 * declares, the entities it defines, the database it queries, the template it
 * renders — each with the layers that agree with it (a controller's API
 * routes agree with the services folder it sits in; a service querying the
 * database is a service). Only declared and extracted facts count, never an
 * import: a file that imports a web framework's error type or dependency
 * marker declares no route and is no API file.
 */
export function layerEvidenceAll(a: FileAnalysis | undefined): LayerEvidence[] {
  // An API contract (OpenAPI, …) declares routes it does not serve: it is no layer of the application.
  if (!a || isApiContractLanguage(a.language)) return [];
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  // `strong`: a fact that contradicts a path on its own — serving an API, defining or querying data. A
  // frontend route (a static page counts) or a rendered template is too common outside ui to say so.
  const out: LayerEvidence[] = [];
  const api = a.routes.filter((r) => r.kind === "api").length;
  const pages = a.routes.length - api;
  if (api || pages) {
    out.push({
      layer: "ui",
      reason: `it declares ${api ? n(api, "API route") : n(pages, "frontend route")} — the top of the stack, as a routes folder is`,
      agrees: api ? ["ui", "services"] : ["ui", "components"],
      ...(api ? { strong: true } : {}),
    });
  }
  const entities = a.classes.filter((c) => c.decorators?.includes("entity")).map((c) => c.name);
  if (entities.length) out.push({ layer: "data", reason: `it defines the ${entities.length === 1 ? "entity" : "entities"} ${entities.slice(0, 3).join(", ")}`, agrees: ["data"], strong: true });
  const queries = a.dataSources.filter((d) => d.kind === "database").length + a.dataMutations.filter((m) => m.kind === "db-write").length;
  // Not evidence on its own for the primary layer (entry and wiring files touch the database too), but it is
  // a second layer beside a path's, and it contradicts a ui/utils/config path.
  if (queries && !entities.length) out.push({ layer: "data", reason: `it queries the database (${n(queries, "statement")})`, agrees: ["data", "services"], strong: true, notAlone: true });
  if ((a.templateTree?.length ?? 0) > 0) out.push({ layer: "components", reason: "it renders a template", agrees: ["components", "ui"] });
  return out;
}

/**
 * Where a file's path and what it does disagree. `alternates`: the other
 * layers its content puts it in (an API controller that also queries the
 * database is both — the layer violation inside one file). `conflicts`: files
 * a path or name rule placed in a layer none of their content agrees with —
 * a `utils/` file that queries the database is misplaced.
 */
export function layerDisagreements(
  analyses: readonly FileAnalysis[],
  layers: Readonly<Record<string, ArchLayer>>,
  tiers: Readonly<Record<string, LayerTier>>,
  skip: (file: string) => boolean,
): { alternates: Record<string, Array<{ layer: ArchLayer; reason: string }>>; conflicts: Array<{ file: string; layer: ArchLayer; evidence: string }> } {
  const alternates: Record<string, Array<{ layer: ArchLayer; reason: string }>> = {};
  const conflicts: Array<{ file: string; layer: ArchLayer; evidence: string }> = [];
  for (const a of analyses) {
    const layer = layers[a.filePath];
    if (!layer || layer === "test" || layer === "unknown" || skip(a.filePath)) continue;
    const evidence = layerEvidenceAll(a);
    const other = evidence.filter((e) => e.layer !== layer && !e.agrees.includes(layer));
    if (other.length) alternates[a.filePath] = other.map(({ layer: l, reason }) => ({ layer: l, reason }));
    const tier = tiers[a.filePath];
    // Misplaced: a path or name rule placed it, nothing it does agrees, and a strong fact says otherwise.
    // A page or component that queries the database is the ui→data shortcut, recorded as an alternate; a
    // utils or config file that does is in the wrong place.
    const strong = other.filter((e) => e.strong && (!e.notAlone || layer === "utils" || layer === "config"));
    // `lib/`, `shared/`, `common/` are where a project keeps its source, not a claim that it is a utility:
    // a folder rule from such a container alone is no path to contradict.
    const containerOnly = tier === "folder" && CONTAINER_FOLDER_RE.test(a.filePath) && !UTILITY_FOLDER_RE.test(a.filePath);
    if ((tier === "name" || tier === "folder") && !containerOnly && strong.length && other.length === evidence.length) {
      conflicts.push({ file: a.filePath, layer, evidence: strong.map((e) => e.reason).join("; ") });
    }
  }
  return { alternates, conflicts };
}
