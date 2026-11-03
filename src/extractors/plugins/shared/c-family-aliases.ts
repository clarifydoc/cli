import type { TypeAliasInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "./regex-base.js";

/** `using Ride = Car;`, `using CarPtr = std::shared_ptr<Car>;` (not a `using namespace` or `using a::b;`). */
const USING_ALIAS = /^\s*using\s+([A-Za-z_]\w*)\s*(?:\[\[[^\]]*\]\]\s*)?=\s*(?:typename\s+)?([^;{}]+);/;
/** `typedef Car Motor;`, `typedef struct car car_t;`, `typedef const Car* CarRef;` — one declarator, no function pointer. */
const TYPEDEF = /^\s*typedef\s+((?:(?:const|volatile|struct|class|union|enum|typename)\s+)*[A-Za-z_][\w:]*(?:\s*<[^;{}()]*>)?(?:\s*::\s*[A-Za-z_]\w*)*(?:\s*(?:const\b|[*&]))*)\s*([A-Za-z_]\w*)\s*;/;
/** A class head: `class Car {`, `struct CLUB_API Car : public Base`, `typedef struct car {` — its name, if any. */
const CLASS_HEAD = /^\s*(?:template\s*<[^>]*>\s*)?(typedef\s+)?(?:class|struct|union)\s+(?:[A-Z][A-Z0-9_]+\s+)?([A-Za-z_]\w*)?(?![\w:]*\s*;)/;
const NAMESPACE_HEAD = /^\s*(?:inline\s+)?namespace\b|^\s*extern\s+"C(?:\+\+)?"\s*\{?\s*$/;

interface Scope {
  kind: "namespace" | "class" | "block";
  /** A class's name (empty for an anonymous one). */
  name: string;
  /** `typedef struct car { … } car_t;`: the struct whose closing line names the alias. */
  typedefOf?: string;
}

/**
 * The type aliases a C or C++ file declares outside function bodies, the aliased type as written (core normalizes
 * it and unwraps the language's wrappers, so `std::shared_ptr<Car>` stands for `Car`):
 *
 *   using Ride = Car;                    → Ride  = Car
 *   typedef Car Motor;                   → Motor = Car
 *   using CarPtr = std::shared_ptr<Car>; → CarPtr = std::shared_ptr<Car>
 *   typedef struct car car_t;            → car_t = car
 *   typedef struct car { … } car_t;      → car_t = car
 *
 * One declared inside a class is named by the class's path (`Garage::Ptr`), as a nested class is. A template
 * alias, a function-pointer typedef and an anonymous struct's typedef are left out.
 */
export function extractCFamilyTypeAliases(lines: readonly string[]): TypeAliasInfo[] {
  const out: TypeAliasInfo[] = [];
  if (!lines.some((l) => /\b(?:using|typedef)\b/.test(l))) return out;
  const stack: Scope[] = [];
  let pending: Scope | null = null;
  let comment = false;
  let previous = "";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (comment) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      line = " ".repeat(end + 2) + line.slice(end + 2);
      comment = false;
    }
    line = blankStringLiterals(line.replace(/\/\*.*?\*\//g, (c) => " ".repeat(c.length)), ["//"]);
    const open = line.indexOf("/*");
    if (open >= 0) { line = line.slice(0, open); comment = true; }
    if (/^\s*#/.test(line)) continue;

    const outsideBodies = stack.every((s) => s.kind !== "block");
    if (outsideBodies && !/^\s*template\b/.test(previous)) {
      const classPath = stack.filter((s) => s.kind === "class").map((s) => s.name);
      const named = (name: string): string | null => (classPath.some((n) => !n) ? null : [...classPath, name].join("::"));
      const using = /^\s*template\b/.test(line) ? null : USING_ALIAS.exec(line);
      const typedef = using ? null : TYPEDEF.exec(line);
      const alias = using ? { name: using[1]!, type: using[2]! } : typedef ? { name: typedef[2]!, type: typedef[1]! } : null;
      const type = alias?.type.replace(/\b(?:struct|class|union|enum|typename)\s+/g, "").replace(/\s+/g, " ").trim();
      const name = alias ? named(alias.name) : null;
      if (alias && name && type && type !== alias.name) out.push({ name, type, line: i + 1 });
      // `typedef struct car { int speed; } car_t;` on one line.
      const whole = /^\s*typedef\s+(?:struct|union)\s+([A-Za-z_]\w*)\s*\{[^{}]*\}\s*([A-Za-z_]\w*)\s*;/.exec(line);
      const wholeName = whole && whole[1] !== whole[2] ? named(whole[2]!) : null;
      if (whole && wholeName) out.push({ name: wholeName, type: whole[1]!, line: i + 1 });
    }

    // A `typedef struct car {` block closing on this line with the alias: `} car_t;`.
    const top = stack.at(-1);
    if (top?.typedefOf && /^\s*\}/.test(line)) {
      const m = /^\s*\}\s*([A-Za-z_]\w*)\s*[;,]/.exec(line);
      if (m && m[1] !== top.typedefOf && stack.slice(0, -1).every((s) => s.kind !== "block")) {
        const path = [...stack.slice(0, -1).filter((s) => s.kind === "class").map((s) => s.name), m[1]!].join("::");
        out.push({ name: path, type: top.typedefOf, line: i + 1 });
      }
    }

    // Scopes this line opens and closes.
    const head = CLASS_HEAD.exec(line);
    if (NAMESPACE_HEAD.test(line) && !/=/.test(line)) pending = { kind: "namespace", name: "" };
    else if (head && !/^\s*(?:typedef|using)\b[^{]*;/.test(line) && !/\)\s*(?:const\s*)?\{?\s*$/.test(line)) {
      pending = { kind: "class", name: head[2] ?? "", ...(head[1] && head[2] ? { typedefOf: head[2] } : {}) };
    }
    for (const ch of line) {
      if (ch === "{") {
        stack.push(pending ?? { kind: "block", name: "" });
        pending = null;
      } else if (ch === "}") {
        stack.pop();
      } else if (ch === ";" && pending) {
        pending = null;
      }
    }
    if (line.trim()) previous = line;
  }
  return out;
}
