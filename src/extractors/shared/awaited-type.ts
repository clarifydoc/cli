/** `Task<User>` → `User` when `Task` is one of the language's async result types; otherwise as written. */
export function awaitedType(written: string, asyncTypes: readonly string[] | undefined): string {
  if (!asyncTypes?.length) return written;
  const open = written.indexOf("<");
  if (open <= 0 || !written.endsWith(">")) return written;
  const name = written.slice(0, open).trim().split(/\.|::/).pop() ?? "";
  // `*Result` names a family by suffix: Rust's `io::Result`, `anyhow::Result`, `FlowyResult`.
  if (!asyncTypes.some((t) => (t.startsWith("*") ? name.endsWith(t.slice(1)) : t === name))) return written;
  const body = written.slice(open + 1, -1);
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) return body.slice(0, i).trim();
  }
  return body.trim();
}
