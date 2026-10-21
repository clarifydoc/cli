import { describe, it, expect } from "vitest";
import { goRequestSchema as h } from "./request-schema.js";

const route = { path: "/players/{id}", httpMethod: "GET", kind: "api" as const, handler: null, calls: [], middleware: [], line: 1 };

describe("Go request-schema hooks", () => {
  it("classifies scalars, slices, arrays, maps, pointers and unknown structs", () => {
    expect(h.unwrapNullable("*Address")).toEqual({ type: "Address", nullable: true });
    expect(h.unwrapNullable("string")).toEqual({ type: "string", nullable: false });
    expect(h.describeType("string")).toEqual({ kind: "scalar", schema: { type: "string" } });
    expect(h.describeType("int")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int64" } });
    expect(h.describeType("int32")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int32" } });
    expect(h.describeType("float64")).toEqual({ kind: "scalar", schema: { type: "number", format: "double" } });
    expect(h.describeType("bool")).toEqual({ kind: "scalar", schema: { type: "boolean" } });
    expect(h.describeType("[]byte")).toEqual({ kind: "scalar", schema: { type: "string", format: "byte" } });
    expect(h.describeType("time.Time")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(h.describeType("time.Duration")).toEqual({ kind: "scalar", schema: { type: "string", format: "duration" } });
    expect(h.describeType("uuid.UUID")).toEqual({ kind: "scalar", schema: { type: "string", format: "uuid" } });
    expect(h.describeType("[]store.Part")).toEqual({ kind: "array", element: "store.Part" });
    expect(h.describeType("[3]int")).toEqual({ kind: "array", element: "int" });
    expect(h.describeType("map[string]Address")).toEqual({ kind: "map", value: "Address" });
    expect(h.describeType("map[string][]int")).toEqual({ kind: "map", value: "[]int" });
    expect(h.describeType("map[string]interface{}")).toEqual({ kind: "any" });
    expect(h.describeType("interface{}")).toEqual({ kind: "any" });
    expect(h.describeType("any")).toEqual({ kind: "any" });
    expect(h.describeType("json.RawMessage")).toEqual({ kind: "any" });
    expect(h.describeType("store.Part")).toEqual({ kind: "object", name: "store.Part" });
  });

  it("reads wire names, required and skipped fields from struct tags", () => {
    const p = (name: string, decorators?: string[]) => ({
      name, type: "string", visibility: "public" as const, isStatic: false, isReadonly: false, decorators,
    });
    expect(h.serializedName(p("PlayerName", ['json:"player_name,omitempty"']))).toBe("player_name");
    expect(h.serializedName(p("PlayerName", ['json:",omitempty"']))).toBe("PlayerName");
    expect(h.serializedName(p("PlayerName"))).toBe("PlayerName");
    expect(h.isSerialized(p("PlayerName"))).toBe(true);
    expect(h.isSerialized(p("Secret", ['json:"-"']))).toBe(false);
    expect(h.isSerialized(p("internal"))).toBe(false);
    expect(h.isRequired(p("Name", ['json:"name"', 'validate:"required,min=2"']))).toBe(true);
    expect(h.isRequired(p("Name", ['binding:"required"']))).toBe(true);
    expect(h.isRequired(p("Name", ['json:"name"']))).toBe(false);
    expect(h.isRequired(p("Name", ['validate:"required_if=Other x"']))).toBe(false);
  });

  it("binds framework-injected handler parameters to services and says nothing about the rest", () => {
    const bind = (name: string, type: string) => h.bindParam!({ name, type, defaultValue: null }, route);
    expect(bind("c", "gin.Context")).toBe("services");
    expect(bind("w", "http.ResponseWriter")).toBe("services");
    expect(bind("r", "http.Request")).toBe("services");
    expect(bind("ctx", "context.Context")).toBe("services");
    expect(bind("ps", "httprouter.Params")).toBe("services");
    expect(bind("c", "echo.Context")).toBe("services");
    expect(bind("c", "fiber.Ctx")).toBe("services");
    expect(bind("id", "int")).toBeNull();
    expect(bind("input", "store.Part")).toBeNull();
  });
});
