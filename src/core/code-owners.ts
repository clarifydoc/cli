import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { isIgnored, parseIgnorePattern } from "./clarifydoc-ignore.js";

/** One CODEOWNERS line: a gitignore-style pattern and who owns what it matches. */
export interface CodeOwnersRule {
  pattern: string;
  owners: string[];
}

/** Where GitHub, GitLab and Bitbucket look for the file, in their order. */
const LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS", ".gitlab/CODEOWNERS", ".bitbucket/CODEOWNERS"];

/**
 * The CODEOWNERS rules at a project root — the first file of the usual
 * locations — or null. A rule with no owners stays: it un-owns what it
 * matches. GitLab `[Section]` headers are skipped; their rules still count.
 */
export function loadCodeOwners(root: string): { file: string; rules: CodeOwnersRule[] } | null {
  for (const file of LOCATIONS) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const rules: CodeOwnersRule[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/(^|\s)#.*$/, "").trim();
      if (!line || /^\^?\[[^\]]*\]/.test(line)) continue;
      const [pattern, ...owners] = line.split(/\s+/);
      if (pattern) rules.push({ pattern, owners: owners.filter((o) => /^@|@/.test(o)) });
    }
    return { file, rules };
  }
  return null;
}

/** The owners of a project-relative path: the LAST matching rule wins, as on every forge. */
export function ownersOf(rules: readonly CodeOwnersRule[], relPath: string): string[] {
  const root = "/__codeowners__";
  let owners: string[] = [];
  for (const rule of rules) {
    const p = parseIgnorePattern(rule.pattern === "*" ? "**" : rule.pattern, root);
    if (p && isIgnored(`${root}/${relPath}`, root, [{ ...p, negated: false }])) owners = rule.owners;
  }
  return owners;
}
