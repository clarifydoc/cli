import { templateScopes, type TemplateScope } from "./template-scopes.js";
import type { Node, Tree } from "web-tree-sitter";
import type { FunctionPropBinding, InteractiveElementInfo, Language, SlotFunction } from "../../../types/analysis.js";

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
  const scopes = templateScopes(template);

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
    // A handler may be single-quoted when it holds a double quote: `@click='pick("striker")'`.
    // An event may be namespaced: `@update:model-value="setScore"`.
    const eventRegex = /@([a-zA-Z][a-zA-Z0-9.:-]*)(?:="([^"]*)"|='([^']*)')?/g;
    let eventMatch: RegExpExecArray | null;
    while ((eventMatch = eventRegex.exec(attrs)) !== null) {
      const event = `@${eventMatch[1]}`;
      const handler = eventMatch[2] || eventMatch[3] || null;
      const element = resolveVueElementType(tagName);
      elements.push({
        element,
        event,
        handler,
        line,
        ...(element === "custom" ? { component: tagName } : {}),
        ...scopeOf(handler, scopes.get(match.index), fullSource),
      });
    }

    // Find v-on: bindings
    const vonRegex = /v-on:([a-zA-Z][a-zA-Z0-9.:-]*)(?:="([^"]*)"|='([^']*)')?/g;
    let vonMatch: RegExpExecArray | null;
    while ((vonMatch = vonRegex.exec(attrs)) !== null) {
      const vonElement = resolveVueElementType(tagName);
      elements.push({
        element: vonElement,
        event: `@${vonMatch[1]}`,
        handler: vonMatch[2] || vonMatch[3] || null,
        line,
        ...(vonElement === "custom" ? { component: tagName } : {}),
        ...scopeOf(vonMatch[2] || vonMatch[3] || null, scopes.get(match.index), fullSource),
      });
    }

    // A function handed to a component as a prop (`:add="(club) => create.mutateAsync(club)"`):
    // the child calls it as `props.add(…)`, as it would emit an event bound with `@add`.
    if (resolveVueElementType(tagName) === "custom" && attrs.includes("=>")) {
      const bindRegex = /(?:^|\s)(?::|v-bind:)([a-zA-Z][\w-]*)=(?:"([^"]*)"|'([^']*)')/g;
      let bindMatch: RegExpExecArray | null;
      while ((bindMatch = bindRegex.exec(attrs)) !== null) {
        const value = (bindMatch[2] ?? bindMatch[3] ?? "").trim();
        // Vue's own attributes are no props: a function `:ref` receives the element.
        if (VUE_RESERVED_ATTRS.has(bindMatch[1]!)) continue;
        if (INLINE_FUNCTION.test(value)) {
          elements.push({ element: "custom", event: `:${bindMatch[1]}`, handler: value, line, component: tagName });
        } else {
          // `:options="{ onClick: () => remove(id) }"`: each arrow of the object is a function of its own.
          for (const [key, arrow] of objectArrows(value)) {
            elements.push({ element: "custom", event: `:${bindMatch[1]}.${key}`, handler: arrow, line, component: tagName });
          }
        }
      }
      // `v-bind="{ onSave: () => save(club) }"`: an object of props; each arrow is the prop it names.
      const objectRegex = /(?:^|\s)v-bind\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      for (let obj = objectRegex.exec(attrs); obj; obj = objectRegex.exec(attrs)) {
        for (const [key, arrow] of objectArrows((obj[1] ?? obj[2] ?? "").trim())) {
          elements.push({ element: "custom", event: `:${key}`, handler: arrow, line, component: tagName });
        }
      }
    }

    // Find v-model
    if (attrs.includes("v-model")) {
      const vmodelTag = tagName.toLowerCase();
      // A component's v-model too, however its tag is written (`ScoreInput`, `score-input`, `scoreInput`).
      if (vmodelTag === "input" || vmodelTag === "select" || vmodelTag === "textarea" || resolveVueElementType(tagName) === "custom") {
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

/**
 * The arrow and function-expression entries of an object literal written in markup
 * (`{ onSave: () => save(club), label: 'x', onClose: close }` → `onSave`), each with its text.
 */
function objectArrows(value: string): Array<[string, string]> {
  if (!value.startsWith("{") || !value.endsWith("}") || !value.includes("=>") && !value.includes("function")) return [];
  const body = value.slice(1, -1);
  const entries: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      entries.push(body.slice(from, i));
      from = i + 1;
    }
  }
  entries.push(body.slice(from));
  const out: Array<[string, string]> = [];
  for (const entry of entries) {
    const m = /^\s*['"]?([A-Za-z_$][\w$-]*)['"]?\s*:\s*([\s\S]+?)\s*$/.exec(entry);
    if (m && INLINE_FUNCTION.test(m[2]!)) out.push([m[1]!, m[2]!]);
  }
  return out;
}

/** The names `handler` reads that the scopes in force bind (`InteractiveElementInfo.scope`). */
function scopeOf(handler: string | null, scopes: TemplateScope[] | undefined, fullSource: string): Pick<InteractiveElementInfo, "scope"> {
  if (!handler || !scopes) return {};
  const found: NonNullable<InteractiveElementInfo["scope"]> = [];
  // The innermost scope binding a name wins.
  for (const scope of [...scopes].reverse()) {
    for (const name of scope.names) {
      if (found.some((f) => f.name === name) || !new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(handler)) continue;
      if (scope.kind === "slot") found.push({ name, slot: { component: scope.component!, name: scope.slot!, prop: scope.props![name]! } });
      else {
        const type = name === scope.names[0] ? elementTypeOf(scope.source!, fullSource) : undefined;
        if (type) found.push({ name, type });
        else found.push({ name });
      }
    }
  }
  return found.length > 0 ? { scope: found } : {};
}

/**
 * The class a script states for the elements of a collection a template loops over (`clubs` →
 * `Club` from `const clubs = ref<Club[]>([])`, `clubs: Club[]` in a props type, `const clubs: Array<Club>`,
 * `PropType<Club[]>`); one answer, or none.
 */
function elementTypeOf(source: string, script: string): string | undefined {
  const name = /^(?:(?:props|this)\.)?([A-Za-z_$][\w$]*)$/.exec(source.trim())?.[1];
  if (!name || !/^\w+$/.test(name)) return undefined;
  const candidates: string[] = [];
  const grab = (re: RegExp) => {
    for (const m of script.matchAll(re)) candidates.push(m[1]!);
  };
  grab(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*:\\s*([^=;\\n]+)`, "g"));
  grab(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*[\\w$]+\\s*<([^()\\n]+)>\\s*\\(`, "g"));
  grab(new RegExp(`(?<![\\w$.])${name}\\??\\s*:\\s*([^;,\\n}]+)`, "g"));
  grab(new RegExp(`(?<![\\w$.])${name}\\s*:\\s*\\{[^}]*PropType<([^>]+(?:<[^>]*>)?)>`, "g"));
  const types = new Set<string>();
  for (const c of candidates) {
    const t = c.trim().replace(/^(?:Ref|ShallowRef|MaybeRef|ComputedRef)<(.+)>$/, "$1").replace(/^readonly\s+/, "").trim();
    const m = /^([A-Z][\w$]*)\[\]$/.exec(t) ?? /^Array<([A-Z][\w$]*)>$/.exec(t);
    if (m) types.add(m[1]!);
  }
  return types.size === 1 ? [...types][0] : undefined;
}

