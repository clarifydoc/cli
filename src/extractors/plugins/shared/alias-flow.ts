/**
 * Flow order for an alias in a brace-delimited body, read line by line: `q = p` is typed by the binding of `p` that
 * the alias sees. The tracker keeps the open blocks and, per name, its bindings in text order — a stated type, or
 * null for a binding that states none (a call's result, a pattern, a write the reading cannot type).
 *
 * An alias is typed (`typeOf`) only when the head's nearest earlier binding states a type and sits in a block still
 * open at the alias: a binding in a block that closed before it, an untyped one, or an alias inside a loop or a
 * closure (which would see later bindings on the next pass) leave it untyped.
 */
export class AliasFlow {
  private nextId = 1;
  /** The text since the last statement or block boundary, which a `{` on a later line may still belong to (`while (c)` / `{`). */
  private tail = "";
  private readonly stack: Array<{ id: number; barrier: boolean }> = [{ id: 0, barrier: false }];
  private readonly events = new Map<string, Array<{ type: string | null; block: number }>>();
  private readonly sites = new Map<string, { head: string; type: string | null; barrier: boolean; again: boolean }>();

  /** `text` is a stretch of one statement: its `{` open blocks, its `}` close them. */
  advance(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "{") {
        const before = this.tail + text.slice(0, i);
        this.tail = "";
        this.stack.push({ id: this.nextId++, barrier: /\b(?:for|while|loop|do)\b[^{};]*$|\|\s*(?:->\s*[\w:<>]+\s*)?$|\]\s*(?:\([^)]*\))?\s*(?:mutable\s*)?(?:->\s*[\w:<>]+\s*)?$|=>\s*$/.test(before) });
      } else if (c === "}") {
        this.tail = "";
        if (this.stack.length > 1) this.stack.pop();
      }
    }
    this.tail += `${text.slice(Math.max(text.lastIndexOf("{"), text.lastIndexOf("}")) + 1)} `;
  }

  /** A `;` ended the statement. */
  terminate(): void {
    this.tail = "";
  }

  /** A binding of `name` here; `outside` is one that encloses no later statement (a loop head's declaration). */
  bind(name: string, type: string | null, outside = false): void {
    const list = this.events.get(name) ?? this.events.set(name, []).get(name)!;
    list.push({ type, block: outside ? -1 : this.stack[this.stack.length - 1]!.id });
  }

  /** The alias `name` of `head`, written here: what its head's nearest binding says. */
  alias(name: string, head: string): void {
    const list = this.events.get(head);
    const last = list?.[list.length - 1];
    const open = last !== undefined && this.stack.some((b) => b.id === last.block);
    // An alias written twice (a name rebound): one entry per name cannot say which head binding each saw.
    this.sites.set(name, { head, type: last && open ? last.type : null, barrier: this.stack.some((b) => b.barrier), again: this.sites.has(name) });
  }

  bindings(name: string): number {
    return this.events.get(name)?.length ?? 0;
  }

  /**
   * The type of alias `name`: a string when its head's nearest binding states one, null when the head is bound more
   * than once and that binding does not, or the alias sits in a loop or closure (the alias stays untyped), undefined when
   * the flow adds nothing (the head is bound at most once: the caller's own rule applies).
   */
  typeOf(name: string): string | null | undefined {
    const site = this.sites.get(name);
    if (!site || this.bindings(site.head) < 2) return undefined;
    return site.barrier || site.again ? null : site.type;
  }
}
