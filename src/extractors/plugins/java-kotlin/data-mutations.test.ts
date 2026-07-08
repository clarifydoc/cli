import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinMutationExtractor } from "./data-mutations.js";
import type { DataMutationInfo, Language } from "../../../types/analysis.js";

async function mutationsOf(body: string, lang: Language): Promise<DataMutationInfo[]> {
  const ext = lang === "kotlin" ? "kt" : "java";
  const src =
    lang === "kotlin"
      ? `package x
class Repo(val repo: UserRepository) {
  fun m(user: User) {
${body}
  }
}`
      : `package x;
class Repo {
  void m(User user) {
${body}
  }
}`;
  const tree = await parseSource(src, lang as any, `Repo.${ext}`);
  return new JavaKotlinMutationExtractor().extract(tree, src);
}

describe("Kotlin data mutations (call_expression has no name field — was 0 mutations)", () => {
  it("captures repository writes in Kotlin", async () => {
    const m = await mutationsOf(`    repo.save(user)\n    repo.deleteById(user.id)`, "kotlin");
    const writes = m.filter((x) => x.kind === "db-write");
    expect(writes).toHaveLength(2);
    expect(writes[0]!.target).toContain("save");
  });

  it("captures Kotlin setter calls", async () => {
    const m = await mutationsOf(`    user.setName("x")`, "kotlin");
    expect(m.some((x) => x.kind === "assignment" && x.target === "setName")).toBe(true);
  });

  it("still captures Java repository writes (field-based path)", async () => {
    const m = await mutationsOf(`    repo.save(user);`, "java");
    expect(m.some((x) => x.kind === "db-write")).toBe(true);
  });
});
