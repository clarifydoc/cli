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
    expect(members(lap)).toEqual(["constructor(Bay,Int): null", "record(): null", "copy(Bay,Int): Lap @1", "component1(): Bay @1", "component2(): Int @1", "getBay(): Bay @1", "getN(): Int @1"]);
    expect(lap!.methods.find((m) => m.name === "copy")!.params.every((p) => p.defaultValue !== null)).toBe(true);
    // A plain class has no copy() or componentN(), only the accessors Java sees on its properties.
    expect(members(plain)).toEqual(["constructor(Bay): null", "getBay(): Bay @4"]);
  });

  it("gives a Java and a Kotlin enum values() and valueOf(String), except ones it writes", async () => {
    const [position, own] = await classesOf(`public enum Position { KEEPER, STRIKER; String label() { return name(); } }
enum Shape { A; static Shape valueOf(String s) { return A; } }`, "java");
    expect(members(position)).toEqual(["label(): String", "values(): Position[] @1", "valueOf(String): Position @1"]);
    expect(members(own)).toEqual(["valueOf(String): Shape", "values(): Shape[] @2"]);
    const [kt] = await classesOf(`enum class Gear { FIRST, SECOND }`, "kotlin");
    expect(members(kt).filter((m) => m.includes("@"))).toEqual(["values(): Array<Gear> @1", "valueOf(String): Gear @1"]);
  });

  it("gives a Kotlin enum a static entries list of itself, and a Java enum none", async () => {
    const [kt, own] = await classesOf(`enum class Gear { FIRST, SECOND }
enum class Mode { A; val entries: Int = 1 }`, "kotlin");
    expect(kt!.properties.find((p) => p.name === "entries")).toMatchObject({ type: "List<Gear>", isStatic: true });
    expect(own!.properties.filter((p) => p.name === "entries")).toHaveLength(1);
    expect(own!.properties.find((p) => p.name === "entries")!.type).toBe("Int");
    const [java] = await classesOf(`enum Gear { FIRST }`, "java");
    expect(java!.properties.some((p) => p.name === "entries")).toBe(false);
  });

  it("names AutoValue types nested in a record or an enum, and gives @Value.Default a builder setter", async () => {
    const classes = await classesOf(`
record Outer(int x) { @AutoValue abstract static class Inner { abstract int n(); } }
enum Kind { A; @AutoValue abstract static class Deep { abstract int n(); } }
@Value.Immutable
abstract class Club { abstract String name(); @Value.Default int points() { return 0; } int plain() { return 1; } }`, "java");
    const by = new Map(classes.map((c) => [c.name, c]));
    expect(by.has("AutoValue_Outer_Inner")).toBe(true);
    expect(by.has("AutoValue_Kind_Deep")).toBe(true);
    expect(members(by.get("ImmutableClub_Builder"))).toEqual([
      "name(String): ImmutableClub_Builder @5", "points(int): ImmutableClub_Builder @5", "from(Club): ImmutableClub_Builder @4", "build(): ImmutableClub @4",
    ]);
  });

  it("gives an AutoValue class its generated subclass and an Immutables type its Immutable class and builder", async () => {
    const classes = await classesOf(`
@AutoValue
abstract class Club { abstract String name(); }
class Holder { @AutoValue abstract static class Inner { abstract int n(); } }
@Value.Immutable
interface Match {
  @Value.Parameter String home();
  Integer goals();
  default String label() { return home(); }
  static Match none() { return null; }
}
@Immutable
interface Plain { String x(); }
@Value.Immutable
@Value.Style(typeImmutable = "Done*")
interface Styled { String x(); }`, "java");
    const by = new Map(classes.map((c) => [c.name, c]));
    expect(by.get("AutoValue_Club")).toMatchObject({ synthetic: true, extends: "Club" });
    expect(by.has("AutoValue_Holder_Inner")).toBe(true);
    expect(by.get("ImmutableMatch")).toMatchObject({ synthetic: true, implements: ["Match"] });
    expect(members(by.get("ImmutableMatch"))).toEqual([
      "builder(): ImmutableMatch_Builder @5", "copyOf(Match): ImmutableMatch @5", "of(String): ImmutableMatch @5",
      "withHome(String): ImmutableMatch @7", "withGoals(Integer): ImmutableMatch @8",
    ]);
    expect(members(by.get("ImmutableMatch_Builder"))).toEqual([
      "home(String): ImmutableMatch_Builder @7", "goals(Integer): ImmutableMatch_Builder @8", "from(Match): ImmutableMatch_Builder @5", "build(): ImmutableMatch @5",
    ]);
    expect(by.has("ImmutablePlain")).toBe(false);
    expect(by.has("ImmutableStyled")).toBe(false);
  });

  it("gives @Singular the one-element setter, and a @Builder on a constructor or static method its own builder", async () => {
    const classes = await classesOf(`
@Builder
class Team { private String name; @Singular private List<Player> players; @Singular("medal") private Set<Medal> medals; @Singular private Map<String, Integer> scores; }
class Coach {
  @Builder(builderMethodName = "coachBuilder")
  public Coach(String name, int age) {}
  @Builder
  public static Kit kit(String color) { return null; }
  public static Kit plain(String x) { return null; }
}`, "java");
    const by = new Map(classes.map((c) => [c.name, c]));
    expect(members(by.get("TeamBuilder")).map((m) => m.replace(/ @\d+/, ""))).toEqual([
      "name(String): TeamBuilder", "players(List<Player>): TeamBuilder", "player(Player): TeamBuilder",
      "medals(Set<Medal>): TeamBuilder", "medal(Medal): TeamBuilder", "scores(Map<String, Integer>): TeamBuilder", "build(): Team",
    ]);
    expect(members(by.get("Coach")).filter((m) => m.includes("@")).map((m) => m.replace(/ @\d+/, ""))).toEqual(["coachBuilder(): CoachBuilder", "builder(): KitBuilder"]);
    expect(members(by.get("CoachBuilder")).map((m) => m.replace(/ @\d+/, ""))).toEqual(["name(String): CoachBuilder", "age(int): CoachBuilder", "build(): Coach"]);
    expect(members(by.get("KitBuilder")).map((m) => m.replace(/ @\d+/, ""))).toEqual(["color(String): KitBuilder", "build(): Kit"]);
  });
});
