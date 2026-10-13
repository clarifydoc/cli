import type { FileAnalysis, ArchLayer, Language, LayerViolation } from "../types/analysis.js";
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

    // Test conventions trump directory tokens — a spec that lives in `utils/`
    // is still a test, and tests are exempt from layer violations. Tooling
    // trees and build-config files are equally outside the layered app.
    const overridden = rules.find((r) => matchesAnyGlob(normalized, r.patterns));
    if (isTestFile(normalized, language) || TEST_SEGMENT_RE.test(normalized)) {
      assigned = "test";
    } else if (matchesAnyGlob(normalized, exempt)) {
      assigned = "unknown";
    } else if (overridden) {
      assigned = overridden.layer;
    } else if (TOOLING_SEGMENT_RE.test(normalized)) {
      assigned = "unknown";
    } else {
      // Strip only the final extension: Angular-style compound names
      // (`user.service.ts`) carry the layer in their second segment.
      const baseName = (normalized.split("/").pop() ?? "").replace(/\.\w+$/, "");
      const isJvmFile = /\.(java|kt|kts)$/i.test(normalized);
      for (const [pattern, layer, applies] of BASENAME_PATTERNS) {
        if (applies && !applies(isJvmFile)) continue;
        if (pattern.test(baseName)) {
          assigned = layer;
          break;
        }
      }
      if (assigned === "unknown") {
        for (const [pattern, layer] of LAYER_PATTERNS) {
          if (pattern.test(normalized)) {
            assigned = layer;
            break;
          }
        }
      }
    }

    result[fp] = assigned;
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
 * the dependency graph: an edge from a file matching `from` to one matching
 * `to` breaks the rule unless `except` names either end. Reported as layer
 * violations that carry the rule's name, so the Health tab and MCP list them
 * beside the built-in layer-order check.
 */
export function detectRuleViolations(
  analyses: readonly FileAnalysis[],
  componentGraph: Record<string, string[]>,
  fileLayerMap: Record<string, ArchLayer>,
  rules: ReadonlyArray<{ name: string; from: string[]; to: string[]; except: string[]; severity: "error" | "warn" }>,
): LayerViolation[] {
  if (rules.length === 0) return [];
  const out: LayerViolation[] = [];
  for (const [sourceFile, targets] of Object.entries(componentGraph)) {
    for (const rule of rules) {
      if (!matchesAnyGlob(sourceFile, rule.from) || matchesAnyGlob(sourceFile, rule.except)) continue;
      for (const targetFile of targets) {
        if (targetFile === sourceFile || !matchesAnyGlob(targetFile, rule.to) || matchesAnyGlob(targetFile, rule.except)) continue;
        out.push({
          sourceFile,
          sourceLayer: fileLayerMap[sourceFile] ?? "unknown",
          targetFile,
          targetLayer: fileLayerMap[targetFile] ?? "unknown",
          importSpecifier: targetFile.split("/").pop() ?? targetFile,
          line: importLineOf(analyses, sourceFile, targetFile),
          rule: rule.name,
          severity: rule.severity,
        });
      }
    }
  }
  return out;
}
