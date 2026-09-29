import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";

/**
 * URL-builder template extraction. A frontend helper that returns an
 * app-relative request URL (`requestUri(endpoint, version)`) is captured as a
 * parameterized template — params as `{name}`, env base dropped, other runtime
 * refs as `{}` — so a project-level pass can substitute call-site args.
 */
async function templateOf(src: string, fnName: string): Promise<string | undefined> {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  const fns = new JavaScriptExtractor().extractFunctions(tree, src);
  return fns.find((f) => f.name === fnName)?.urlTemplate;
}

describe("URL-builder template extraction", () => {
  it("builds a template from a concat chain, dropping env base and runtime vars", async () => {
    const SRC = `export function requestUri(endpoint: string, version = 'v2'): string {
      const id = useStore().selectedInstitutionId;
      return import.meta.env.VITE_API + '/api/' + version + '/institution/' + id + '/' + endpoint;
    }`;
    expect(await templateOf(SRC, "requestUri")).toBe("/api/{version}/institution/{}/{endpoint}");
  });

  it("follows a one-hop local const and a template literal return", async () => {
    const SRC = `export function adminUri(aSubPath: string, version = 'v1'): string {
      const str = import.meta.env.VITE_ADMIN + \`/api/\${version}/\${aSubPath}\`;
      return str;
    }`;
    expect(await templateOf(SRC, "adminUri")).toBe("/api/{version}/{aSubPath}");
  });

  it("handles an expression-bodied arrow", async () => {
    const SRC = `export const uri = (sub: string) => '/api/' + sub;`;
    expect(await templateOf(SRC, "uri")).toBe("/api/{sub}");
  });

  it("does not set a template for a non-URL function (no slash)", async () => {
    const SRC = `export function label(name: string) { return 'prefix-' + name; }`;
    expect(await templateOf(SRC, "label")).toBeUndefined();
  });
});

async function classesOf(src: string) {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  return new JavaScriptExtractor().extractClasses(tree, src);
}

/**
 * Property facts the request-schema pass consumes: field decorators (children
 * of the field, unlike a method's), the `?` optional marker, constructor
 * parameter properties, and interface optionals.
 */
describe("class properties — decorators, optional marker, parameter properties", () => {
  it("keeps class-validator/transformer decorators with arguments and marks required fields", async () => {
    const [dto] = await classesOf(`export class CreateUserDto extends BaseDto {
      @IsString()
      @Expose({ name: 'user_name' })
      userName: string;

      @IsOptional() @IsInt()
      age?: number;

      tags: string[] = [];

      private secret: string;
      static VERSION = 1;
    }`);
    expect(dto!.extends).toBe("BaseDto");
    expect(dto!.properties).toEqual([
      { name: "userName", type: "string", visibility: null, isStatic: false, isReadonly: false, decorators: ["IsString()", "Expose({ name: 'user_name' })"], isRequired: true },
      { name: "age", type: "number", visibility: null, isStatic: false, isReadonly: false, decorators: ["IsOptional()", "IsInt()"], isRequired: false },
      { name: "tags", type: "string[]", visibility: null, isStatic: false, isReadonly: false, decorators: [], isRequired: false },
      { name: "secret", type: "string", visibility: "private", isStatic: false, isReadonly: false, decorators: [], isRequired: true },
      { name: "VERSION", type: null, visibility: null, isStatic: true, isReadonly: false, decorators: [], isRequired: false },
    ]);
  });

  it("turns constructor parameter properties into properties", async () => {
    const [cls] = await classesOf(`class Point {
      constructor(public readonly x: number, private y?: number, z: string = '', readonly label: string) {}
    }`);
    expect(cls!.properties).toEqual([
      { name: "x", type: "number", visibility: "public", isStatic: false, isReadonly: true, decorators: [], isRequired: true },
      { name: "y", type: "number", visibility: "private", isStatic: false, isReadonly: false, decorators: [], isRequired: false },
      { name: "label", type: "string", visibility: "public", isStatic: false, isReadonly: true, decorators: [], isRequired: true },
    ]);
  });

  it("marks optional interface members", async () => {
    const [iface] = await classesOf(`interface Q { q: string; page?: number }`);
    expect(iface!.properties.map((p) => [p.name, p.isRequired])).toEqual([["q", true], ["page", false]]);
  });
});

/**
 * A handler declared away from its route (`router.get('/', getUsers)`) has
 * no bindings in its signature; what its body reads off `req` is recorded so
 * the project-level join can hand it to the route.
 */
describe("requestAccess on handler-shaped functions", () => {
  it("records request reads for functions and methods whose first param is req/request/ctx", async () => {
    const src = `export async function getUser(req: Request, res: Response) {
      const user = await find(req.params.id, req.query.expand);
      res.json(user);
    }
    export const login = (request, reply) => { const { email, password } = request.body; };
    export class Ctl { async remove(req, res) { await del(req.params['id']); } }
    export function helper(a, b) { return a.params.id; }
    export function none(req, res) { res.end(); }`;
    const tree = await parseSource(src, "typescript" as any, "x.ts");
    const ex = new JavaScriptExtractor();
    const fns = ex.extractFunctions(tree, src);
    const by = (n: string) => fns.find((f) => f.name === n)!;
    expect(by("getUser").requestAccess).toEqual([
      { name: "id", type: null, binding: "route" },
      { name: "expand", type: null, binding: "query" },
    ]);
    expect(by("login").requestAccess).toEqual([
      { name: "email", type: null, binding: "body" },
      { name: "password", type: null, binding: "body" },
    ]);
    expect(by("helper").requestAccess).toBeUndefined();
    expect(by("none").requestAccess).toBeUndefined();
    const [ctl] = ex.extractClasses(tree, src);
    expect(ctl!.methods[0]!.requestAccess).toEqual([{ name: "id", type: null, binding: "route" }]);
  });
});
