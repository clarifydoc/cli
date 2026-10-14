/**
 * Argument checks against a tool's `inputSchema`, before its handler runs.
 *
 * The argument helpers in `format.ts` are lenient on purpose — `"20"` is a
 * number, `"Api"` matches `api`, one string is a one-item list — because a model
 * that spells a value loosely still means it. What they cannot do is notice a
 * value that means nothing: a misspelt key (`paths`) or an enum value that
 * matches none (`kind: "backend"`) was read as "no filter", and the agent got
 * every row back believing it had filtered. Those are what this rejects, with
 * the nearest valid spelling, so the next call is right.
 *
 * Coercions stay exactly as lenient as the helpers that will read the value.
 */

interface PropertySchema {
  type?: string;
  enum?: readonly string[];
  items?: PropertySchema;
}

interface ObjectSchema {
  properties?: Record<string, PropertySchema>;
  additionalProperties?: boolean;
}

/** Edit distance, for "did you mean". Small inputs only. */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** The closest of `options` to `value`, when it is close enough to be a typo. */
export function nearest(value: string, options: readonly string[]): string | undefined {
  const v = value.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const option of options) {
    const o = option.toLowerCase();
    const d = o.startsWith(v) || v.startsWith(o) ? Math.min(1, distance(v, o)) : distance(v, o);
    if (d < bestDistance) {
      best = option;
      bestDistance = d;
    }
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(value.length / 3)) ? best : undefined;
}

const hint = (value: string, options: readonly string[]) => {
  const near = nearest(value, options);
  return near ? ` — did you mean \`${near}\`?` : "";
};

function checkEnum(name: string, value: unknown, allowed: readonly string[]): string | null {
  const text = typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
  if (text === null) return `\`${name}\` must be one of ${allowed.map((a) => `\`${a}\``).join(", ")}.`;
  if (text === "" || allowed.some((a) => a.toLowerCase() === text.toLowerCase())) return null;
  return `\`${name}\`: \`${text}\` is not one of ${allowed.map((a) => `\`${a}\``).join(", ")}${hint(text, allowed)}`;
}

function checkProperty(name: string, value: unknown, schema: PropertySchema): string | null {
  if (value === undefined || value === null) return null;
  switch (schema.type) {
    case "number":
    case "integer": {
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      return Number.isFinite(n) ? null : `\`${name}\` must be a number, got ${JSON.stringify(value)}.`;
    }
    case "boolean":
      return typeof value === "boolean" || (typeof value === "string" && /^(true|false|yes|no|1|0)$/i.test(value))
        ? null
        : `\`${name}\` must be true or false, got ${JSON.stringify(value)}.`;
    case "array": {
      // One string, or a comma-separated one, is accepted as a list (stringArrayArg).
      const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
      if (!items) return `\`${name}\` must be a list, got ${JSON.stringify(value)}.`;
      const allowed = schema.items?.enum;
      if (!allowed) return null;
      for (const item of items) {
        const problem = checkEnum(`${name}[]`, item, allowed);
        if (problem) return problem;
      }
      return null;
    }
    case "string":
      return schema.enum ? checkEnum(name, value, schema.enum) : null;
    default:
      return null;
  }
}

/**
 * Problems with `args` for a tool whose input schema is `schema`, as sentences
 * an agent can act on; empty when the call is fine. Required arguments are left
 * to the handlers, which already name what is missing.
 */
export function validateArguments(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const { properties = {}, additionalProperties } = schema as ObjectSchema;
  const known = Object.keys(properties);
  const problems: string[] = [];
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!property) {
      if (additionalProperties === false) {
        problems.push(
          known.length
            ? `Unknown argument \`${name}\`${hint(name, known) || "."} This tool takes: ${known.map((k) => `\`${k}\``).join(", ")}.`
            : `Unknown argument \`${name}\`: this tool takes no arguments.`,
        );
      }
      continue;
    }
    const problem = checkProperty(name, value, property);
    if (problem) problems.push(problem);
  }
  return problems;
}
