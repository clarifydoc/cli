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
class Repo(val repo: PlayerRepository) {
  fun m(player: Player) {
${body}
  }
}`
      : `package x;
class Repo {
  void m(Player player) {
${body}
  }
}`;
  const tree = await parseSource(src, lang as any, `Repo.${ext}`);
  return new JavaKotlinMutationExtractor().extract(tree, src);
}

describe("Kotlin data mutations (call_expression has no name field — was 0 mutations)", () => {
  it("captures repository writes in Kotlin", async () => {
    const m = await mutationsOf(`    repo.save(player)\n    repo.deleteById(player.id)`, "kotlin");
    const writes = m.filter((x) => x.kind === "db-write");
    expect(writes).toHaveLength(2);
    expect(writes[0]!.target).toContain("save");
  });

  it("captures Kotlin setter calls", async () => {
    const m = await mutationsOf(`    player.setName("x")`, "kotlin");
    expect(m.some((x) => x.kind === "assignment" && x.target === "setName")).toBe(true);
  });

  it("still captures Java repository writes (field-based path)", async () => {
    const m = await mutationsOf(`    repo.save(player);`, "java");
    expect(m.some((x) => x.kind === "db-write")).toBe(true);
  });
});

describe("setter-shaped calls that assign no property", () => {
  it("skips JDBC parameter binding, two-argument drawing calls and Kotlin's setOf", async () => {
    const m = await mutationsOf(`    stmt?.setInt(1, player.id)
    page.setFont(Fonts.COURIER, 12f)
    val positions = setOf(Position.KEEPER, Position.STRIKER)
    player.setClub(club)
    button.setOnClickListener { println("kick-off") }`, "kotlin");
    expect(m.filter((x) => x.kind === "assignment").map((x) => x.target)).toEqual(["setClub", "setOnClickListener"]);
  });

  it("keeps a one-argument Java setter and skips a PreparedStatement binding", async () => {
    const m = await mutationsOf(`    player.setNumber(9);
    ps.setString(2, player.getName());`, "java");
    expect(m.filter((x) => x.kind === "assignment").map((x) => x.target)).toEqual(["setNumber"]);
  });
});
