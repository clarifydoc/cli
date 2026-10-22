import type { Node } from "web-tree-sitter";

/** Strip surrounding single, double, or backtick quotes from a string. */
export function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith("`") && s.endsWith("`"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** Determine access visibility from a node's text or children. */
export function getVisibility(
  node: Node,
): "public" | "private" | "protected" | null {
  // C#: explicit modifier child nodes
  for (const child of node.children) {
    if (child.type === "modifier") {
      if (child.text === "public") return "public";
      if (child.text === "private") return "private";
      if (child.text === "protected") return "protected";
    }
  }
  // JS/TS/Java/Kotlin: the keyword in the declaration's head — before its name
  // or body, never in its members (a public class with a private field is public).
  const end = node.childForFieldName("name") ?? node.childForFieldName("body");
  const unannotated = (s: string) => s.replace(/@[\w.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?/g, "");
  const head = end ? unannotated(node.text.slice(0, end.startIndex - node.startIndex)) : unannotated(node.text).split(/[{(=;]/)[0]!;
  const word = /\b(private|protected|public)\b/.exec(head)?.[1];
  return (word as "public" | "private" | "protected" | undefined) ?? null;
}

/** Check whether a node has a direct child with type `modifier` and the given text. */
export function hasModifier(node: Node, modifier: string): boolean {
  for (const child of node.children) {
    if (child.type === "modifier" && child.text === modifier) return true;
  }
  return false;
}

/**
 * Extract a node's name using tree-sitter field access first, then child scanning.
 * Inspired by the `_get_name` pattern in code-review-graph's parser.py.
 */
export function getNameFromNode(node: Node): string | null {
  // Primary: field-based access (most reliable)
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;

  // Fallback: scan children for identifier-like types
  for (const child of node.children) {
    if (
      child.type === "identifier" ||
      child.type === "type_identifier" ||
      child.type === "property_identifier" ||
      child.type === "simple_identifier"
    ) {
      return child.text;
    }
  }
  return null;
}

/**
 * Traverse a member_expression / scoped_identifier chain and return the full
 * qualified name (e.g., "foo.bar.Baz").
 */
export function getQualifiedName(node: Node): string {
  if (
    node.type === "member_expression" ||
    node.type === "scoped_identifier" ||
    node.type === "attribute" ||
    node.type === "qualified_name" ||
    node.type === "nested_identifier"
  ) {
    return node.text;
  }
  if (node.type === "identifier" || node.type === "type_identifier") {
    return node.text;
  }
  return node.text;
}

/**
 * Extract the function/method name from a call expression node.
 * Handles simple calls, method calls (obj.method), and scoped calls.
 */
export function getCallName(node: Node): string | null {
  const callee =
    node.childForFieldName("function") ?? // JS/TS/Go/Rust
    node.childForFieldName("name") ?? // Java method_invocation
    node.child(0);

  if (!callee) return null;

  if (callee.type === "identifier") return callee.text;

  if (
    callee.type === "member_expression" ||
    callee.type === "attribute" ||
    callee.type === "field_expression" ||
    callee.type === "selector_expression"
  ) {
    const prop =
      callee.childForFieldName("property") ??
      callee.childForFieldName("field") ??
      callee.childForFieldName("attribute");
    return prop?.text ?? callee.text;
  }

  if (callee.type === "scoped_identifier" || callee.type === "qualified_name") {
    return callee.text;
  }

  return null;
}

/** Extract JS/TS decorators from preceding siblings. */
export function extractJsDecorators(node: Node): string[] {
  const decorators: string[] = [];
  const parent = node.parent;
  if (!parent) return decorators;

  for (const sibling of parent.children) {
    // web-tree-sitter mints a new wrapper per access, so `===` never matched
    // and the loop swept every decorator in the class body onto every method.
    if (sibling.id === node.id) break;
    if (sibling.type === "decorator") {
      const expr = sibling.child(1);
      decorators.push(expr?.text ?? sibling.text.replace(/^@/, ""));
    } else if (sibling.isNamed && sibling.type !== "comment") {
      // (A comment inside the run — `// legacy index` between two decorators — is part of it.)
      // A decorator run belongs to the member right after it; passing another
      // member (not a `;`/`,` token) starts a new run.
      decorators.length = 0;
    }
  }
  return decorators;
}

/** Extract Java/Kotlin annotations from a node's children and modifiers block. */
export function extractAnnotations(node: Node): string[] {
  const annotations: string[] = [];
  for (const child of node.children) {
    if (
      child.type === "annotation" ||
      child.type === "marker_annotation" ||
      child.type === "single_element_annotation"
    ) {
      annotations.push(child.text.replace(/^@/, ""));
    }
    if (child.type === "modifiers") {
      for (const mod of child.children) {
        if (
          mod.type === "annotation" ||
          mod.type === "marker_annotation" ||
          mod.type === "single_element_annotation"
        ) {
          annotations.push(mod.text.replace(/^@/, ""));
        }
      }
    }
  }
  return annotations;
}

/** Extract C# attributes from a node's attribute_list children. */
export function extractCsharpAttributes(node: Node): string[] {
  const decorators: string[] = [];
  for (const child of node.children) {
    if (child.type === "attribute_list") {
      for (const attr of child.children) {
        if (attr.type === "attribute") {
          // Full attribute text, arguments included — `Authorize(Policy = X)`,
          // `ApiVersion("2", Deprecated = true)`. The arguments are where
          // routing, auth and serialization semantics live; the bare name was
          // useless to every consumer that needed them. Matches what the
          // JS/Python decorator helpers keep. Whitespace collapsed so a
          // multi-line attribute is one line.
          decorators.push(attr.text.replace(/\s+/g, " "));
        }
      }
    }
  }
  return decorators;
}

/** Extract Python decorators from a decorated_definition's children. */
export function extractPythonDecorators(node: Node): string[] {
  const decorators: string[] = [];
  for (const child of node.children) {
    if (child.type === "decorator") {
      decorators.push(child.text.replace(/^@/, ""));
    }
  }
  return decorators;
}

/** Find the first child node of a given type. */
export function findChildByType(node: Node, type: string): Node | null {
  for (const child of node.children) {
    if (child.type === type) return child;
  }
  return null;
}

/** Check if a node has a child of the given type. */
export function hasChildType(node: Node, type: string): boolean {
  for (const child of node.children) {
    if (child.type === type) return true;
  }
  return false;
}
