import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import type { ClassInfo } from "../../../types/analysis.js";

/**
 * Class heritage for TS/JS was read through `childForFieldName("heritage")`,
 * a field the grammar does not have (it exposes a `class_heritage` CHILD), so
 * `extends` and `implements` were null for every class in the corpus's most
 * common language and the linker's inheritance and interface strategies could
 * never fire.
 */
async function classesOf(src: string, file = "x.ts"): Promise<ClassInfo[]> {
  const tree = await parseSource(src, "typescript" as any, file);
  return new JavaScriptExtractor().extractClasses(tree, src);
}

const byName = (cs: ClassInfo[], n: string) => cs.find((c) => c.name === n)!;

describe("TypeScript class heritage", () => {
  it("records extends and implements", async () => {
    const cs = await classesOf(`
      export class UserService extends BaseService implements IUserService, Disposable {
        load(id: string) { return id; }
      }
    `);
    const c = byName(cs, "UserService");
    expect(c.extends).toBe("BaseService");
    expect(c.implements).toEqual(["IUserService", "Disposable"]);
    expect(c.isExported).toBe(true);
  });

  it("strips type arguments so the base matches its declaration", async () => {
    const cs = await classesOf(`class Repo extends BaseRepo<User> implements Findable<User> {}`);
    expect(byName(cs, "Repo").extends).toBe("BaseRepo");
    expect(byName(cs, "Repo").implements).toEqual(["Findable"]);
  });

  it("keeps a dotted base as written", async () => {
    const cs = await classesOf(`class Widget extends React.Component {}`, "w.tsx");
    expect(byName(cs, "Widget").extends).toBe("React.Component");
  });

  it("collects abstract classes with their heritage", async () => {
    const cs = await classesOf(`export abstract class Handler extends Base implements IHandler {}`);
    expect(byName(cs, "Handler").extends).toBe("Base");
    expect(byName(cs, "Handler").implements).toEqual(["IHandler"]);
  });

  it("leaves a class with no heritage null", async () => {
    const cs = await classesOf(`class Plain { go() {} }`);
    expect(byName(cs, "Plain").extends).toBeNull();
    expect(byName(cs, "Plain").implements).toEqual([]);
  });
});

describe("plain JavaScript class heritage", () => {
  it("records the extends expression", async () => {
    const tree = await parseSource(`class Store extends EventEmitter { on() {} }`, "javascript" as any, "s.js");
    const cs = new JavaScriptExtractor().extractClasses(tree, "");
    expect(byName(cs, "Store").extends).toBe("EventEmitter");
  });
});

describe("TypeScript interfaces", () => {
  it("become ClassInfo with kind interface, methods and properties", async () => {
    const cs = await classesOf(`
      export interface IUserService {
        readonly name: string;
        load(id: string): Promise<User>;
        save(u: User): void;
      }
    `);
    const i = byName(cs, "IUserService");
    expect(i.kind).toBe("interface");
    expect(i.isExported).toBe(true);
    expect(i.methods.map((m) => m.name).sort()).toEqual(["load", "save"]);
    expect(i.properties.map((p) => p.name)).toEqual(["name"]);
    expect(i.properties[0]!.isReadonly).toBe(true);
    expect(i.methods[0]!.calls).toEqual([]);
  });

  it("records every base of a multi-extends interface", async () => {
    const cs = await classesOf(`interface C extends A, B {}`);
    const i = byName(cs, "C");
    // First base in `extends`, the rest in `implements` — the impl map reads both.
    expect(i.extends).toBe("A");
    expect(i.implements).toEqual(["B"]);
  });

  it("lets a class be matched to the interface it implements", async () => {
    const cs = await classesOf(`
      interface IRepo { find(id: string): void; }
      export class SqlRepo implements IRepo { find(id: string) {} }
    `);
    expect(byName(cs, "IRepo").kind).toBe("interface");
    expect(byName(cs, "SqlRepo").implements).toEqual(["IRepo"]);
  });
});
