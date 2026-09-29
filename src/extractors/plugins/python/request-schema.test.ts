import { describe, it, expect } from "vitest";
import { pythonRequestSchema as h, bindParam } from "./request-schema.js";
import type { PropertyInfo } from "../../../types/analysis.js";

const prop = (over: Partial<PropertyInfo>): PropertyInfo => ({
  name: "display_name", type: "str", visibility: "public", isStatic: false, isReadonly: false, ...over,
});
const route = { path: "/x", httpMethod: "GET", kind: "api" as const, handler: null, calls: [], middleware: [], line: 1 };

describe("Python request-schema hooks", () => {
  it("unwraps every nullable spelling", () => {
    expect(h.unwrapNullable("Optional[str]")).toEqual({ type: "str", nullable: true });
    expect(h.unwrapNullable("typing.Optional[List[int]]")).toEqual({ type: "List[int]", nullable: true });
    expect(h.unwrapNullable("str | None")).toEqual({ type: "str", nullable: true });
    expect(h.unwrapNullable("None | dict[str, int]")).toEqual({ type: "dict[str, int]", nullable: true });
    expect(h.unwrapNullable("Union[Address, None]")).toEqual({ type: "Address", nullable: true });
    expect(h.unwrapNullable("Annotated[str | None, Query()]")).toEqual({ type: "str", nullable: true });
    expect(h.unwrapNullable("int | str")).toEqual({ type: "int | str", nullable: false });
    expect(h.unwrapNullable("UserCreate")).toEqual({ type: "UserCreate", nullable: false });
  });

  it("classifies scalars, collections, maps, literals and class names", () => {
    expect(h.describeType("str")).toEqual({ kind: "scalar", schema: { type: "string" } });
    expect(h.describeType("int")).toEqual({ kind: "scalar", schema: { type: "integer" } });
    expect(h.describeType("float")).toEqual({ kind: "scalar", schema: { type: "number" } });
    expect(h.describeType("bool")).toEqual({ kind: "scalar", schema: { type: "boolean" } });
    expect(h.describeType("bytes")).toEqual({ kind: "scalar", schema: { type: "string", format: "byte" } });
    expect(h.describeType("datetime.datetime")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(h.describeType("date")).toEqual({ kind: "scalar", schema: { type: "string", format: "date" } });
    expect(h.describeType("UUID")).toEqual({ kind: "scalar", schema: { type: "string", format: "uuid" } });
    expect(h.describeType("Decimal")).toEqual({ kind: "scalar", schema: { type: "number" } });
    expect(h.describeType("Any")).toEqual({ kind: "any" });
    expect(h.describeType("dict")).toEqual({ kind: "any" });
    expect(h.describeType("Dict")).toEqual({ kind: "any" });
    expect(h.describeType("list[str]")).toEqual({ kind: "array", element: "str" });
    expect(h.describeType("List[Address]")).toEqual({ kind: "array", element: "Address" });
    expect(h.describeType("Sequence[int]")).toEqual({ kind: "array", element: "int" });
    expect(h.describeType("set[str]")).toEqual({ kind: "array", element: "str" });
    expect(h.describeType("tuple[int, ...]")).toEqual({ kind: "array", element: "int" });
    expect(h.describeType("dict[str, Address]")).toEqual({ kind: "map", value: "Address" });
    expect(h.describeType("Mapping[str, list[int]]")).toEqual({ kind: "map", value: "list[int]" });
    expect(h.describeType("Literal['a', 'b']")).toEqual({ kind: "scalar", schema: { type: "string", enum: ["a", "b"] } });
    expect(h.describeType("UserCreate")).toEqual({ kind: "object", name: "UserCreate" });
    expect(h.describeType("models.Address")).toEqual({ kind: "object", name: "models.Address" });
  });

  it("reads the wire name from Field(alias=…) and required/serialized from the property", () => {
    expect(h.serializedName(prop({ decorators: ['Field(..., alias="user_name")'] }))).toBe("user_name");
    expect(h.serializedName(prop({ decorators: ['Field(alias="userName", description="x")'] }))).toBe("userName");
    expect(h.serializedName(prop({ decorators: ['Field(None, description="no alias")'] }))).toBe("display_name");
    expect(h.serializedName(prop({}))).toBe("display_name");
    expect(h.isRequired(prop({ isRequired: true }))).toBe(true);
    expect(h.isRequired(prop({ isRequired: false }))).toBe(false);
    expect(h.isRequired(prop({}))).toBe(false);
    expect(h.isSerialized(prop({}))).toBe(true);
    expect(h.isSerialized(prop({ name: "_secret" }))).toBe(false);
    expect(h.isSerialized(prop({ name: "model_config" }))).toBe(false);
    expect(h.isSerialized(prop({ name: "kind", type: "ClassVar[str]" }))).toBe(false);
    expect(h.isSerialized(prop({ decorators: ["Field(exclude=True)"] }))).toBe(false);
  });

  it("bindParam names the framework-injected parameters and nothing else", () => {
    expect(bindParam({ name: "request", type: null, defaultValue: null }, route)).toBe("services");
    expect(bindParam({ name: "req", type: "HttpRequest", defaultValue: null }, route)).toBe("services");
    expect(bindParam({ name: "r", type: "Request", defaultValue: null }, route)).toBe("services");
    expect(bindParam({ name: "db", type: "Session", defaultValue: "Depends(get_db)" }, route)).toBe("services");
    expect(bindParam({ name: "user_id", type: "int", defaultValue: null }, route)).toBeNull();
    expect(bindParam({ name: "data", type: "UserCreate", defaultValue: null }, route)).toBeNull();
  });
});
