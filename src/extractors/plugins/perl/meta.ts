import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { extendRegexControlFlow } from "../../shared/control-flow-defaults.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { perlSpec } from "./index.js";
import { cpanPackages } from "./packages.js";
import { perlManifest } from "./manifest.js";
import { perlRequestSchema } from "./request-schema.js";
import { perlReachability } from "./reachability.js";

/**
 * `.cgi` names a role, not a language: the script may be shell, Python or a
 * compiled binary. Keep it when its `#!` line names perl, or — with no `#!`
 * — when it reads as Perl.
 */
function preprocessCgi(rawSource: string, relativePath: string): { skip: string } | null {
  if (!relativePath.toLowerCase().endsWith(".cgi")) return null;
  if (rawSource.includes("\0")) return { skip: "binary CGI program" };
  const nl = rawSource.indexOf("\n");
  const first = nl < 0 ? rawSource : rawSource.slice(0, nl);
  if (first.startsWith("#!")) return /\bperl\b/.test(first) ? null : { skip: "CGI script in another language" };
  return /^\s*(?:use\s+(?:strict|warnings|CGI)\b|my\s+[$@%])/m.test(rawSource) ? null : { skip: "CGI script in another language" };
}

export const perlMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: perlReachability,
  preprocess: preprocessCgi,
  // Perl: `unless`/`until` are the negated forms, `foreach` is a loop, and `#`
  // is the comment.
  regexControlFlow: extendRegexControlFlow([], {
    lineComments: ["#"],
    blockComment: ["", ""],
    quotes: ['"', "'"],
  }),
  ...perlManifest,
  regexSpec: perlSpec,
  knownPackages: cpanPackages,
  builtinTypes: new Set(COMMON_PRIMITIVES),
  requestSchema: perlRequestSchema,
};
