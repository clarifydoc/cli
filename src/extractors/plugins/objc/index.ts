import type { RegexLangSpec } from "../shared/regex-base.js";
import type { ClassInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * Objective-C regex spec. Claims `.m`/`.mm` only — `.h` headers are shared with
 * C/C++ and left to the cpp plugin (an Obj-C header parsed as C is degraded but
 * not broken). Methods are `- (ret)selector…` / `+ (ret)…` with brace bodies;
 * classes come from `@implementation X … @end` (the `@interface` superclass
 * usually lives in the unparsed `.h`, so `extends` is left null here).
 */
export const objcSpec: RegexLangSpec = {
  language: "objc",
  extensions: [".m", ".mm"],
  lineCommentPrefixes: ["//"],

  functionPatterns: [
    {
      // `- (void)viewDidLoad {` / `+ (instancetype)shared` → first selector segment.
      pattern: /^\s*[-+]\s*\([^)]*\)\s*(\w+)/,
      isExported: () => true,
    },
  ],

  classPatterns: [],

  // One class per `@implementation X … @end` (categories `@implementation X (Cat)`
  // attribute to X). Methods are the function clauses inside the block.
  extractClasses: (lines, fns): ClassInfo[] => {
    const classes: ClassInfo[] = [];
    for (let i = 0; i < lines.length; i++) {
      const impl = lines[i].match(/^\s*@implementation\s+(\w+)/);
      if (!impl) continue;
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*@end\b/.test(lines[j])) { end = j + 1; break; }
      }
      classes.push({
        name: impl[1], extends: null, implements: [], decorators: [],
        methods: fns.filter((fn) => fn.line >= i + 1 && fn.line <= end),
        properties: [], isExported: true, line: i + 1, endLine: end,
      });
    }
    return classes;
  },

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
