import type { FileAnalysis, ArchLayer, LayerViolation } from "../types/analysis.js";
import { isTestFile } from "./test-file-detector.js";

/** A layer token as a path segment — `.` counts as a separator so dotted
 *  .NET-style directories (`Trio.Models`) and file suffixes (`webpack.config.js`)
 *  participate. */
function seg(names: string): RegExp {
  return new RegExp(`(?:^|[/\\\\.])(?:${names})(?=[/\\\\.]|$)`, "i");
}

/**
 * Layer assignment patterns: regex → layer, first match wins.
 * Order matters for paths carrying several tokens: specific semantic tokens
 * (models, services) must beat generic containers — `views` under
 * `Trio.Models/TrioDb/` holds SQL-view entities, not UI, and Rails
 * `app/models/` is data despite living under `app/`.
 */
const LAYER_PATTERNS: [RegExp, ArchLayer][] = [
  [seg("models?|entities|repositories|stores?|data|schemas?|serializers?|migrations?|persistence"), "data"],
  [seg("services|api|clients|httpclients?|hooks|controllers?|endpoints?|routers?|middleware|handlers?|signals?"), "services"],
  [seg("components|widgets"), "components"],
  // `routes` sits with ui: in FE frameworks route dirs hold pages, in BE
  // frameworks endpoint surfaces — both top-of-stack, so their imports of
  // components/services never read as upward violations.
  [seg("pages|views|screens|forms|app|routes?"), "ui"],
  [seg("utils?|helpers?|lib|shared|common|types?|typings|interfaces?"), "utils"],
  [seg("config|settings|constants|env"), "config"],
];

/** A layer token as a basename suffix — CamelCase (`TodoController`) or
 *  separator-delimited (`user.service`, `users_controller`). The lowercase
 *  branch requires a leading separator so `Platform` never reads as `*Form`. */
function suffix(names: string): RegExp {
  const cap = names
    .split("|")
    .map((n) => n[0]!.toUpperCase() + n.slice(1))
    .join("|");
  return new RegExp(`(?:(?:^|[._-])(?:${names})|(?:${cap}))$`);
}

/**
 * The file's own name is a more specific signal than any directory token:
 * `Sources/App/TodoController.swift` is services however generic its folder,
 * and Angular's `user.service.ts` / `app.component.ts` carry the layer in the
 * basename alone. Checked before LAYER_PATTERNS.
 */
const BASENAME_PATTERNS: [RegExp, ArchLayer][] = [
  [suffix("controller|service|client|handler|middleware|router|api|endpoint|query|queries"), "services"],
  [suffix("repository|entity|model|store|dao|dto|schema|migration"), "data"],
  [suffix("view|page|screen|form|window|dialog"), "ui"],
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
 */
export function classifyFileLayers(
  filePaths: string[],
): Record<string, ArchLayer> {
  const result: Record<string, ArchLayer> = {};

  for (const fp of filePaths) {
    const normalized = fp.replace(/\\/g, "/");
    let assigned: ArchLayer = "unknown";

    // Test conventions trump directory tokens — a spec that lives in `utils/`
    // is still a test, and tests are exempt from layer violations.
    if (isTestFile(normalized) || TEST_SEGMENT_RE.test(normalized)) {
      assigned = "test";
    } else {
      // Strip only the final extension: Angular-style compound names
      // (`user.service.ts`) carry the layer in their second segment.
      const baseName = (normalized.split("/").pop() ?? "").replace(/\.\w+$/, "");
      for (const [pattern, layer] of BASENAME_PATTERNS) {
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
        // Find the import line
        const analysis = analyses.find((a) => a.filePath === sourceFile);
        const importLine = analysis?.imports.find((imp) => {
          // Check if this import resolves to the target file
          return imp.source.includes(targetFile.replace(/\.[^.]+$/, "").split("/").pop()!);
        })?.line ?? 0;

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
