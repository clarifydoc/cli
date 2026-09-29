import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars + plugin metas
import { parseSource } from "../../../parsers/parser-manager.js";
import { PhpExtractor } from "./functions-classes.js";
import { phpRequestSchema } from "./request-schema.js";
import { attachRequestSchemas } from "../../../core/request-schemas.js";
import type { FileAnalysis, JsonSchemaNode, PropertyInfo, RouteInfo } from "../../../types/analysis.js";

/**
 * PHP types and properties on the wire — what the language-agnostic
 * request-schema pass asks the PHP plugin, and the flattened schema that
 * comes out for a Symfony `#[MapRequestPayload]` DTO.
 */
const prop = (over: Partial<PropertyInfo>): PropertyInfo => ({
  name: "x", type: "string", visibility: "public", isStatic: false, isReadonly: false, ...over,
});

describe("phpRequestSchema hooks", () => {
  it("unwraps `?T` and `T|null`", () => {
    expect(phpRequestSchema.unwrapNullable("?Address")).toEqual({ type: "Address", nullable: true });
    expect(phpRequestSchema.unwrapNullable("int|null")).toEqual({ type: "int", nullable: true });
    expect(phpRequestSchema.unwrapNullable("null|Foo")).toEqual({ type: "Foo", nullable: true });
    expect(phpRequestSchema.unwrapNullable("string")).toEqual({ type: "string", nullable: false });
  });

  it("classifies scalars, arrays, any and objects", () => {
    expect(phpRequestSchema.describeType("string")).toEqual({ kind: "scalar", schema: { type: "string" } });
    expect(phpRequestSchema.describeType("int")).toEqual({ kind: "scalar", schema: { type: "integer" } });
    expect(phpRequestSchema.describeType("float")).toEqual({ kind: "scalar", schema: { type: "number" } });
    expect(phpRequestSchema.describeType("bool")).toEqual({ kind: "scalar", schema: { type: "boolean" } });
    expect(phpRequestSchema.describeType("DateTimeImmutable")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(phpRequestSchema.describeType("Carbon")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(phpRequestSchema.describeType("array")).toEqual({ kind: "array", element: "mixed" });
    expect(phpRequestSchema.describeType("iterable")).toEqual({ kind: "array", element: "mixed" });
    expect(phpRequestSchema.describeType("Collection")).toEqual({ kind: "array", element: "mixed" });
    expect(phpRequestSchema.describeType("Item[]")).toEqual({ kind: "array", element: "Item" });
    expect(phpRequestSchema.describeType("array<int, Item>")).toEqual({ kind: "array", element: "Item" });
    expect(phpRequestSchema.describeType("mixed")).toEqual({ kind: "any" });
    expect(phpRequestSchema.describeType("stdClass")).toEqual({ kind: "any" });
    expect(phpRequestSchema.describeType("object")).toEqual({ kind: "any" });
    expect(phpRequestSchema.describeType("Address")).toEqual({ kind: "object", name: "Address" });
  });

  it("names the wire field from SerializedName/JsonProperty, else the declared name untouched", () => {
    expect(phpRequestSchema.serializedName(prop({ name: "fullName", decorators: ["SerializedName('full_name')"] }))).toBe("full_name");
    expect(phpRequestSchema.serializedName(prop({ name: "fullName", decorators: ["JsonProperty(\"full-name\")"] }))).toBe("full-name");
    expect(phpRequestSchema.serializedName(prop({ name: "fullName" }))).toBe("fullName");
    expect(phpRequestSchema.serializedName(prop({ name: "full_name" }))).toBe("full_name");
  });

  it("serializes public instance properties only, and skips #[Ignore]", () => {
    expect(phpRequestSchema.isSerialized(prop({}))).toBe(true);
    expect(phpRequestSchema.isSerialized(prop({ visibility: "private" }))).toBe(false);
    expect(phpRequestSchema.isSerialized(prop({ isStatic: true }))).toBe(false);
    expect(phpRequestSchema.isSerialized(prop({ decorators: ["Ignore"] }))).toBe(false);
  });

  it("requires a property on Assert\\NotBlank / NotNull / Required or the extractor's isRequired", () => {
    expect(phpRequestSchema.isRequired(prop({ decorators: ["Assert\\NotBlank"] }))).toBe(true);
    expect(phpRequestSchema.isRequired(prop({ decorators: ["NotNull(message: 'x')"] }))).toBe(true);
    expect(phpRequestSchema.isRequired(prop({ isRequired: true }))).toBe(true);
    expect(phpRequestSchema.isRequired(prop({ type: "?string" }))).toBe(false);
  });

  it("binds a handler parameter: path token → route, injected types → services, FormRequest → body, else null", () => {
    const route: RouteInfo = { path: "/orders/{order}", httpMethod: "PUT", kind: "api", handler: "OrderController#update", calls: [], middleware: [], line: 1 };
    const bind = (name: string, type: string | null) => phpRequestSchema.bindParam!({ name, type, defaultValue: null }, route);
    expect(bind("order", "Order")).toBe("route"); // implicit route-model binding
    expect(bind("request", "Request")).toBe("services");
    expect(bind("response", "ResponseInterface")).toBe("services");
    expect(bind("request", "UpdateOrderRequest")).toBe("body");
    expect(bind("service", "OrderService")).toBe("services");
    expect(bind("id", "int")).toBeNull();
    expect(bind("user", "User")).toBeNull();
  });
});

describe("request schema for a PHP DTO (through core's attachRequestSchemas)", () => {
  it("flattens a Symfony DTO with inheritance, promoted, nullable, renamed and array fields", async () => {
    const SRC = `<?php
namespace App\\Dto;

abstract class BaseDto
{
    public string $source = 'api';
}

class Address
{
    public string $street;
    public ?string $zip = null;
}

class CreateUserDto extends BaseDto
{
    public function __construct(
        #[Assert\\NotBlank] public readonly string $email,
        #[SerializedName('full_name')] public string $fullName,
        public ?Address $address = null,
        /** @var string[] */
        public array $roles = [],
        public ?int $age = null,
        public \\DateTimeImmutable|null $bornAt = null,
        private string $internal = '',
    ) {}
}`;
    const tree = await parseSource(SRC, "php" as any, "src/Dto/CreateUserDto.php");
    const classes = new PhpExtractor().extractClasses(tree, SRC);
    const analysis = { filePath: "src/Dto/CreateUserDto.php", language: "php", classes, functions: [], projectId: "root" } as unknown as FileAnalysis;
    const route = {
      path: "/api/users", httpMethod: "POST", kind: "api", handler: "create", calls: [], middleware: [], line: 1,
      filePath: "src/Controller/UserController.php", projectId: "root",
      params: [{ name: "dto", type: "CreateUserDto", binding: "body" }],
    } as RouteInfo & { filePath: string; projectId: string; requestSchema?: JsonSchemaNode };
    const controller = { filePath: route.filePath, language: "php", classes: [], functions: [], projectId: "root" } as unknown as FileAnalysis;

    expect(attachRequestSchemas([route], [analysis, controller])).toBe(1);
    expect(route.requestSchema).toEqual({
      type: "object",
      properties: {
        email: { type: "string" },
        full_name: { type: "string" },
        address: {
          type: "object",
          properties: { street: { type: "string" }, zip: { type: "string", nullable: true } },
          required: ["street"],
          nullable: true,
        },
        roles: { type: "array", items: {} },
        age: { type: "integer", nullable: true },
        bornAt: { type: "string", format: "date-time", nullable: true },
        source: { type: "string" },
      },
      required: ["email", "full_name"],
    });
  });
});
