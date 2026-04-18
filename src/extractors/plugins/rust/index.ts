import type { RegexLangSpec } from "../shared/regex-base.js";

export const rustSpec: RegexLangSpec = {
  language: "rust",
  indentBased: false,
  lineCommentPrefixes: ["//"],

  functionPatterns: [
    {
      pattern: /(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_]\w*)\s*[<(]/,
      isExported: (line) => line.trimStart().startsWith("pub"),
      isAsync: (line) => line.includes("async "),
    },
  ],

  classPatterns: [
    { pattern: /(?:pub\s+)?struct\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /(?:pub\s+)?enum\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /(?:pub\s+)?trait\s+([A-Z]\w*)/, getExtends: () => null },
  ],

  importPatterns: [
    {
      pattern: /^\s*use\s+(.+);/,
      getSource: (m) => m[1].replace(/::\{.*/, "").replace(/::\*$/, ""),
      getSpecifiers: (m) => {
        const braces = m[1].match(/\{([^}]+)\}/);
        if (braces) return braces[1].split(",").map((s) => s.trim().split(" as ").pop()!.trim());
        const parts = m[1].replace(/;$/, "").split("::");
        return [parts[parts.length - 1].replace(/\*/, "")].filter(Boolean);
      },
    },
  ],
};
