import { describe, it, expect } from "vitest";
import { javascriptRequestSchema as h } from "./request-schema.js";
import type { PropertyInfo } from "../../../types/analysis.js";

const prop = (decorators: string[], extra: Partial<PropertyInfo> = {}): PropertyInfo => ({
  name: "userName", type: "string", visibility: null, isStatic: false, isReadonly: false, decorators, ...extra,
});

describe("TypeScript request-schema hooks", () => {
  it("strips null/undefined union members as nullable", () => {
    expect(h.unwrapNullable("string | null")).toEqual({ type: "string", nullable: true });
    expect(h.unwrapNullable("Foo | undefined | null")).toEqual({ type: "Foo", nullable: true });
    expect(h.unwrapNullable("Record<string, number | null>")).toEqual({ type: "Record<string, number | null>", nullable: false });
    expect(h.unwrapNullable("null")).toEqual({ type: "null", nullable: true });
    expect(h.describeType("null")).toEqual({ kind: "any" });
  });

  it("classifies scalars, arrays, maps, wrappers, literal unions and objects", () => {
    expect(h.describeType("string")).toEqual({ kind: "scalar", schema: { type: "string" } });
    expect(h.describeType("number")).toEqual({ kind: "scalar", schema: { type: "number" } });
    expect(h.describeType("boolean")).toEqual({ kind: "scalar", schema: { type: "boolean" } });
    expect(h.describeType("bigint")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int64" } });
    expect(h.describeType("Date")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(h.describeType("any")).toEqual({ kind: "any" });
    expect(h.describeType("unknown")).toEqual({ kind: "any" });
    expect(h.describeType("object")).toEqual({ kind: "any" });
    expect(h.describeType("{ a: string }")).toEqual({ kind: "any" });
    expect(h.describeType("Address[]")).toEqual({ kind: "array", element: "Address" });
    expect(h.describeType("(A | B)[]")).toEqual({ kind: "array", element: "(A | B)" });
    expect(h.describeType("Array<Address>")).toEqual({ kind: "array", element: "Address" });
    expect(h.describeType("ReadonlyArray<string>")).toEqual({ kind: "array", element: "string" });
    expect(h.describeType("Set<number>")).toEqual({ kind: "array", element: "number" });
    expect(h.describeType("Record<string, Item>")).toEqual({ kind: "map", value: "Item" });
    expect(h.describeType("Map<string, Array<Item>>")).toEqual({ kind: "map", value: "Array<Item>" });
    expect(h.describeType("Promise<CreateUserDto>")).toEqual({ kind: "object", name: "CreateUserDto" });
    expect(h.describeType("Partial<Address>")).toEqual({ kind: "object", name: "Address" });
    expect(h.describeType("'a' | 'b'")).toEqual({ kind: "scalar", schema: { type: "string", enum: ["a", "b"] } });
    expect(h.describeType("A | B")).toEqual({ kind: "any" });
    expect(h.describeType("CreateUserDto")).toEqual({ kind: "object", name: "CreateUserDto" });
    expect(h.describeType("models.User")).toEqual({ kind: "object", name: "models.User" });
  });

  it("reads wire names from Expose / JsonProperty / ApiProperty, else the declared name", () => {
    expect(h.serializedName(prop(["Expose({ name: 'user_name' })"]))).toBe("user_name");
    expect(h.serializedName(prop(['JsonProperty("user_name")']))).toBe("user_name");
    expect(h.serializedName(prop(["ApiProperty({ name: 'user_name', required: true })"]))).toBe("user_name");
    expect(h.serializedName(prop(["Expose()"]))).toBe("userName");
    expect(h.serializedName(prop([]))).toBe("userName");
  });

  it("serializes public instance fields that are not excluded", () => {
    expect(h.isSerialized(prop([]))).toBe(true);
    expect(h.isSerialized(prop([], { visibility: "public" }))).toBe(true);
    expect(h.isSerialized(prop([], { visibility: "private" }))).toBe(false);
    expect(h.isSerialized(prop([], { visibility: "protected" }))).toBe(false);
    expect(h.isSerialized(prop([], { isStatic: true }))).toBe(false);
    expect(h.isSerialized(prop(["Exclude()"]))).toBe(false);
  });

  it("derives required from the optional marker and class-validator decorators", () => {
    expect(h.isRequired(prop([], { isRequired: true }))).toBe(true);
    expect(h.isRequired(prop([], { isRequired: false }))).toBe(false);
    expect(h.isRequired(prop([]))).toBe(false);
    expect(h.isRequired(prop(["IsString()", "IsOptional()"], { isRequired: true }))).toBe(false);
    expect(h.isRequired(prop(["IsNotEmpty()"], { isRequired: false }))).toBe(true);
    expect(h.isRequired(prop(["IsDefined()"]))).toBe(true);
  });

  it("binds framework objects of an Express handler to services and says nothing about the rest", () => {
    const route = { path: "/users/:id", httpMethod: "GET", kind: "api" as const, handler: "getUser", calls: [], middleware: [], line: 1 };
    const p = (name: string, type: string | null = null) => ({ name, type, defaultValue: null });
    expect(h.bindParam!(p("req"), route)).toBe("services");
    expect(h.bindParam!(p("res", "Response"), route)).toBe("services");
    expect(h.bindParam!(p("next", "NextFunction"), route)).toBe("services");
    expect(h.bindParam!(p("ctx"), route)).toBe("services");
    expect(h.bindParam!(p("r", "FastifyRequest<{ Body: X }>"), route)).toBe("services");
    expect(h.bindParam!(p("id", "string"), route)).toBeNull();
  });
});
