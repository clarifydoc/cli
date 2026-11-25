import type { FunctionInfo, ImportInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { EffectsCollector } from "../shared/member-effects-kit.js";

/** `raise ClubClosed`, `raise(ClubClosed, "x")`, `raise ClubClosed, message: "x"`, `raise %ClubClosed{}`, `reraise ClubClosed, msg, st`; `raise "text"` and `reraise e, st` name no module. */
const RAISE_RE = /\b(?:raise|reraise)\b(?!\s*:)\s*\(?\s*%?([A-Z][\w]*(?:\.[A-Z]\w*)*)/g;

/** The names the file's `alias` lines give (`alias League.ClubClosed` → `ClubClosed`, `as: Closed`, `alias League.{A, B}`), each to the module it stands for. */
export function elixirAliases(lines: readonly string[], imports: readonly ImportInfo[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const imp of imports) {
    if (!/^\s*alias\b/.test(lines[imp.line - 1] ?? "")) continue;
    for (const name of imp.specifiers) if (!out.has(name)) out.set(name, imp.source);
  }
  return out;
}

/**
 * The exception modules an Elixir function raises (`FunctionInfo.throws`): the module after `raise`/`reraise`, a
 * struct literal's included, its first segment read through the file's `alias` lines (`raise ClubClosed` under
 * `alias League.ClubClosed` is `League.ClubClosed`, the name core indexes the module by), stated `exact`: a module's
 * name is whole, so core never matches it by its last segment. Elixir data is immutable, so
 * no field writes are stated.
 */
export function elixirMemberEffects(lines: readonly string[], fn: FunctionInfo, aliases: ReadonlyMap<string, string>): Pick<FunctionInfo, "fieldWrites" | "throws"> | null {
  const out = new EffectsCollector();
  const last = Math.min(fn.endLine, lines.length);
  for (let ln = fn.line; ln <= last; ln++) {
    const raw = lines[ln - 1] ?? "";
    if (!raw.includes("raise")) continue;
    const code = blankStringLiterals(raw, ["#"]);
    for (const m of code.matchAll(RAISE_RE)) {
      const written = m[1]!;
      const head = written.split(".")[0]!;
      const full = aliases.get(head);
      // A module name is whole: `File.Error` is never a project module named `Error`.
      out.addThrow(full ? full + written.slice(head.length) : written, ln, undefined, true);
    }
  }
  return out.result();
}
