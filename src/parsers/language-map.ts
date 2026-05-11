import type { Language } from "../types/analysis.js";

/** Map file extensions to Language */
export const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".cs": "csharp",
  ".py": "python",
  ".pyw": "python",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".pas": "pascal",
  ".pp": "pascal",
  ".lpr": "pascal",
  ".dpr": "pascal",
  ".dpk": "pascal",
  ".dfm": "dfm",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".lua": "lua",
  ".scala": "scala",
  ".pl": "perl",
  ".pm": "perl",
  ".vb": "vb",
  ".bas": "vb",
  ".cls": "vb",
  ".frm": "vb",
};

/** Get language for a file path based on its extension */
export function getLanguageForFile(filePath: string): Language | null {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot < 0) return null;
  const ext = filePath.slice(lastDot);
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}
