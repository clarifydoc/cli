/**
 * The fields of the two artifacts an analysis writes — one JSON per analyzed
 * file (`FileAnalysis`) and `project-summary.json` (`ProjectAnalysis`) — as
 * data, for `clarifydoc schema`.
 *
 * Each table is typed as a complete map of its interface: adding a field to
 * the interface without listing it here, or listing one that is gone, fails
 * the typecheck. That is the whole point — the command used to print a
 * hand-kept list that had silently fallen two dozen fields behind.
 * What each field means is in `docs/reading-the-output.md`.
 */

import type { FileAnalysis, ProjectAnalysis } from "../types/analysis.js";

type Presence<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? "optional" : "required" };

export const FILE_ANALYSIS_FIELDS: Presence<FileAnalysis> = {
  filePath: "required",
  language: "required",
  frameworks: "required",
  projectId: "required",
  extraction: "optional",
  lineCount: "optional",
  parseErrors: "optional",
  imports: "required",
  packageReferences: "optional",
  exports: "required",
  functions: "required",
  classes: "required",
  routes: "required",
  routeFacts: "optional",
  pathArgCalls: "optional",
  domBindings: "optional",
  instantiations: "optional",
  moduleValues: "optional",
  attributeReads: "optional",
  dataSources: "required",
  dataMutations: "required",
  stringConstants: "optional",
  propBindings: "optional",
  componentSubscriptions: "optional",
  subComponents: "required",
  interactiveElements: "required",
  templateTree: "optional",
  angularTemplateUrl: "optional",
  customElements: "optional",
  globalMembers: "optional",
  pathReferences: "optional",
  events: "required",
  screens: "required",
  uiComponents: "optional",
  extractorWarnings: "optional",
  complexities: "optional",
  securityIssues: "optional",
  minified: "optional",
  vendored: "optional",
  generated: "optional",
  typeReferences: "optional",
  entityRelations: "optional",
  railsSchemaTables: "optional",
  schemaOps: "optional",
  diBindings: "optional",
  typeAliases: "optional",
  declaredNamespace: "optional",
  packageName: "optional",
  httpClientBases: "optional",
  storeModules: "optional",
  messageHandlers: "optional",
  deployedResources: "optional",
  entryPoints: "optional",
  httpClientRegistrations: "optional",
  proxyRules: "optional",
  generatedClients: "optional",
  taintFacts: "optional",
};

export const PROJECT_ANALYSIS_FIELDS: Presence<ProjectAnalysis> = {
  projectRoot: "required",
  detectedFrameworks: "required",
  subProjects: "required",
  fileProjects: "required",
  files: "required",
  componentGraph: "required",
  linkGraph: "required",
  interactiveElements: "required",
  events: "required",
  routeMap: "required",
  apiCalls: "required",
  externalServices: "optional",
  entryPoints: "optional",
  projectCommands: "optional",
  testCoverage: "optional",
  docDrift: "optional",
  historySecrets: "optional",
  typeOnlyEdges: "optional",
  dynamicImportEdges: "optional",
  paramOrigins: "optional",
  paramColumns: "optional",
  communityNames: "optional",
  fileLayerReasons: "optional",
  fileLayerAlternates: "optional",
  fileLayerConflicts: "optional",
  screens: "required",
  apiRouteLinks: "optional",
  apiRouteLinkStats: "optional",
  contractFindings: "optional",
  projectDependencies: "optional",
  serviceAddresses: "optional",
  proxyRules: "optional",
  componentUsage: "optional",
  symbolLinks: "required",
  componentLaunches: "optional",
  lspStats: "optional",
  analyzedAt: "required",
  sourceRevision: "optional",
  importedFindings: "optional",
  coverage: "optional",
  complexity: "optional",
  patterns: "optional",
  securityIssues: "optional",
  duplicates: "optional",
  layerViolations: "optional",
  blastRadius: "optional",
  healthScore: "optional",
  suggestions: "optional",
  fileChurn: "optional",
  coChange: "optional",
  codeOwners: "optional",
  hotspots: "optional",
  responsibilityProfiles: "optional",
  refactorPressure: "optional",
  fileLayerMap: "optional",
  provenance: "optional",
  generatedRoots: "optional",
  unusedFiles: "optional",
  deadCode: "optional",
  confidenceCounts: "optional",
  skippedSensitive: "optional",
  skippedSymlinks: "optional",
  communities: "optional",
  cohesion: "optional",
  godNodes: "optional",
  surprisingConnections: "optional",
  suggestedQuestions: "optional",
  classGraph: "optional",
  dataAccessGraph: "optional",
  entityGraph: "optional",
  symbolDataAccess: "optional",
  symbolReach: "optional",
  dataFlows: "optional",
  migrations: "optional",
  externalPackages: "optional",
  deployment: "optional",
  envVars: "optional",
  ciDeploys: "optional",
};

/**
 * Keys `project-summary.json` carries beyond `ProjectAnalysis`: on disk the
 * summary is normalized — symbol and graph fields point into one `elements`
 * registry by index — and `loadReportSummary` / `denormalizeProject` restore
 * the plain form the field list describes.
 */
export const SUMMARY_ENVELOPE = {
  schemaVersion: "the on-disk encoding's version",
  elements: "the symbol registry that normalized fields reference by index",
} as const;

/** What `clarifydoc schema` prints: both artifacts, required fields first. */
export function outputSchema() {
  const split = (fields: Record<string, "optional" | "required">) => ({
    required: Object.keys(fields).filter((k) => fields[k] === "required"),
    optional: Object.keys(fields).filter((k) => fields[k] === "optional"),
  });
  return {
    fileAnalysis: { file: "<outputDir>/<projectName>/<path>.json", ...split(FILE_ANALYSIS_FIELDS) },
    projectAnalysis: {
      file: "<outputDir>/<projectName>/project-summary.json",
      ...split(PROJECT_ANALYSIS_FIELDS),
      envelope: SUMMARY_ENVELOPE,
      note: "Stored normalized; read it with loadReportSummary() (or denormalizeProject) to get these fields as described.",
    },
    reference: "docs/reading-the-output.md",
  };
}
