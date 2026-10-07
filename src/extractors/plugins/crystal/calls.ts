import type { FunctionInfo } from "../../../types/analysis.js";
import type { CallPattern } from "../shared/regex-base.js";

/**
 * Crystal call shapes beyond the baseline `name(`. Parentheses are optional,
 * as in Ruby, so only the paren-less shapes that carry their own evidence of
 * being calls — an attribute read and a zero-arity call are the same syntax.
 */
export const CRYSTAL_CALL_PATTERNS: CallPattern[] = [
  {
    // A constant receiver: `User.find(id)`, `UserQuery.new.email`, `HTTP::Client.get`.
    pattern: /(?<![\w.@:])((?:[A-Z]\w*::)*[A-Z]\w*)\.([a-z_]\w*[?!]?)/,
    buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2]! }),
  },
  {
    // `user.valid?`, `post.save!` — `?`/`!` name a method, never a field.
    pattern: /(?<![\w.@$])@?(\w+)\.(\w+[?!])/,
    buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2]! }),
  },
  {
    // A statement that is just `receiver.method` — `post.save`, `@repo.reload`.
    pattern: /^\s*@?(\w+)\.([a-z_]\w*)\s*$/,
    buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2]! }),
  },
];

/**
 * Names a variable is typed by when the body binds it: `repo = UserRepo.new`,
 * `repo : Repo = …`, and a lookup that returns one instance of its receiver
 * (`order = Order.find!(id)`, `Post.create(…)`).
 */
export function extractCrystalLocalTypes(bodyLines: string[]): NonNullable<FunctionInfo["localTypes"]> {
  const out: NonNullable<FunctionInfo["localTypes"]> = [];
  const seen = new Set<string>();
  for (const line of bodyLines) {
    const m = /^\s*([a-z_]\w*)\s*(?::\s*([A-Z][\w:]*)\??\s*)?=\s*(?:([A-Z][\w:]*)(?:\([^)]*\))?\.(?:new|find!?|find_by!?|first!?|last!?|create!?)(?![\w!?]))?/.exec(line);
    const type = m?.[2] ?? m?.[3];
    if (m && type && !seen.has(m[1]!)) {
      seen.add(m[1]!);
      out.push({ name: m[1]!, type });
    }
  }
  return out;
}
