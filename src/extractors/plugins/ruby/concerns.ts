import type { ClassInfo } from "../../../types/analysis.js";
import { rubyLexicalConstants } from "./autoload.js";
import { rubyBlockEndsOf } from "./blocks.js";

/**
 * A Rails concern's class methods. `class_methods do … end` defines the
 * concern's `ClassMethods` module, which ActiveSupport::Concern extends every
 * includer with — as does a hand-written `module ClassMethods` in a concern, or
 * beside `def self.included(base) base.extend(ClassMethods)`. So
 * `Conversation.sort_on_created_at` runs a method the concern declares, while
 * `SortHandler.sort_on_created_at` runs nothing. The block becomes the
 * `ClassMethods` module it defines (its methods leave the concern's own list),
 * and the concern states that its includers are extended with it
 * (`ClassInfo.includerExtends`); the linker puts its members on the class side
 * of each includer.
 */
export function addConcernClassMethods(lines: readonly string[], classes: ClassInfo[]): void {
  if (!lines.some((l) => /^\s*(?:class_methods\s+do|module\s+ClassMethods)\b/.test(l))) return;
  const ends = rubyBlockEndsOf(lines);
  for (const cls of [...classes]) {
    if (!/^\s*module\s/.test(lines[cls.line - 1] ?? "")) continue;
    const nested = classes.filter((c) => c !== cls && c.line > cls.line && c.endLine <= cls.endLine);
    const inNested = (i: number) => nested.some((c) => i + 1 >= c.line && i + 1 <= c.endLine);
    // A `module ClassMethods` directly in the concern (not in a module nested deeper).
    let classMethods = nested.find((c) => c.name === "ClassMethods" && !nested.some((o) => o !== c && o.line < c.line && c.endLine <= o.endLine));
    let concern = false;
    let extendsIncluders = false;
    for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
      if (inNested(i)) continue;
      const line = lines[i]!;
      if (/^\s*extend\s+(?:::)?ActiveSupport::Concern\b/.test(line)) concern = true;
      else if (/\bbase\.extend\s*\(?\s*ClassMethods\b/.test(line)) extendsIncluders = true;
      if (!/^\s*class_methods\s+do\b/.test(line)) continue;
      const end = ends.get(i);
      if (end === undefined) continue;
      const moved = cls.methods.filter((m) => m.line > i + 1 && m.line <= end);
      cls.methods = cls.methods.filter((m) => !moved.includes(m));
      if (classMethods) {
        // A second block adds to the module the first one defined.
        classMethods.methods.push(...moved);
      } else {
        classMethods = { name: "ClassMethods", extends: null, implements: [], decorators: [], methods: moved, properties: [], isExported: true, line: i + 1, endLine: end };
        classes.push(classMethods);
      }
      i = end - 1;
      extendsIncluders = true;
    }
    if (classMethods && (concern || extendsIncluders)) cls.includerExtends = [`${rubyLexicalConstants.pathOf(cls, classes)}::ClassMethods`];
  }
  classes.sort((a, b) => a.line - b.line);
}
