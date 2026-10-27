import type { Node, Tree } from "web-tree-sitter";
import type { ComponentSubscription } from "../../../types/analysis.js";

/**
 * Outputs of a component the code creates itself and subscribes to — a dialog
 * opened by a modal service: `const modal = this.modalService.open(ConfirmDialogComponent)`
 * … `modal.componentInstance.confirmClicked.pipe(first()).subscribe(() => …)`, or
 * `(ref.componentInstance as ClubEditDialogComponent).saved.subscribe(…)`.
 * The markup's `(confirmClicked)="…"` binding, written in code: the
 * component-emit resolver joins the child's emit to the subscribing function.
 */
export function componentSubscriptions(tree: Tree, sourceText: string): ComponentSubscription[] {
  if (!sourceText.includes("componentInstance")) return [];
  const out: ComponentSubscription[] = [];
  const visit = (n: Node): void => {
    if (n.type === "call_expression") {
      const found = subscriptionOf(n);
      if (found) out.push(found);
    }
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(tree.rootNode);
  return out;
}

function subscriptionOf(call: Node): ComponentSubscription | null {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "member_expression" || fn.childForFieldName("property")?.text !== "subscribe") return null;
  // `x.pipe(first()).pipe(…)` before the subscribe: the observable is `x`.
  let source = fn.childForFieldName("object");
  while (source?.type === "call_expression") {
    const inner = source.childForFieldName("function");
    if (inner?.type !== "member_expression" || inner.childForFieldName("property")?.text !== "pipe") return null;
    source = inner.childForFieldName("object");
  }
  if (source?.type !== "member_expression") return null;
  const event = source.childForFieldName("property")?.text;
  let instance = source.childForFieldName("object");
  let component: string | null = null;
  if (instance?.type === "parenthesized_expression") {
    // `(ref.componentInstance as ClubEditDialogComponent)`
    const cast = instance.namedChild(0);
    if (cast?.type === "as_expression") {
      component = /^[A-Z][\w$]*$/.exec(cast.namedChild(1)?.text ?? "")?.[0] ?? null;
      instance = cast.namedChild(0);
    }
  }
  if (!event || instance?.type !== "member_expression" || instance.childForFieldName("property")?.text !== "componentInstance") return null;
  component ??= openedComponent(instance.childForFieldName("object"), call);
  return component ? { component, event, line: call.startPosition.row + 1 } : null;
}

/** The component class the reference holding the dialog was opened with: `modal = this.modalService.open(ConfirmDialogComponent, …)`, in the enclosing function. */
function openedComponent(ref: Node | null, at: Node): string | null {
  if (!ref || (ref.type !== "identifier" && ref.type !== "member_expression")) return null;
  const name = ref.text;
  let scope: Node | null = at.parent;
  while (scope && !/^(?:function_declaration|function_expression|arrow_function|method_definition)$/.test(scope.type)) scope = scope.parent;
  if (!scope) return null;
  const opened = new Set<string>();
  const visit = (n: Node): void => {
    let value: Node | null = null;
    if (n.type === "variable_declarator" && n.childForFieldName("name")?.text === name) value = n.childForFieldName("value");
    else if (n.type === "assignment_expression" && n.childForFieldName("left")?.text === name) value = n.childForFieldName("right");
    if (value?.type === "call_expression") {
      const open = value.childForFieldName("function");
      const first = value.childForFieldName("arguments")?.namedChildren.find((a) => a?.type !== "comment");
      if (open?.type === "member_expression" && open.childForFieldName("property")?.text === "open" && first?.type === "identifier" && /^[A-Z]/.test(first.text)) opened.add(first.text);
      else opened.add("");
    } else if (value) opened.add("");
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(scope);
  return opened.size === 1 && !opened.has("") ? [...opened][0]! : null;
}
