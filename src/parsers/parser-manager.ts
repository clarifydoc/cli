import {
  Parser,
  Language as TSLanguage,
  Tree as TSTree,
  Query,
  Node as TSNodeClass,
  type Node as TSNode,
} from "web-tree-sitter";
import { readFile } from "fs/promises";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import type { Language } from "../types/analysis.js";
import type { CaptureResult } from "../types/plugin.js";

// Re-export tree-sitter types under our own names for use in extractors
export type { TSTree, TSNode, TSLanguage };

const require = createRequire(import.meta.url);

/** Languages that have tree-sitter grammars available */
type TreeSitterParseable = "typescript" | "javascript" | "csharp" | "python" | "java" | "kotlin" | "pascal" | "php";

/** Grammar variant for sub-language selection (e.g., tsx vs ts) */
type GrammarKey = TreeSitterParseable | "tsx";

/** Maps grammar keys to the npm package + WASM filename */
/** Maps grammar keys to the npm package + WASM filename.
 *  `pkgJson` means resolve via package.json (for packages without a main entry). */
const GRAMMAR_PACKAGES: Record<GrammarKey, { pkg: string; wasm: string; viaPkgJson?: boolean }> = {
  typescript: { pkg: "tree-sitter-typescript", wasm: "tree-sitter-typescript.wasm" },
  tsx: { pkg: "tree-sitter-typescript", wasm: "tree-sitter-tsx.wasm" },
  javascript: { pkg: "tree-sitter-javascript", wasm: "tree-sitter-javascript.wasm" },
  csharp: { pkg: "tree-sitter-c-sharp", wasm: "tree-sitter-c_sharp.wasm" },
  python: { pkg: "tree-sitter-python", wasm: "tree-sitter-python.wasm" },
  java: { pkg: "tree-sitter-java", wasm: "tree-sitter-java.wasm" },
  kotlin: { pkg: "tree-sitter-kotlin", wasm: "tree-sitter-kotlin.wasm", viaPkgJson: true },
  pascal: { pkg: "tree-sitter-pascal", wasm: "tree-sitter-pascal.wasm", viaPkgJson: true },
  php: { pkg: "tree-sitter-php", wasm: "tree-sitter-php.wasm", viaPkgJson: true },
};

let initialized = false;
const parserCache = new Map<GrammarKey, Parser>();
const languageCache = new Map<GrammarKey, TSLanguage>();
const queryCache = new Map<string, Query>();

/** Resolve a file within a node_modules package */
function resolvePackageFile(pkg: string, file: string): string {
  const pkgMain = require.resolve(pkg);
  return join(dirname(pkgMain), file);
}

/**
 * Make `Node.type` cache its result on the node instance. The stock getter
 * marshals the node and crosses into WASM on every access, and extractors
 * read `.type` many times per node (long if/else chains, repeat visits via
 * the shared `children` arrays). Trees are parsed once and never edited
 * here, so a node's type is immutable and safe to cache.
 */
function installNodeTypeCache(): void {
  const proto = TSNodeClass.prototype as any;
  const desc = Object.getOwnPropertyDescriptor(proto, "type");
  if (!desc?.get) return;
  const origGet = desc.get;
  Object.defineProperty(proto, "type", {
    configurable: true,
    get(this: { _cachedType?: string }) {
      return (this._cachedType ??= origGet.call(this));
    },
  });
}

/** Ensure tree-sitter WASM runtime is initialized */
async function ensureInit(): Promise<void> {
  if (initialized) return;

  const wasmPath = resolvePackageFile("web-tree-sitter", "web-tree-sitter.wasm");

  await Parser.init({
    locateFile: () => wasmPath,
  });
  installNodeTypeCache();
  initialized = true;
}

/** Languages that have tree-sitter grammars (excludes non-parseable and regex-only formats) */
export type TreeSitterLanguage = Exclude<Language, "dfm" | "swift" | "lua" | "scala" | "go" | "rust" | "ruby" | "perl" | "vb" | "sql" | "c" | "cpp">;

