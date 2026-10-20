import type { Node, Tree } from "web-tree-sitter";
import type { InteractiveElementInfo, Language } from "../../../types/analysis.js";

/** HTML tags that map to interactive element types */
export const INTERACTIVE_TAGS: Record<string, InteractiveElementInfo["element"]> = {
  button: "button",
  input: "input",
  form: "form",
  a: "link",
  select: "select",
  textarea: "textarea",
};

/**
 * Extract interactive elements from JSX/TSX source.
 * Finds elements with event handler props (onClick, onChange, onSubmit, etc.)
 */
export function extractInteractiveElements(
  tree: Tree,
  _sourceText: string,
  language: Language,
): InteractiveElementInfo[] {
  if (language !== "typescript" && language !== "javascript") return [];

  const elements: InteractiveElementInfo[] = [];
  walkForInteractive(tree.rootNode, elements);
  return elements;
}

function walkForInteractive(node: Node, elements: InteractiveElementInfo[]) {
  if (
    node.type === "jsx_opening_element" ||
    node.type === "jsx_self_closing_element"
  ) {
    const nameNode = node.childForFieldName("name") ?? node.child(1);
    if (nameNode) {
      const tagName = nameNode.text;
      const events = extractEventProps(node);

      for (const ev of events) {
        const element = resolveElementType(tagName);
        elements.push({
          element,
          event: ev.event,
          handler: ev.handler,
          line: node.startPosition.row + 1,
          ...(element === "custom" ? { component: tagName } : {}),
        });
      }
    }
  }

  for (const child of node.children) {
    walkForInteractive(child, elements);
  }
}

/** Extract event handler props from a JSX element (onClick, onChange, etc.) */
function extractEventProps(node: Node): { event: string; handler: string | null }[] {
  const events: { event: string; handler: string | null }[] = [];

  for (const child of node.children) {
    if (child.type === "jsx_attribute") {
      const attrName = child.childForFieldName("name")?.text ?? child.child(0)?.text;
      if (attrName && isEventProp(attrName)) {
        const handler = extractHandlerName(child);
        events.push({ event: attrName, handler });
      }
    }
  }

  return events;
}

/** Check if a JSX prop name is an event handler (starts with on + uppercase) */
export function isEventProp(name: string): boolean {
  return /^on[A-Z]/.test(name);
}

/** Extract the handler function name from a JSX attribute value */
function extractHandlerName(attrNode: Node): string | null {
  // tree-sitter-typescript's jsx_attribute exposes NO `value` field (children
  // are [name, "=", jsx_expression]), so the field lookup returns null on every
  // attribute — which silently nulled every React handler. Fall back to the
  // positional value child.
  const valueNode = attrNode.childForFieldName("value")
    ?? attrNode.children.find((c) => c.type === "jsx_expression" || c.type === "string");
  if (!valueNode) return null;

  // {handleClick} → jsx_expression containing identifier
  // {() => handleClick()} → jsx_expression containing arrow_function
  for (const child of valueNode.children) {

    // Direct reference: onClick={handleClick}
    if (child.type === "identifier") return child.text;

    // Member expression: onClick={this.handleClick}
    if (child.type === "member_expression") {
      return child.childForFieldName("property")?.text ?? child.text;
    }

    // Arrow function: onClick={() => doThing()} or onClick={(e) => handleClick(e)}
    if (child.type === "arrow_function") {
      return extractCallFromArrow(child);
    }

    // Function expression: onClick={function() { doThing() }}
    if (child.type === "function_expression") {
      return extractCallFromArrow(child);
    }
  }
  return null;
}

/** Extract the first meaningful call name from an arrow function body */
function extractCallFromArrow(funcNode: Node): string | null {
  const body = funcNode.childForFieldName("body");
  if (!body) return null;

  // () => handleClick(), or a block: () => { e.stopPropagation(); handleClick(); }
  return findFirstCall(body);
}

/**
 * Calls an inline handler makes on the way to the real one: event plumbing
 * (`e.stopPropagation()`), conversions (`Number(v)`) and logging. Naming the
 * element after one of them hid the handler it actually runs.
 */
const NOISE_CALLS = new Set([
  "stopPropagation", "preventDefault", "stopImmediatePropagation", "persist",
  "Number", "String", "Boolean", "parseInt", "parseFloat", "trim", "toString",
  "log", "warn", "error", "debug", "info",
]);

