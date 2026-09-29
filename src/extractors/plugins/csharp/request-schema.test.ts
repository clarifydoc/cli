import { describe, it, expect } from "vitest";
import { camelCase, csharpRequestSchema as h } from "./request-schema.js";

describe("C# request-schema hooks", () => {
  it("camelCase follows System.Text.Json's policy", () => {
    expect(camelCase("Name")).toBe("name");
    expect(camelCase("ID")).toBe("id");
    expect(camelCase("URLValue")).toBe("urlValue");
    expect(camelCase("already")).toBe("already");
    expect(camelCase("X")).toBe("x");
  });

  it("classifies scalars, collections, maps, nullables and unknown objects", () => {
    expect(h.unwrapNullable("int?")).toEqual({ type: "int", nullable: true });
    expect(h.unwrapNullable("Nullable<Guid>")).toEqual({ type: "Guid", nullable: true });
    expect(h.describeType("System.DateTime")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(h.describeType("long")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int64" } });
    expect(h.describeType("IReadOnlyList<Address>")).toEqual({ kind: "array", element: "Address" });
    expect(h.describeType("Address[]")).toEqual({ kind: "array", element: "Address" });
    expect(h.describeType("Dictionary<string, List<int>>")).toEqual({ kind: "map", value: "List<int>" });
    expect(h.describeType("object")).toEqual({ kind: "any" });
    expect(h.describeType("Models.CreateUserDto")).toEqual({ kind: "object", name: "Models.CreateUserDto" });
  });

  it("reads wire names and required/ignored markers from property attributes", () => {
    const p = (decorators: string[], extra = {}) => ({
      name: "StartDate", type: "DateTime", visibility: "public" as const, isStatic: false, isReadonly: false, decorators, ...extra,
    });
    expect(h.serializedName(p(['JsonPropertyName("start_date")']))).toBe("start_date");
    expect(h.serializedName(p(['Newtonsoft.Json.JsonProperty("sd")']))).toBe("sd");
    expect(h.serializedName(p([]))).toBe("startDate");
    expect(h.isRequired(p(["Required"]))).toBe(true);
    expect(h.isRequired(p(['Required(ErrorMessage = "x")']))).toBe(true);
    expect(h.isRequired(p([], { isRequired: true }))).toBe(true);
    expect(h.isRequired(p(["RequiredIf"]))).toBe(false);
    expect(h.isSerialized(p(["JsonIgnore"]))).toBe(false);
    expect(h.isSerialized(p([], { visibility: "private" }))).toBe(false);
    expect(h.isSerialized(p([]))).toBe(true);
  });
});
