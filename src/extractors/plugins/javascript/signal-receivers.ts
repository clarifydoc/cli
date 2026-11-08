import type { Node } from "web-tree-sitter";
import { containerLookup, namesReceiverType, type InjectedType } from "./di.js";

/**
 * A receiver that is a call of an Angular signal field — `this.clubs().rename(…)` with `clubs = input.required<ClubService>()`,
 * `svc = signal<ClubService>(…)`, `club = model<Club>()`, `viaCtor = computed(() => inject(ClubService))`, or a field
 * annotated `Signal<ClubService>` / `WritableSignal<…>` / `InputSignal<…>`: the type the signal holds, as the field states it
 * (a generic argument, else the container lookup it is built from). A field of no stated type, or one that is not a signal,
 * states nothing — the receiver stays untyped, never guessed by name.
 */
export function signalReceiverTypeOfCall(node: Node): InjectedType | null {
  if (node.type !== "call_expression") return null;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_expression") return null;
  const obj = fn.childForFieldName("object");
  return obj?.type === "call_expression" ? signalReceiverType(obj) : null;
}

function signalReceiverType(callee: Node): InjectedType | null {
  if (callee.type !== "call_expression") return null;
  if ((callee.childForFieldName("arguments")?.namedChildCount ?? 0) > 0) return null;
  const fn = callee.childForFieldName("function");
  if (!fn) return null;
  // `this.clubs()`; a bare `clubs()` is a local or a function, not a field.
  if (fn.type !== "member_expression" || fn.childForFieldName("object")?.type !== "this") return null;
  const name = fn.childForFieldName("property")?.text;
  if (!name) return null;
  let body: Node | null = callee.parent;
  while (body && body.type !== "class_body") body = body.parent;
  if (!body) return null;
  for (const member of body.namedChildren) {
    if (member.type !== "public_field_definition" && member.type !== "field_definition") continue;
    const id = member.childForFieldName("name") ?? member.childForFieldName("property");
    if (id?.text !== name) continue;
    return annotatedSignal(member.childForFieldName("type")) ?? createdSignal(member.childForFieldName("value"));
  }
  return null;
}

const SIGNAL_TYPES = /^(?:Signal|WritableSignal|InputSignal|InputSignalWithTransform|ModelSignal)$/;
const SIGNAL_FACTORIES = /^(?:signal|input|input\.required|model|model\.required|computed|linkedSignal)$/;

/** `x: Signal<ClubService>` → ClubService. */
function annotatedSignal(annotation: Node | null): InjectedType | null {
  const type = annotation?.namedChild(0);
  if (type?.type !== "generic_type") return null;
  const head = type.childForFieldName("name") ?? type.namedChild(0);
  if (!head || !SIGNAL_TYPES.test(head.text)) return null;
  return held(type.namedChildren.find((c) => c.type === "type_arguments")?.namedChild(0)?.text);
}

/** `signal<ClubService>(…)`, `input.required<ClubService>()`, `computed(() => inject(ClubService))`. */
function createdSignal(value: Node | null): InjectedType | null {
  while (value && (value.type === "parenthesized_expression" || value.type === "as_expression" || value.type === "non_null_expression")) value = value.namedChild(0);
  if (value?.type !== "call_expression") return null;
  const fn = value.childForFieldName("function");
  if (!fn || !SIGNAL_FACTORIES.test(fn.text)) return null;
  const generic = held(value.childForFieldName("type_arguments")?.namedChild(0)?.text);
  if (generic) return generic;
  const first = value.childForFieldName("arguments")?.namedChild(0);
  if (!first) return null;
  if (first.type === "call_expression") return containerLookup(first);
  if (first.type === "arrow_function") {
    let result = first.childForFieldName("body");
    if (result?.type === "statement_block") {
      const returns = result.namedChildren.filter((s) => s.type === "return_statement");
      result = returns.length === 1 ? returns[0]!.namedChild(0) : null;
    }
    return result?.type === "call_expression" ? containerLookup(result) : null;
  }
  return null;
}

/** A type text that names one class, with `null`/`undefined` taken off a union (`Garage | null` → Garage). */
function held(text: string | undefined): InjectedType | null {
  if (!text || !namesReceiverType(text)) return null;
  const member = text.split("|").map((m) => m.trim()).find((m) => m && m !== "null" && m !== "undefined");
  return member ? { type: member } : null;
}