/**
 * Functions a Vue template hands a child component by name as a prop (`:on-confirm="confirmDeletion"`,
 * `:update-selected="setSelected"`): a bare name `handsOn` accepts — one of the file's functions, or
 * an `on…` callback it passes on. A data binding (`:club-id="clubId"`) is never one.
 */
export function extractVueFunctionProps(template: string, fullSource: string, handsOn: (name: string) => boolean): FunctionPropBinding[] {
  if (!/(?:^|\s)(?::|v-bind:)[\w-]+=|(?:^|\s)v-bind=/.test(template)) return [];
  const out: FunctionPropBinding[] = [];
  const templateStart = fullSource.indexOf(template);
  const tagRegex = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?\s*>/g;
  for (let match = tagRegex.exec(template); match; match = tagRegex.exec(template)) {
    const tagName = match[1]!;
    if (resolveVueElementType(tagName) !== "custom") continue;
    const bindRegex = /(?:^|\s)(?::|v-bind:)([a-zA-Z][\w-]*)=(?:"\s*([A-Za-z_$][\w$]*)\s*"|'\s*([A-Za-z_$][\w$]*)\s*')/g;
    for (let bind = bindRegex.exec(match[2] ?? ""); bind; bind = bindRegex.exec(match[2] ?? "")) {
      const handler = bind[2] ?? bind[3]!;
      if (VUE_RESERVED_ATTRS.has(bind[1]!) || !handsOn(handler)) continue;
      const line = fullSource.slice(0, templateStart + match.index).split("\n").length;
      out.push({ component: tagName, prop: bind[1]!.replace(/-([a-z\d])/g, (_m, c: string) => c.toUpperCase()), handler, line });
    }
    // `v-bind="{ onSave: saveClub, onClose }"`: an object of props; the `on…` entries naming a function.
    const objectRegex = /(?:^|\s)v-bind\s*=\s*(?:"\s*\{([^"]*)\}\s*"|'\s*\{([^']*)\}\s*')/g;
    for (let obj = objectRegex.exec(match[2] ?? ""); obj; obj = objectRegex.exec(match[2] ?? "")) {
      const line = fullSource.slice(0, templateStart + match.index).split("\n").length;
      for (const entry of (obj[1] ?? obj[2] ?? "").split(",")) {
        const e = /^\s*(on[A-Z]\w*)\s*(?::\s*([A-Za-z_$][\w$]*)\s*)?$/.exec(entry);
        const handler = e?.[2] ?? e?.[1];
        if (e && handler && handsOn(handler)) out.push({ component: tagName, prop: e[1]!, handler, line });
      }
    }
  }
  return out;
}

