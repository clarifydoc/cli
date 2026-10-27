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
import type { GrammarSpec, GrammarVariant } from "../types/language-plugin.js";

// Re-export tree-sitter types under our own names for use in extractors
export type { TSTree, TSNode, TSLanguage };

const require = createRequire(import.meta.url);

/** Grammar variant key, e.g. "typescript" or "tsx". Usually the language id. */
type GrammarKey = string;

/**
 * Grammar registry. Each plugin's meta declares its grammar variants
 * (`meta.grammar`); the plugin registry pushes them in here at load time.
 * Push pattern — this module is imported from plugin base classes
 * (runQuery), so it can't import the registry itself.
 */
const grammarVariants = new Map<GrammarKey, GrammarVariant>();
const languageGrammars = new Map<Language, GrammarSpec>();

/** Called by the registry while aggregating plugin metas. */
export function registerGrammar(language: Language, spec: GrammarSpec | undefined): void {
  if (!spec) return;
  languageGrammars.set(language, spec);
  for (const [key, variant] of Object.entries(spec.variants)) {
    grammarVariants.set(key, variant);
  }
}

// Promises, not values: files are analysed concurrently, and two that start
// at once must share ONE runtime init and ONE grammar load. A second
// `Parser.init` re-instantiates the WASM module under the first caller's
// grammar and parser, whose next parse then throws — the file silently fell
// back to regex extraction whenever two first parses overlapped.
let initializing: Promise<void> | null = null;
const parserCache = new Map<GrammarKey, Promise<Parser>>();
const languageCache = new Map<GrammarKey, Promise<TSLanguage>>();
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
 *
 * Only `type` gets this treatment: caching more getters as extra lazy
 * instance properties (tried with endIndex/endPosition) forks V8 hidden
 * classes by property-insertion order and makes every node property access
 * megamorphic — measurably slower than the WASM calls it saves.
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

/** Ensure tree-sitter WASM runtime is initialized (once, however many callers ask at once). */
function ensureInit(): Promise<void> {
  if (!initializing) {
    const wasmPath = resolvePackageFile("web-tree-sitter", "web-tree-sitter.wasm");
    initializing = Parser.init({ locateFile: () => wasmPath }).then(() => installNodeTypeCache());
    // A failed init is retried by the next caller rather than remembered.
    initializing.catch(() => { initializing = null; });
  }
  return initializing;
}

/** Languages that have tree-sitter grammars (excludes non-parseable and regex-only formats) */
export type TreeSitterLanguage = Exclude<Language, "dfm" | "swift" | "lua" | "scala" | "go" | "rust" | "ruby" | "perl" | "vb" | "sql" | "c" | "cpp" | "dart">;

/** Resolve the grammar key for a file (e.g. .tsx files use the "tsx" variant) */
function resolveGrammarKey(language: TreeSitterLanguage, filePath?: string): GrammarKey {
  const spec = languageGrammars.get(language);
  if (filePath && spec?.keyForFile) {
    return spec.keyForFile(filePath);
  }
  return language;
}

/** Find the grammar WASM file path */
function getGrammarPath(key: GrammarKey): string {
  const variant = grammarVariants.get(key);
  if (!variant) {
    throw new Error(`No tree-sitter grammar registered for "${key}"`);
  }
  const pkgJsonPath = require.resolve(`${variant.pkg}/package.json`);
  return join(dirname(pkgJsonPath), variant.wasm);
}

/** Get or create a parser for the given grammar key */
function getParserForKey(key: GrammarKey): Promise<Parser> {
  let parser = parserCache.get(key);
  if (!parser) {
    parser = getLanguageForKey(key).then((lang) => {
      const p = new Parser();
      p.setLanguage(lang);
      return p;
    });
    parserCache.set(key, parser);
    parser.catch(() => parserCache.delete(key));
  }
  return parser;
}

/** Get or load a language grammar */
function getLanguageForKey(key: GrammarKey): Promise<TSLanguage> {
  let lang = languageCache.get(key);
  if (!lang) {
    lang = ensureInit().then(() => TSLanguage.load(getGrammarPath(key)));
    languageCache.set(key, lang);
    lang.catch(() => languageCache.delete(key));
  }
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