/** The first call in source order that is not plumbing (see {@link NOISE_CALLS}). */
function findFirstCall(node: Node): string | null {
  let fallback: string | null = null;
  const visit = (n: Node): string | null => {
    if (n.type === "call_expression") {
      const name = getCalleeIdentifier(n);
      if (name && !NOISE_CALLS.has(name)) return name;
      fallback ??= name;
    }
    for (const child of n.children) {
      const result = visit(child);
      if (result) return result;
    }
    return null;
  };
  return visit(node) ?? fallback;
}

function getCalleeIdentifier(callNode: Node): string | null {
  const callee = callNode.childForFieldName("function");
  if (!callee) return null;
  if (callee.type === "identifier") return callee.text;
  if (callee.type === "member_expression") {
    return callee.childForFieldName("property")?.text ?? callee.text;
  }
  return null;
}

/** React Native's own controls: what a press or a text change happens on (`onPress`, `onChangeText`). */
const NATIVE_TAGS: Record<string, InteractiveElementInfo["element"]> = {
  Pressable: "button",
  TouchableOpacity: "button",
  TouchableHighlight: "button",
  TouchableWithoutFeedback: "button",
  TouchableNativeFeedback: "button",
  TextInput: "input",
  Switch: "input",
  Picker: "select",
};

/** Map a JSX tag name to an interactive element type */
function resolveElementType(tagName: string): InteractiveElementInfo["element"] {
  return NATIVE_TAGS[tagName] ?? INTERACTIVE_TAGS[tagName.toLowerCase()] ?? (/^[A-Z]/.test(tagName) ? "custom" : "button");
}

/**
 * Extract interactive elements from a Vue template string.
 * Finds HTML elements and components with @event bindings or v-model.
 */
export function extractVueInteractiveElements(
  template: string,
  fullSource: string,
): InteractiveElementInfo[] {
  const elements: InteractiveElementInfo[] = [];
  const templateStart = fullSource.indexOf(template);

  // Match tags with @event or v-on: bindings. A quoted attribute value may
  // hold a `>` (`v-if="items.length > 0"`), which does not end the tag.
  const tagRegex = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?\s*>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(template)) !== null) {
    const tagName = match[1]!;
    const attrs = match[2] ?? "";

    // Calculate line number
    const beforeMatch = fullSource.slice(0, templateStart + match.index);
    const line = (beforeMatch.match(/\n/g)?.length ?? 0) + 1;

    // Find @event bindings
    const eventRegex = /@([a-zA-Z][a-zA-Z0-9.-]*)(?:="([^"]*)")?/g;
    let eventMatch: RegExpExecArray | null;
    while ((eventMatch = eventRegex.exec(attrs)) !== null) {
      const event = `@${eventMatch[1]}`;
      const handler = eventMatch[2] || null;
      const element = resolveVueElementType(tagName);
      elements.push({
        element,
        event,
        handler,
        line,
        ...(element === "custom" ? { component: tagName } : {}),
      });
    }

    // Find v-on: bindings
    const vonRegex = /v-on:([a-zA-Z]+)(?:="([^"]*)")?/g;
    let vonMatch: RegExpExecArray | null;
    while ((vonMatch = vonRegex.exec(attrs)) !== null) {
      const vonElement = resolveVueElementType(tagName);
      elements.push({
        element: vonElement,
        event: `@${vonMatch[1]}`,
        handler: vonMatch[2] || null,
        line,
        ...(vonElement === "custom" ? { component: tagName } : {}),
      });
    }

    // Find v-model
    if (attrs.includes("v-model")) {
      const vmodelTag = tagName.toLowerCase();
      if (vmodelTag === "input" || vmodelTag === "select" || vmodelTag === "textarea" || /^[A-Z]/.test(tagName)) {
        elements.push({
          element: resolveVueElementType(tagName),
          event: "v-model",
          handler: null,
          line,
        });
      }
    }
  }

  return elements;
}

function resolveVueElementType(tagName: string): InteractiveElementInfo["element"] {
  const lower = tagName.toLowerCase();
  if (INTERACTIVE_TAGS[lower]) return INTERACTIVE_TAGS[lower]!;
  // PascalCase, kebab-case, or camelCase (dtpBtn) tags are components. The
  // camelCase case was previously misread as a raw <button>, so its @click
  // never matched the component in the screen tree.
  if (/^[A-Z]/.test(tagName) || tagName.includes("-") || /[a-z][A-Z]/.test(tagName)) {
    return "custom";
  }
  return "button";
}
