import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinExtractor } from "./functions-classes.js";
import type { ClassInfo } from "../../../types/analysis.js";

async function classesOf(src: string, lang: "java" | "kotlin"): Promise<ClassInfo[]> {
  const tree = await parseSource(src, lang as any, lang === "java" ? "X.java" : "X.kt");
  return new JavaKotlinExtractor().extractClasses(tree, src);
}

const members = (cls: ClassInfo | undefined) =>
  (cls?.methods ?? []).map((m) => `${m.name}(${m.params.map((p) => p.type).join(",")}): ${m.returnType}${m.synthetic ? " @" + m.line : ""}`);

describe("JVM synthesized members", () => {
  it("gives a Lombok @Data class getters and setters for its fields, a final field no setter", async () => {
    const [car] = await classesOf(`import lombok.Data;
@Data
public class Car {
  private Engine engine;
  private final String plate;
  private boolean electric;
  private boolean isLeased;
  private static int count;
  public String getPlate() { return plate; }
}`, "java");
    expect(members(car)).toEqual([
      "getPlate(): String",
      "getEngine(): Engine @4",
      "setEngine(Engine): void @4",
      "isElectric(): boolean @6",
      "setElectric(boolean): void @6",
      "isLeased(): boolean @7",
      "setLeased(boolean): void @7",
    ]);
  });

  it("reads field-level @Getter/@Setter, AccessLevel.NONE, @Value and fluent @Accessors", async () => {
    const [van, coupe, kart] = await classesOf(`
public class Van {
  @Getter private Tyre spare;
  @Setter private Tyre other;
  private Tyre none;
}
@Value
@Getter
class Coupe {
  Engine engine;
  @Getter(AccessLevel.NONE) String secret;
}
@Data
@Accessors(fluent = true)
class Kart { private Engine engine; }`, "java");
    expect(members(van)).toEqual(["getSpare(): Tyre @3", "setOther(Tyre): void @4"]);
    expect(members(coupe)).toEqual(["getEngine(): Engine @10"]);
    expect(members(kart)).toEqual(["engine(): Engine @15", "engine(Engine): Kart @15"]);
  });

  it("builds a Lombok @Builder's builder class, and leaves a builder class the source writes alone", async () => {
    const classes = await classesOf(`
@Builder
public class Car {
  private Engine engine;
  private String plate;
}
@Builder(toBuilder = true)
class Bus {
  private Engine engine;
  public static class BusBuilder { public BusBuilder engine(Engine e) { return this; } }
}`, "java");
    const byName = new Map(classes.map((c) => [c.name, c]));
    expect(members(byName.get("Car"))).toEqual(["builder(): CarBuilder @2"]);
    expect(byName.get("CarBuilder")?.synthetic).toBe(true);
    expect(members(byName.get("CarBuilder"))).toEqual(["engine(Engine): CarBuilder @4", "plate(String): CarBuilder @5", "build(): Car @2"]);
    expect(members(byName.get("Bus"))).toEqual(["builder(): BusBuilder @7", "toBuilder(): BusBuilder @7"]);
    expect(byName.get("BusBuilder")?.synthetic).toBeUndefined();
  });

  it("gives a record its accessors, except one it writes", async () => {
    const [grid] = await classesOf(`public record Grid(Engine engine,
    Tyre tyre) {
  public Tyre tyre() { return tyre; }
}`, "java");
    expect(members(grid)).toEqual(["tyre(): Tyre", "engine(): Engine @1"]);
  });

  it("gives a Kotlin data class copy() with every property optional, and componentN()", async () => {
    const [lap, plain] = await classesOf(`data class Lap(val bay: Bay, val n: Int) {
  fun record() {}
}
class Pit(val bay: Bay)`, "kotlin");
    expect(members(lap)).toEqual(["constructor(Bay,Int): null", "record(): null", "copy(Bay,Int): Lap @1", "component1(): Bay @1", "component2(): Int @1"]);
    expect(lap!.methods.find((m) => m.name === "copy")!.params.every((p) => p.defaultValue !== null)).toBe(true);
    expect(plain!.methods.some((m) => m.synthetic)).toBe(false);
  });
});
