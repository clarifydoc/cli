import type { Node, Tree } from "web-tree-sitter";
import type { Language, TypeReference, TypeUsageKind } from "../../types/analysis.js";
import { emitTypeRefs, type TypeRefContext } from "./type-parser.js";

/**
 * AST-level type-reference extractor. Complements
 * `core/type-reference-extractor.ts` which works from already-extracted
 * FileAnalysis (classes / functions). This pass walks the tree-sitter tree
 * itself to find type-position usages that don't show up in classes/functions:
 *
 *   - **Arrow functions** — `(req: AuthRequest) => ...`. Currently the
 *     per-file FunctionInfo only captures named function declarations, so
 *     arrow-style callbacks (express handlers, vue setup helpers, react
 *     hooks) lose their parameter types.
 *   - **Variable type annotations** — `const u: User = ...`. Never captured
 *     by the FileAnalysis-level extractor.
 *   - **Type assertions** — `x as User`, `<User>x`. Same.
 *   - **`new` expressions** — `new User(...)`. CallInfo records the call but
 *     not as a type-reference; we add a parallel record on the type axis.
 *
 * Each walker tracks the enclosing symbol (`<setup>`, `route:GET /x`,
 * `handler@line:42`) so the resulting TypeReference points at meaningful
 * source context, not just a line number.
 */

const TS_LIKE = new Set<Language>(["typescript", "javascript"]);

export function extractTypeReferencesFromAst(
  tree: Tree,
  language: Language,
  filePath: string,
): TypeReference[] {
  const refs: TypeReference[] = [];

  if (!tree || !tree.rootNode) return refs;

  // Each walker carries an `enclosingClass` (may be undefined). It's set when
  // we descend into a class/interface/record body and reset when we leave —
  // letting the resulting TypeReference carry the class that contains it.
  if (TS_LIKE.has(language)) {
    walkTsLike(tree.rootNode, language, filePath, "(top-level)", undefined, refs);
  } else if (language === "java" || language === "kotlin") {
    walkJavaLike(tree.rootNode, language, filePath, "(top-level)", undefined, refs);
  } else if (language === "csharp") {
    walkCsharp(tree.rootNode, filePath, "(top-level)", undefined, refs);
  } else if (language === "python") {
    walkPython(tree.rootNode, filePath, "(top-level)", undefined, refs);
  }

  return refs;
}

// ─── TypeScript / JavaScript ─────────────────────────────────────────────

