import { conditionalBlocks } from "../shared/preprocessor-branches.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import type { ClassInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { declarationLines, extractObjcLocalTypes, objcClasses, objcParams, parseObjcReturnType } from "./receivers.js";

/**
 * Objective-C regex spec. Claims `.m`/`.mm` only — `.h` has one owner, the cpp plugin, which hands an
 * Objective-C header (`@interface`, a framework import) over from its `preprocess`. Methods are `- (ret)selector…` / `+ (ret)…` with brace bodies;
 * classes come from `@implementation X … @end` and `@interface`/`@protocol` blocks (receivers.ts).
 */
export const objcSpec: RegexLangSpec = {
  language: "objc",
  extensions: [".m", ".mm"],
  lineCommentPrefixes: ["//"],
  conditionalBlocks: (lines) => conditionalBlocks(lines),

  functionPatterns: [
    {
      // `- (void)viewDidLoad {` / `+ (instancetype)shared` → first selector segment.
      pattern: /^\s*[-+]\s*\([^)]*\)\s*(\w+)/,
      isExported: () => true,
    },
  ],

  classPatterns: [],

  // One class per name and file: `@implementation X … @end` with the `@interface` of the same file merged in
  // (superclass, protocols, properties and instance variables); a header's `@interface` or `@protocol` stands alone.
  extractClasses: (lines, fns): ClassInfo[] => objcClasses(lines, fns),
  // A method declared in an `@interface` is no function: the `@implementation` holds its definition.
  postProcessFunctions: (lines, fns) => {
    const declared = declarationLines(lines);
    return declared.size === 0 ? fns : fns.filter((fn) => !declared.has(fn.line));
  },
  extractParams: objcParams,
  parseReturnType: parseObjcReturnType,
  extractLocalTypes: (body) => extractObjcLocalTypes(body),

  importPatterns: [
    { pattern: /^\s*#\s*import\s*[<"]([^>"]+)[>"]/, getSource: (m) => m[1] },
    { pattern: /^\s*@import\s+([\w.]+)/, getSource: (m) => m[1] },
  ],

  callPatterns: [
    {
      // Message send `[receiver selector:…]` → receiver.selector (first segment).
      pattern: /\[\s*(\w+)\s+(\w+)[\]:\s]/,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
    },
  ],

  // Raw SQL in string literals (sqlite3 / FMDB-style executeQuery:@"SELECT …").
  extractDataSources: (lines) => extractSqlStringDataSources(lines),
};
