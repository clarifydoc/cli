import type { Node, Tree } from "web-tree-sitter";

/**
 * The object a Node server hands its RPC handlers in, written in the call itself:
 *
 *   thrift.createServer(ClubService, { getClub(id, done) {…}, listClubs: async () => …, ping: pingHandler })
 *   server.addService(pkg.league.MatchService.service, { getMatch: (call, cb) => …, listMatches })
 *
 * Each member is the handler of the rpc it is keyed by. A member that is a function is a function of its own
 * (`<callee>.<key>`, a stable pseudo-name like a held function's), so the contract row ON it links to its body and
 * the body's calls are attributed to it; a member that names a function (`getClub: someFn`, `getClub:
 * clubs.getClub`, `list` shorthand, `x.bind(this)`) is a function of that name whose one call hands the name on
 * (`passed: "argument"`), which the symbol linker resolves without guessing — a namesake in an unrelated file is
 * never the handler. A member whose value is a call result (`getClub: makeHandler()`), a spread or a computed key
 * is no handler.
 */
export interface ContractMember {
  /** The key as written (`getClub`). */
  key: string;
  /** The pseudo-function's name. */
  name: string;
  /** The member's function node: a method, an arrow or a function expression; absent for a name handed on. */
  fn?: Node;
  /** The name handed on, as written (`clubs.getClub`). */
  handedName?: string;
  /** Where the member is written. */
  at: Node;
  line: number;
}

export interface ContractObject {
  kind: "thrift" | "grpc";
  /** The service's simple name. */
  service: string;
  /** The `{ … }` node. */
  object: Node;
  /** The line of the call. */
  line: number;
  members: ContractMember[];
}

const SERVER_CALLEE = /(?:^|\.)create(?:Multiplexed)?Server$/;
const ID_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** Whether a file's text may hold such an object. */
export function mayHoldContractHandlers(sourceText: string): boolean {
  return sourceText.includes("addService") || (/createServer|createMultiplexedServer/.test(sourceText) && /thrift/i.test(sourceText));
}

let memoTree: Tree | null = null;
let memo: ContractObject[] = [];

/** The contract handler objects of a tree, in source order. Read once per tree. */
export function contractHandlerObjects(tree: Tree, sourceText?: string): ContractObject[] {
  if (tree === memoTree) return memo;
  memoTree = tree;
  memo = [];
  const text = sourceText ?? tree.rootNode.text;
  if (!mayHoldContractHandlers(text)) return memo;
  const namesThrift = /thrift/i.test(text);
  const taken = new Set<string>();
  for (const call of tree.rootNode.descendantsOfType("call_expression")) {
    if (!call) continue;
    const callee = call.childForFieldName("function")?.text.replace(/\s+/g, "") ?? "";
    const args = call.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a && a.type !== "comment") ?? [];
    if (args.length < 2 || args[1]!.type !== "object") continue;
    let kind: ContractObject["kind"];
    let service: string | null;
    let prefix: string;
    if (namesThrift && SERVER_CALLEE.test(callee)) {
      kind = "thrift";
      prefix = "createServer";
      // `thrift.createServer(ClubService, …)`, `(gen.ClubService, …)`: a capitalized service.
      service = /^(?:[\w$]+\.)*([A-Z][\w$]*)$/.exec(args[0]!.text.replace(/\s+/g, ""))?.[1] ?? null;
    } else if (/\.addService$/.test(callee)) {
      kind = "grpc";
      prefix = "addService";
      service = /^(?:[\w$]+\.)*([A-Z][\w$]*)\.service$/.exec(args[0]!.text.replace(/\s+/g, ""))?.[1] ?? null;
    } else continue;
    if (!service) continue;
    const members: ContractMember[] = [];
    for (const m of membersOf(args[1]!)) {
      let name = `${prefix}.${m.key}`;
      // The same key under a second call in one file keeps its own function.
      if (taken.has(name)) name = `${name}@${m.line}`;
      taken.add(name);
      members.push({ ...m, name });
    }
    memo.push({ kind, service, object: args[1]!, line: call.startPosition.row + 1, members });
  }
  return memo;
}

/** The members of an object literal that are handlers, without their pseudo-names. */
function membersOf(object: Node): Array<Omit<ContractMember, "name">> {
  const out: Array<Omit<ContractMember, "name">> = [];
  for (const child of object.namedChildren) {
    if (!child) continue;
    const line = child.startPosition.row + 1;
    if (child.type === "method_definition") {
      // `get x() {}` / `set x(v) {}` are accessors, not handlers.
      if (child.children.some((c) => c && (c.type === "get" || c.type === "set"))) continue;
      const key = keyOf(child.childForFieldName("name"));
      if (key) out.push({ key, fn: child, at: child, line });
    } else if (child.type === "shorthand_property_identifier") {
      out.push({ key: child.text, handedName: child.text, at: child, line });
    } else if (child.type === "pair") {
      const key = keyOf(child.childForFieldName("key"));
      let value = child.childForFieldName("value");
      if (!key || !value) continue;
      if (value.type === "arrow_function" || value.type === "function_expression") {
        out.push({ key, fn: value, at: value, line });
        continue;
      }
      // `fn.bind(this)` is `fn`.
      if (value.type === "call_expression") {
        const callee = value.childForFieldName("function");
        if (callee?.type !== "member_expression" || callee.childForFieldName("property")?.text !== "bind") continue;
        value = callee.childForFieldName("object");
        if (!value) continue;
      }
      const written = value.text.replace(/\s+/g, "");
      if ((value.type === "identifier" || value.type === "member_expression") && ID_PATH.test(written) && !/^this\b/.test(written)) {
        out.push({ key, handedName: written, at: value, line });
      }
    }
  }
  return out;
}

function keyOf(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === "property_identifier" || node.type === "identifier") return node.text;
  if (node.type === "string") {
    const t = node.text.slice(1, -1);
    return /^[A-Za-z_$][\w$]*$/.test(t) ? t : null;
  }
  return null;
}

/** The pseudo-name of a function node that is an RPC handler written in place, or null. */
export function contractFunction(node: Node): string | null {
  if (node.type !== "arrow_function" && node.type !== "function_expression" && node.type !== "method_definition") return null;
  for (const o of contractHandlerObjects(node.tree)) {
    for (const m of o.members) if (m.fn?.id === node.id) return m.name;
  }
  return null;
}

/** The members of the thrift object literal starting at a text offset, for the route fact, or null when none is read there. */
export function contractMembersAt(tree: Tree, sourceText: string, offset: number): Array<{ name: string; line: number; handler: string }> | null {
  const obj = contractHandlerObjects(tree, sourceText).find((o) => o.kind === "thrift" && o.object.startIndex === offset);
  return obj ? obj.members.map((m) => ({ name: m.key, line: m.line, handler: m.name })) : null;
}
