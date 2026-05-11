import type { FileAnalysis, ArchLayer, LayerViolation } from "../types/analysis.js";

/**
 * Layer assignment patterns: regex → layer.
 * Match the directory name whether it appears at the start of the path
 * or between separators.
 */
const LAYER_PATTERNS: [RegExp, ArchLayer][] = [
  [/(?:^|[/\\])(pages|views|screens|forms|app)[/\\]/i, "ui"],
  [/(?:^|[/\\])(components|widgets)[/\\]/i, "components"],
  [/(?:^|[/\\])(services|api|clients|hooks|controllers?|endpoints?|routers?)[/\\]/i, "services"],
  [/(?:^|[/\\])(middleware|handlers?|signals?)[/\\]/i, "services"],
  [/(?:^|[/\\])(models?|entities|repositories|stores?|data|schemas?|serializers?|migrations?)[/\\]/i, "data"],
  [/(?:^|[/\\])(utils?|helpers?|lib|shared|common)[/\\]/i, "utils"],
  [/(?:^|[/\\])(config|settings|constants|env)[/\\]/i, "config"],
  [/(?:^|[/\\])(tests?|__tests__|spec|__mocks__|fixtures)[/\\]/i, "test"],
];

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

    for (const [pattern, layer] of LAYER_PATTERNS) {
      if (pattern.test(normalized)) {
        assigned = layer;
        break;
      }
    }

    // Fallback heuristics for files not in recognized directories
    if (assigned === "unknown") {
      const fileName = normalized.split("/").pop() ?? "";
      if (/\.(test|spec)\.[^.]+$/.test(fileName) || fileName.startsWith("test_")) {
        assigned = "test";
      } else if (/config|settings/i.test(fileName)) {
        assigned = "config";
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