/** Resolve the grammar key, using tsx for .tsx/.jsx files */
function resolveGrammarKey(language: TreeSitterLanguage, filePath?: string): GrammarKey {
  if (filePath && (filePath.endsWith(".tsx") || filePath.endsWith(".jsx"))) {
    return language === "typescript" ? "tsx" : language;
  }
  return language;
}

/** Find the grammar WASM file path */
function getGrammarPath(key: GrammarKey): string {
  const { pkg, wasm, viaPkgJson } = GRAMMAR_PACKAGES[key];
  if (viaPkgJson) {
    const pkgJsonPath = require.resolve(`${pkg}/package.json`);
    return join(dirname(pkgJsonPath), wasm);
  }
  const pkgJsonPath = require.resolve(`${pkg}/package.json`);
  return join(dirname(pkgJsonPath), wasm);
}

/** Get or create a parser for the given grammar key */
async function getParserForKey(key: GrammarKey): Promise<Parser> {
  await ensureInit();

  const cached = parserCache.get(key);
  if (cached) return cached;

  const lang = await getLanguageForKey(key);
  const parser = new Parser();
  parser.setLanguage(lang);
  parserCache.set(key, parser);
  return parser;
}

/** Get or load a language grammar */
async function getLanguageForKey(key: GrammarKey): Promise<TSLanguage> {
  await ensureInit();

  const cached = languageCache.get(key);
  if (cached) return cached;

  const grammarPath = getGrammarPath(key);
  const lang = await TSLanguage.load(grammarPath);
  languageCache.set(key, lang);
  return lang;
}

/** Public API: get parser for a language */
export async function getParser(language: TreeSitterLanguage): Promise<Parser> {
  return getParserForKey(language);
}

/** Public API: get language grammar */
export async function getLanguage(language: TreeSitterLanguage): Promise<TSLanguage> {
  return getLanguageForKey(language);
}

/** Parse source code into a tree-sitter tree */
export async function parseSource(
  sourceText: string,
  language: TreeSitterLanguage,
  filePath?: string,
): Promise<TSTree> {
  const key = resolveGrammarKey(language, filePath);
  const parser = await getParserForKey(key);
  const tree = parser.parse(sourceText);
  if (!tree) throw new Error(`Failed to parse source as ${language}`);
  // The default rootNode getter unmarshals a fresh Node (and thus a fresh
  // subtree) on every access, so each extractor re-creates every node it
  // visits. Pin one shared root so the per-node `children` caches are
  // reused across all extractors that walk this tree.
  Object.defineProperty(tree, "rootNode", { value: tree.rootNode, configurable: true });
  return tree;
}

/** Run a tree-sitter S-expression query and return captures.
 *  Queries are cached by language+querySource to avoid recompilation. */
export async function runQuery(
  tree: TSTree,
  language: TreeSitterLanguage,
  querySource: string,
): Promise<Map<string, CaptureResult[]>> {
  const cacheKey = `${language}:${querySource}`;
  let query = queryCache.get(cacheKey);
  if (!query) {
    const lang = await getLanguage(language);
    query = new Query(lang, querySource);
    queryCache.set(cacheKey, query);
  }

  const matches = query.matches(tree.rootNode);
  const results = new Map<string, CaptureResult[]>();

  for (const match of matches) {
    for (const capture of match.captures) {
      const name = capture.name;
      const entry: CaptureResult = {
        name,
        text: capture.node.text,
        startRow: capture.node.startPosition.row,
        startCol: capture.node.startPosition.column,
        endRow: capture.node.endPosition.row,
        endCol: capture.node.endPosition.column,
      };

      const list = results.get(name) ?? [];
      list.push(entry);
      results.set(name, list);
    }
  }

  return results;
}

/** Clear the query cache (useful for testing or freeing memory). */
export function clearQueryCache(): void {
  for (const query of queryCache.values()) {
    query.delete();
  }
  queryCache.clear();
}

/** Parse a file from disk */
export async function parseFile(
  filePath: string,
  language: TreeSitterLanguage,
): Promise<{ tree: TSTree; sourceText: string }> {
  const sourceText = await readFile(filePath, "utf-8");
  const tree = await parseSource(sourceText, language);
  return { tree, sourceText };
}
