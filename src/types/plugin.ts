
/** Information about the project being analyzed */
export interface ProjectInfo {
  root: string;
  packageJson: Record<string, unknown> | null;
  csprojFiles: string[];
  /** Concatenated raw text of all .csproj files (used for PackageReference scanning). */
  csprojText: string;
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
  /** Raw content of go.mod if found (used for Go ORM detection). */
  goMod: string | null;
  /** Raw content of Cargo.toml if found (used for Rust ORM detection). */
  cargoToml: string | null;
  /** Raw content of composer.json if found (used for PHP ORM detection). */
  composerJson: string | null;
  /** Raw content of Gemfile if found (used for Ruby ORM detection). */
  gemfile: string | null;
  /** Raw content of pubspec.yaml if found (used for Dart/Flutter detection). */
  pubspecYaml: string | null;
  /** Any *.sql / *.ddl files discovered (used to detect raw-SQL usage in the project). */
  sqlFiles: string[];
  /** Raw content of the root CMakeLists.txt if found (used for Qt/C++ framework detection). */
  cmakeLists: string | null;
  /**
   * Framework marker files found at well-known relative paths — vendored
   * frameworks (CodeIgniter 2/3's `system/` tree) have no manifest entry, so
   * their presence is only visible in the file layout. Relative POSIX paths.
   */
  markerFiles: string[];
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
