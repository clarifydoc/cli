import type { FileAnalysis } from "../../../types/analysis.js";

/**
 * Rails loads a constant from the file its name spells (Zeitwerk): no
 * `require` names `app/models/club/match_report.rb`, the first use of
 * `Club::MatchReport` loads it. So the constants a file names are its imports.
 * Leaf code: types only.
 */

/** `Club::MatchReport` → `club/match_report` (ActiveSupport's `underscore`). */
export function underscoreConstant(constant: string): string {
  return constant
    .replace(/::/g, "/")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * The directories Zeitwerk loads from: every directory directly under `app/`
 * (models, services, jobs, …), its `concerns/`, and `lib/` — wherever the
 * application sits (`enterprise/app/models/`, an engine's `app/`).
 */
const AUTOLOAD_ROOT = /(?:^|\/)(?:app\/[^/]+\/(?:concerns\/)?|lib\/)$/;

/** A constant path as written: `Club`, `Club::MatchReport`, `::Club`. */
const CONSTANT_HEAD = /^(?:::)?([A-Z]\w*(?:::[A-Z]\w*)*)/;

function constantsOf(analysis: FileAnalysis): Set<string> {
  const out = new Set<string>();
  const add = (text: string | undefined) => {
    const m = text?.trim().match(CONSTANT_HEAD);
    if (m) out.add(m[1]!);
  };
  for (const ref of analysis.typeReferences ?? []) add(ref.rawType);
  for (const fn of analysis.functions) for (const call of fn.calls ?? []) add(call.name);
  for (const cls of analysis.classes) {
    add(cls.extends ?? undefined);
    for (const i of cls.implements ?? []) add(i);
    for (const m of cls.methods ?? []) for (const call of m.calls ?? []) add(call.name);
  }
  return out;
}

/**
 * The files the constants `analysis` names are loaded from. A constant is
 * looked up in each namespace the file's own classes open (`Document` inside
 * `Captain::Scenario` is `Captain::Scenario::Document`, `Captain::Document`,
 * then `Document`), as Ruby resolves it lexically.
 */
export function rubyAutoloadedFiles(analysis: FileAnalysis, filesEndingWith: (suffix: string) => readonly string[]): string[] {
  const nesting = new Set<string>();
  for (const cls of analysis.classes) {
    const parts = cls.name.split("::");
    for (let i = parts.length; i > 0; i--) nesting.add(parts.slice(0, i).join("::"));
  }
  const out = new Set<string>();
  for (const constant of constantsOf(analysis)) {
    for (const scope of ["", ...nesting]) {
      const path = `${underscoreConstant(scope ? `${scope}::${constant}` : constant)}.rb`;
      for (const file of filesEndingWith(path)) {
        if (file !== analysis.filePath && AUTOLOAD_ROOT.test(file.slice(0, file.length - path.length))) out.add(file);
      }
    }
  }
  return [...out];
}

/** `match_report` / `@match_report` → `MatchReport`: the class a Ruby local's name states by convention. */
export function rubyTypeNamedByReceiver(receiver: string): string | null {
  const m = receiver.match(/^@{0,2}([a-z][a-z\d]*(?:_[a-z\d]+)*)$/);
  if (!m) return null;
  return m[1]!.split("_").map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
}