function walkTsLike(
  node: Node,
  language: Language,
  filePath: string,
  enclosing: string,
  enclosingClass: string | undefined,
  out: TypeReference[],
): void {
  const t = node.type;

  let here = enclosing;
  let hereClass = enclosingClass;
  if (t === "function_declaration" || t === "method_definition") {
    const name = node.childForFieldName("name")?.text;
    if (name) here = name;
  } else if (t === "class_declaration" || t === "interface_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (name) { here = name; hereClass = name; }
  }

  // Arrow function param/return types.
  if (t === "arrow_function") {
    extractTsFnTypes(node, language, filePath, enclosing || "(arrow)", enclosingClass, out);
  }

  // Variable type annotations: `const u: User = ...`, `let x: List<User>`.
  if (t === "variable_declarator") {
    const typeNode = node.childForFieldName("type")
      ?? findChildByType(node, "type_annotation");
    if (typeNode) {
      const typeStr = stripLeadingColon(typeNode.text);
      const nameNode = node.childForFieldName("name");
      const sym = nameNode?.text ?? "(variable)";
      emitParsed(typeStr, language, "variable", filePath, lineOf(node), enclosing === "(top-level)" ? sym : `${enclosing}.${sym}`, enclosingClass, out);
    }
  }

  // Type assertion: `expr as Type` (TS) / `<Type>expr` (TS).
  if (t === "as_expression" || t === "type_assertion" || t === "satisfies_expression") {
    const typeNode = node.childForFieldName("type")
      ?? findChildByType(node, "type_identifier")
      ?? findChildByType(node, "generic_type");
    if (typeNode) {
      emitParsed(typeNode.text, language, "cast", filePath, lineOf(node), enclosing, enclosingClass, out);
    }
  }

  // `new SomeClass(...)` — type-axis record (call-graph already tracks it).
  if (t === "new_expression") {
    const ctor = node.childForFieldName("constructor")
      ?? node.childForFieldName("name");
    if (ctor) {
      emitParsed(ctor.text, language, "instantiation", filePath, lineOf(node), enclosing, enclosingClass, out, "INFERRED");
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkTsLike(child, language, filePath, here, hereClass, out);
  }
}

function extractTsFnTypes(
  fnNode: Node,
  language: Language,
  filePath: string,
  enclosing: string,
  enclosingClass: string | undefined,
  out: TypeReference[],
): void {
  const params = fnNode.childForFieldName("parameters")
    ?? findChildByType(fnNode, "formal_parameters");
  if (params) {
    for (let i = 0; i < params.childCount; i++) {
      const p = params.child(i);
      if (!p) continue;
      if (p.type !== "required_parameter" && p.type !== "optional_parameter"
          && p.type !== "rest_pattern" && p.type !== "parameter") continue;
      const typeNode = p.childForFieldName("type")
        ?? findChildByType(p, "type_annotation");
      if (!typeNode) continue;
      emitParsed(stripLeadingColon(typeNode.text), language, "parameter", filePath, lineOf(p), enclosing, enclosingClass, out);
    }
  }
  const retTypeNode = fnNode.childForFieldName("return_type");
  if (retTypeNode) {
    emitParsed(stripLeadingColon(retTypeNode.text), language, "return", filePath, lineOf(fnNode), enclosing, enclosingClass, out);
  }
}

// ─── Java / Kotlin ───────────────────────────────────────────────────────

function walkJavaLike(
  node: Node,
  language: Language,
  filePath: string,
  enclosing: string,
  enclosingClass: string | undefined,
  out: TypeReference[],
): void {
  const t = node.type;

  let here = enclosing;
  let hereClass = enclosingClass;
  if (t === "method_declaration" || t === "constructor_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (name) here = name;
  } else if (t === "class_declaration" || t === "interface_declaration"
             || t === "enum_declaration" || t === "record_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (name) { here = name; hereClass = name; }
  }

  if (t === "local_variable_declaration") {
    const typeNode = node.childForFieldName("type") ?? node.child(0);
    if (typeNode) {
      emitParsed(typeNode.text, language, "variable", filePath, lineOf(node), enclosing, enclosingClass, out);
    }
  }

  if (t === "cast_expression") {
    const typeNode = node.childForFieldName("type") ?? node.child(1);
    if (typeNode) {
      emitParsed(typeNode.text, language, "cast", filePath, lineOf(node), enclosing, enclosingClass, out);
    }
  }

  if (t === "object_creation_expression") {
    const typeNode = node.childForFieldName("type") ?? node.childForFieldName("constructor");
    if (typeNode) {
      emitParsed(typeNode.text, language, "instantiation", filePath, lineOf(node), enclosing, enclosingClass, out, "INFERRED");
    }
  }

  if (t === "lambda_expression") {
    const params = node.childForFieldName("parameters");
    if (params) {
      for (let i = 0; i < params.childCount; i++) {
        const p = params.child(i);
        if (!p) continue;
        if (p.type === "formal_parameter" || p.type === "inferred_parameters") {
          const typeNode = p.childForFieldName("type");
          if (typeNode) {
            emitParsed(typeNode.text, language, "parameter", filePath, lineOf(p), enclosing, enclosingClass, out);
          }
        }
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkJavaLike(child, language, filePath, here, hereClass, out);
  }
}

// ─── C# ──────────────────────────────────────────────────────────────────

function walkCsharp(
  node: Node,
  filePath: string,
  enclosing: string,
  enclosingClass: string | undefined,
  out: TypeReference[],
): void {
  const t = node.type;

  let here = enclosing;
  let hereClass = enclosingClass;
  if (t === "method_declaration" || t === "constructor_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (name) here = name;
  } else if (t === "class_declaration" || t === "interface_declaration"
             || t === "struct_declaration" || t === "record_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (name) { here = name; hereClass = name; }
  }

  if (t === "local_declaration_statement") {
    const vd = findChildByType(node, "variable_declaration");
    if (vd) {
      const typeNode = vd.childForFieldName("type") ?? vd.child(0);
      if (typeNode) {
        emitParsed(typeNode.text, "csharp", "variable", filePath, lineOf(node), enclosing, enclosingClass, out);
      }
    }
  }

  if (t === "cast_expression") {
    const typeNode = node.childForFieldName("type") ?? node.child(1);
    if (typeNode) {
      emitParsed(typeNode.text, "csharp", "cast", filePath, lineOf(node), enclosing, enclosingClass, out);
    }
  }

  if (t === "object_creation_expression") {
    const typeNode = node.childForFieldName("type");
    if (typeNode) {
      emitParsed(typeNode.text, "csharp", "instantiation", filePath, lineOf(node), enclosing, enclosingClass, out, "INFERRED");
    }
  }

  if (t === "lambda_expression") {
    const params = node.childForFieldName("parameters");
    if (params) {
      for (let i = 0; i < params.childCount; i++) {
        const p = params.child(i);
        if (!p) continue;
        const typeNode = p.childForFieldName?.("type");
        if (typeNode) {
          emitParsed(typeNode.text, "csharp", "parameter", filePath, lineOf(p), enclosing, enclosingClass, out);
        }
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkCsharp(child, filePath, here, hereClass, out);
  }
}

// ─── Python ──────────────────────────────────────────────────────────────

function walkPython(
  node: Node,
  filePath: string,
  enclosing: string,
  enclosingClass: string | undefined,
  out: TypeReference[],
): void {
  const t = node.type;

  let here = enclosing;
  let hereClass = enclosingClass;
  if (t === "function_definition") {
    const name = node.childForFieldName("name")?.text;
    if (name) here = name;
  } else if (t === "class_definition") {
    const name = node.childForFieldName("name")?.text;
    if (name) { here = name; hereClass = name; }
  }

  if (t === "assignment") {
    const typeNode = node.childForFieldName("type");
    if (typeNode) {
      const nameNode = node.childForFieldName("left");
      emitParsed(typeNode.text, "python", "variable", filePath, lineOf(node),
        nameNode ? (enclosing === "(top-level)" ? nameNode.text : `${enclosing}.${nameNode.text}`) : enclosing,
        enclosingClass, out);
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkPython(child, filePath, here, hereClass, out);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Thin wrapper that builds a TypeRefContext from the per-walker positional
 * args and delegates emission to the shared `emitTypeRefs`. Keeps the
 * walker call sites unchanged while routing all parsing/dedup through one
 * place.
 */
function emitParsed(
  rawType: string,
  language: Language,
  kindAtBase: TypeUsageKind,
  filePath: string,
  line: number,
  sourceSymbol: string,
  sourceClass: string | undefined,
  out: TypeReference[],
  confidenceOverride?: "EXTRACTED" | "INFERRED" | "AMBIGUOUS",
): void {
  const ctx: TypeRefContext = { filePath, language, line, sourceSymbol, sourceClass };
  emitTypeRefs(rawType, kindAtBase, ctx, out, confidenceOverride ?? "EXTRACTED");
}

function findChildByType(node: Node, type: string): Node | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) return c;
  }
  return null;
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

function stripLeadingColon(s: string): string {
  return s.trim().replace(/^:\s*/, "");
}
