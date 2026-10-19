/**
 * Structural types for the pieces of a denormalized `ProjectAnalysis` the
 * exporters read.
 *
 * Declared structurally rather than as `ProjectAnalysis`: the writers read
 * `project-summary.json` files written by any engine version, and the field
 * NAMES are the contract, the same seam `src/core/report-payload.ts` documents
 * for the viewer payload.
 *
 * Every field is optional. Exports must survive an older `project-summary.json`
 * that predates half of these analyzers, and must survive a repo that simply
 * has no entities, no routes and no compose files. The writers below all treat
 * "absent" and "empty" the same way: the section says so and moves on.
 */

export interface Framework {
  id?: string;
  name: string;
  confidence?: string;
  detectedVia?: string;
}

export interface SubProject {
  id: string;
  name: string;
  root: string;
  kind: string;
  markers?: string[];
  frameworks?: Framework[];
}

export interface Route {
  path: string;
  httpMethod: string | null;
  kind: "frontend" | "api" | string;
  handler: string | null;
  line: number;
  filePath?: string | null;
  middleware?: string[];
}

export interface ApiRouteLink {
  source: string;
  sourceLine: number;
  method: string | null;
  url: string;
  target: string;
  targetLine: number;
  handler: string | null;
  routePath: string;
  confidence?: string;
  matchedVia?: string;
  /** `test` or `generated` when the calling file is not production code. */
  sourceRole?: string;
}

export interface Link {
  source: string;
  target: string;
  proximity?: number;
  reason?: string;
  calls?: string[];
  confidence?: string;
}

export interface EntityColumn {
  name: string;
  type: string | null;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
}

export interface EntityNode {
  id: string;
  name: string;
  orm: string | null;
  kind: "entity" | "enum" | string;
  filePath: string;
  columns?: EntityColumn[];
  line?: number;
}

export interface EntityEdge {
  source: string;
  target: string;
  sourceCardinality: "one" | "many" | string;
  targetCardinality: "one" | "many" | string;
  fields?: string[];
  foreignKey?: string | null;
  joinTable?: string | null;
  orm?: string | null;
  confidence?: string;
  selfRef?: boolean;
}

export interface ClassNode {
  id: string;
  name: string;
  filePath: string;
  isInterface?: boolean;
  isExternal?: boolean;
  isFile?: boolean;
  isEntity?: boolean;
  orm?: string | null;
  inboundCount?: number;
  outboundCount?: number;
}

export interface ClassEdge {
  source: string;
  target: string;
  total?: number;
  category?: string;
  byKind?: Record<string, number>;
}

export interface DataAccessNode {
  id: string;
  name: string;
  kind: "file" | "datastore" | "entity" | "queue" | string;
  filePath?: string;
  inboundCount?: number;
  outboundCount?: number;
}

export interface DataAccessEdge {
  source: string;
  target: string;
  total?: number;
  calls?: Array<{ name: string; line: number; entity?: string }>;
}

export interface SymbolDataAccess {
  file: string;
  symbol: string;
  symbolLine: number;
  entity: string;
  entityMatched?: boolean;
  datastore?: string | null;
  access?: string;
  sites?: Array<{ name: string; line: number }>;
}

export interface DataFlow {
  entryKind: "route" | "screen" | string;
  entryLabel: string;
  entryFile: string;
  effect: string;
  resource: string;
  distance?: number;
  confidence?: string;
}

export interface Screen {
  name: string;
  formType?: string;
  filePath: string;
  routePath?: string | null;
  navigatesTo?: string[];
  startup?: string;
}

export interface DeployedService {
  name: string;
  composeFile?: string;
  image?: string;
  entrypoint?: string;
  kind: string;
  family?: string;
  tech?: string;
  project?: string;
  databases?: Array<{ name: string; primary?: boolean }>;
  hostedDatabases?: string[];
}

export interface DeploymentEdge {
  from: string;
  to: string;
  kind: string;
  label?: string;
  via?: string;
}

export interface Deployment {
  composeFiles?: string[];
  services?: DeployedService[];
  externals?: Array<{ id: string; name: string; url?: string }>;
  edges?: DeploymentEdge[];
}

export interface ExternalPackage {
  name: string;
  version: string | null;
  ecosystem: string;
  scope: string;
  category: string;
  used?: boolean;
  usageCount?: number;
  declaredIn?: string;
}

export interface Migration {
  filePath: string;
  ecosystem: string;
  name: string;
  order?: string;
}

export interface HealthScore {
  score: number;
  grade: string;
  penalties?: Array<{ reason: string; points: number }>;
}

export interface Provenance {
  extractorVersion?: string;
  schemaVersion?: number;
  toolVersion?: string;
}

/** The subset of `ProjectAnalysis` the exporters consume. */
export interface Summary {
  projectRoot?: string;
  analyzedAt?: string;
  detectedFrameworks?: Framework[];
  subProjects?: SubProject[];
  fileProjects?: Record<string, string>;
  files?: string[];
  componentGraph?: Record<string, string[]>;
  linkGraph?: Link[];
  routeMap?: Route[];
  apiRouteLinks?: ApiRouteLink[];
  screens?: Screen[];
  entityGraph?: { nodes?: EntityNode[]; edges?: EntityEdge[] } | null;
  classGraph?: { nodes?: ClassNode[]; edges?: ClassEdge[] } | null;
  dataAccessGraph?: { nodes?: DataAccessNode[]; edges?: DataAccessEdge[] } | null;
  symbolDataAccess?: SymbolDataAccess[];
  dataFlows?: DataFlow[];
  deployment?: Deployment | null;
  externalPackages?: ExternalPackage[];
  migrations?: Migration[];
  healthScore?: HealthScore | null;
  fileLayerMap?: Record<string, string>;
  confidenceCounts?: { extracted?: number; inferred?: number; ambiguous?: number } | null;
  communities?: Record<string, string[]>;
  cohesion?: Record<string, number>;
  godNodes?: Array<{ file: string; degree: number }>;
  layerViolations?: unknown[];
  securityIssues?: unknown[];
  unusedFiles?: string[];
  generatedRoots?: string[];
  provenance?: Provenance;
}
