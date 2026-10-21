import { describe, it, expect } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinExtractor } from "./functions-classes.js";
import { jvmRequestSchema as h } from "./request-schema.js";

describe("JVM request-schema hooks", () => {
  it("classifies scalars, collections, maps, nullables, wrappers and unknown objects", () => {
    expect(h.unwrapNullable("String?")).toEqual({ type: "String", nullable: true });
    expect(h.unwrapNullable("Optional<Long>")).toEqual({ type: "Long", nullable: true });
    expect(h.describeType("java.time.LocalDate")).toEqual({ kind: "scalar", schema: { type: "string", format: "date" } });
    expect(h.describeType("Long")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int64" } });
    expect(h.describeType("BigDecimal")).toEqual({ kind: "scalar", schema: { type: "number" } });
    expect(h.describeType("List<Address>")).toEqual({ kind: "array", element: "Address" });
    expect(h.describeType("MutableList<String>")).toEqual({ kind: "array", element: "String" });
    expect(h.describeType("Address[]")).toEqual({ kind: "array", element: "Address" });
    expect(h.describeType("Map<String, List<Int>>")).toEqual({ kind: "map", value: "List<Int>" });
    expect(h.describeType("Any")).toEqual({ kind: "any" });
    expect(h.describeType("com.x.CreatePlayerDto")).toEqual({ kind: "object", name: "com.x.CreatePlayerDto" });
  });

  it("reads wire names and required/ignored markers from annotations", () => {
    const p = (decorators: string[], extra = {}) => ({
      name: "startDate", type: "LocalDate", visibility: "private" as const, isStatic: false, isReadonly: false, decorators, ...extra,
    });
    expect(h.serializedName(p(['JsonProperty("start_date")']))).toBe("start_date");
    expect(h.serializedName(p(['JsonProperty(value = "sd", required = true)']))).toBe("sd");
    expect(h.serializedName(p(['SerializedName("g")']))).toBe("g");
    expect(h.serializedName(p([]))).toBe("startDate");
    expect(h.isRequired(p(["NotNull"]))).toBe(true);
    expect(h.isRequired(p(['NotBlank(message = "x")']))).toBe(true);
    expect(h.isRequired(p(['JsonProperty(value = "sd", required = true)']))).toBe(true);
    expect(h.isRequired(p([], { isRequired: true }))).toBe(true);
    expect(h.isRequired(p([]))).toBe(false);
    expect(h.isSerialized(p(["JsonIgnore"]))).toBe(false);
    expect(h.isSerialized(p([]))).toBe(true); // private Java fields are still the payload
    expect(h.isSerialized(p([], { isStatic: true }))).toBe(false);
  });
});

describe("JVM class properties for request models", () => {
  const ex = new JavaKotlinExtractor();

  it("Java: field annotations are kept, records expose their components, extends carries the bare name", async () => {
    const SRC = `package x;
public class CreatePlayerDto extends Base {
  @NotNull @JsonProperty("player_name") private String name;
  private List<String> roles;
}
public record Address(String street, @Nullable Integer zip) {}`;
    const tree = await parseSource(SRC, "java" as any, "A.java");
    const [dto, rec] = ex.extractClasses(tree, SRC);
    expect(dto!.extends).toBe("Base");
    expect(dto!.properties[0]).toMatchObject({ name: "name", type: "String", decorators: ["NotNull", 'JsonProperty("player_name")'] });
    expect(dto!.properties[1]!.decorators).toBeUndefined();
    expect(rec!.properties).toEqual([
      { name: "street", type: "String", visibility: "public", isStatic: false, isReadonly: true },
      { name: "zip", type: "Integer", visibility: "public", isStatic: false, isReadonly: true, decorators: ["Nullable"] },
    ]);
  });

  it("Kotlin: primary-constructor val/var become properties; non-null without default is required", async () => {
    const SRC = `package x
data class CreatePlayerDto(
  @field:NotNull @JsonProperty("player_name") val name: String,
  val roles: List<String> = emptyList(),
  var address: Address?,
  ctorOnly: Int,
) : Base()`;
    const tree = await parseSource(SRC, "kotlin" as any, "A.kt");
    const [dto] = ex.extractClasses(tree, SRC);
    expect(dto!.extends).toBe("Base");
    expect(dto!.properties.map((p) => p.name)).toEqual(["name", "roles", "address"]);
    expect(dto!.properties[0]).toMatchObject({ isRequired: true, decorators: ["field:NotNull", 'JsonProperty("player_name")'], isReadonly: true });
    expect(dto!.properties[1]!.isRequired).toBeUndefined();
    expect(dto!.properties[2]).toMatchObject({ type: "Address?", isReadonly: false });
    expect(dto!.properties[2]!.isRequired).toBeUndefined();
  });
});
