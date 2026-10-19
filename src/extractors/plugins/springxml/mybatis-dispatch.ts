import type { ClassInfo, FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * MyBatis binds a mapper interface's method to the XML statement with the
 * same id in the `<mapper namespace>` naming that interface:
 *
 *     com/acme/mapper/UserMapper.java    User findById(long id);
 *     mapper/UserMapper.xml              <mapper namespace="com.acme.mapper.UserMapper">
 *                                          <select id="findById">SELECT … FROM users …
 *
 * A call `userMapper.findById(id)` already reaches the interface method
 * through the linker; this adds the hop from that method to its statement, so
 * a trace goes on to the table. Both ends are stated (the namespace is the
 * interface's fully qualified name, the id its method name), so the link is
 * EXTRACTED. The interface is found by the path its name implies, or by
 * simple name when exactly one interface carries it.
 */
export class MyBatisMapperResolver implements DispatchResolver {
  readonly id = "mybatis";
  readonly languages: Language[] = ["springxml", "java", "kotlin"];
  readonly priority = 55;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const mappers = analyses.filter((a) => a.language === "springxml" && a.functions.some((f) => f.decorators.some((d) => /namespace = "/.test(d))));
    if (mappers.length === 0) return [];

    const interfaces = new Map<string, Array<{ file: string; cls: ClassInfo }>>();
    for (const a of analyses) {
      if (a.language !== "java" && a.language !== "kotlin") continue;
      for (const cls of a.classes) {
        if (cls.kind !== "interface") continue;
        (interfaces.get(cls.name) ?? interfaces.set(cls.name, []).get(cls.name)!).push({ file: a.filePath, cls });
      }
    }

    const links: SymbolLink[] = [];
    for (const m of mappers) {
      for (const fn of m.functions) {
        const ns = fn.decorators.map((d) => /namespace = "([^"]+)"/.exec(d)?.[1]).find(Boolean);
        if (!ns) continue;
        const simple = ns.split(".").pop()!;
        const candidates = interfaces.get(simple) ?? [];
        const byPath = candidates.filter((c) => /\.(java|kt)$/.test(c.file) && c.file.replace(/\.(java|kt)$/, "").endsWith(ns.replace(/\./g, "/")));
        const owner = byPath.length === 1 ? byPath[0] : byPath.length === 0 && candidates.length === 1 ? candidates[0] : undefined;
        const method = owner?.cls.methods.find((x) => x.name === fn.name);
        if (!owner || !method) continue;
        links.push({
          sourceFile: owner.file,
          sourceSymbol: `${owner.cls.name}.${method.name}`,
          sourceLine: method.line,
          callName: method.name,
          targetFile: m.filePath,
          targetSymbol: fn.name,
          targetLine: fn.line,
          resolvedBy: "text",
          confidence: "EXTRACTED",
          relation: "dispatch",
        });
      }
    }
    return links;
  }
}