/**
 * `<slot name="row" :save="saveAll" />`: the functions of the file the template offers its slot's
 * content by name. A bare name `handsOn` accepts only.
 */
export function extractSlotFunctions(template: string, fullSource: string, handsOn: (name: string) => boolean): SlotFunction[] {
  if (!/<slot\b/.test(template)) return [];
  const out: SlotFunction[] = [];
  const templateStart = fullSource.indexOf(template);
  for (const m of template.matchAll(/<slot\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g)) {
    const attrs = m[1] ?? "";
    const slot = /(?:^|\s)name\s*=\s*"([^"]+)"/.exec(attrs)?.[1] ?? "default";
    const line = fullSource.slice(0, templateStart + m.index!).split("\n").length;
    for (const b of attrs.matchAll(/(?:^|\s)(?::|v-bind:)([a-zA-Z][\w-]*)\s*=\s*"\s*([A-Za-z_$][\w$]*)\s*"/g)) {
      if (b[1] === "name" || !handsOn(b[2]!)) continue;
      out.push({ slot, prop: b[1]!.replace(/-([a-z\d])/g, (_m, c: string) => c.toUpperCase()), handler: b[2]!, line });
    }
  }
  return out;
}

/** Attributes Vue handles itself, never passed to the component as props. */
const VUE_RESERVED_ATTRS = new Set(["ref", "key", "is", "class", "style", "slot"]);

/** An arrow or function expression as written in markup: `(a, b) => …`, `club => …`, `async () => …`. */
const INLINE_FUNCTION = /^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>|^(?:async\s+)?function\b/;

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
