import type { SpecNode } from "./spec-document.js";

/**
 * A Serverless Framework variable text read from the document that states its values. Shared by the
 * serverless plugin (a function's environment) and core's CloudFormation reader (a table resource in a
 * `${file(…)}` include, whose `${self:…}` holes are the INCLUDING descriptor's). No IO.
 */

const childOf = (n: SpecNode | undefined, key: string): SpecNode | undefined => n?.children.get(key);
const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, "");

/** The text with each `${self:a.b}` hole read from `root`, the document that states it; null when anything in the text is set at deploy time. */
export function fillServerlessVariables(text: string, root: SpecNode, depth: number): string | null {
  if (depth > 4) return null;
  let failed = false;
  // `${opt:stage, self:provider.stage}` is the stage a deploy passes, else the descriptor's own default. Every
  // name of the descriptor takes the same default, so a table and the variable naming it still agree.
  const withDefaults = text.replace(/\$\{opt:[\w.-]+\s*,\s*(self:[\w.-]+|'[^'$}]*'|"[^"$}]*")\s*\}/g, (_h, dflt: string) =>
    dflt.startsWith("self:") ? `\${${dflt}}` : unquote(dflt));
  const out = withDefaults.replace(/\$\{self:([\w.-]+)\}/g, (_h, path: string) => {
    let node: SpecNode | undefined = root;
    for (const key of path.split(".")) node = childOf(node, key);
    // `service: { name: clubs }` is the framework's long form of `service: clubs`.
    const v = node?.value ?? childOf(node, "name")?.value ?? null;
    const filled = v === null ? null : fillServerlessVariables(unquote(v), root, depth + 1);
    if (filled === null) failed = true;
    return filled ?? "";
  });
  return failed || out.includes("${") || out.length === 0 ? null : out;
}

