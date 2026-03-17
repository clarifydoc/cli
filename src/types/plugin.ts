import type { FileAnalysis, Language } from "./analysis.js";

/** Information about the project being analyzed */
export interface ProjectInfo {
  root: string;
  packageJson: Record<string, unknown> | null;
  csprojFiles: string[];
  pythonManifest: Record<string, unknown> | null;
  /** Raw content of build.gradle or build.gradle.kts if found */
  gradleFile: string | null;
  /** Raw content of pom.xml if found */
  pomXml: string | null;
  fileExtensions: Set<string>;
  /** Delphi .dproj project files */
  dprojFiles: string[];
  /** Lazarus .lpi project files */
  lpiFiles: string[];
  /** Aggregated uses-clause unit names from .pas/.dpr files (for framework detection) */
  delphiUses: string[];
}

/** A tree-sitter query definition for a plugin */
export interface QueryDefinition {
  name: string;
  targetField: keyof FileAnalysis;
  querySource: string;
}

/** Plugin interface for framework-specific extraction */
export interface ReverseDocPlugin {
  id: string;
  name: string;
  languages: Language[];

  /** Detect if this framework applies to the project */
  detect(projectInfo: ProjectInfo): boolean;

  /** Get tree-sitter queries for this plugin */
  getQueries(): QueryDefinition[];

  /**
   * Post-process raw query captures into typed analysis fields.
   * Called after queries run on a file.
   */
  processCaptures(
    captures: Map<string, CaptureResult[]>,
    sourceText: string,
    existingAnalysis: Partial<FileAnalysis>,
  ): Partial<FileAnalysis>;
}

/** Result from a tree-sitter query capture */
export interface CaptureResult {
  name: string;
  text: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}
