import type { HttpClientRegistration } from "../../../types/analysis.js";

/**
 * Retrofit clients: the base URL each API interface is created with, so the
 * calls its verb annotations declare (`@GET("orders")`) reach a service.
 *
 *   Retrofit.Builder().baseUrl("https://api.shop.test/").build().create(OrdersApi::class.java)
 *   val retrofit = Retrofit.Builder().baseUrl(BASE_URL).build(); retrofit.create(OrdersApi.class)
 *
 * The base is a literal, or a constant the file declares (`const val BASE_URL = "…"`,
 * `static final String BASE_URL = "…"`); one read from config says nothing here.
 * The registration is keyed by the interface's name, project-wide: a call
 * declared in the interface names it as its client.
 */
export function extractRetrofitClients(sourceText: string): HttpClientRegistration[] {
  if (!/\bRetrofit\.Builder\s*\(/.test(sourceText)) return [];
  const out: HttpClientRegistration[] = [];
  const consts = new Map<string, string>();
  for (const m of sourceText.matchAll(/\b(?:const\s+val|val|static\s+final\s+String|final\s+String|String)\s+([A-Z_][A-Z0-9_]*)\s*(?::\s*String\s*)?=\s*"([^"]+)"/g)) consts.set(m[1]!, m[2]!);
  const baseOf = (arg: string): string | undefined => {
    const lit = /^\s*"([^"]+)"\s*$/.exec(arg)?.[1];
    return lit ?? consts.get(arg.trim().split(".").pop()!);
  };
  const lineAt = (i: number) => sourceText.slice(0, i).split("\n").length;
  const push = (iface: string, base: string | undefined, at: number) => {
    if (out.some((r) => r.client === iface)) return;
    out.push({ client: iface, scope: "project", ...(base ? { base: { kind: "literal" as const, key: base } } : {}), line: lineAt(at) });
  };
  // One chain: `Retrofit.Builder()….baseUrl(X)….create(Api::class.java)`.
  // (Within one statement: not past a `;` or a line that starts the next declaration.)
  const ONE_STATEMENT = String.raw`(?:(?!\n\s*(?:val|var|private|public|protected|internal|fun|return|final|static|@)\b)[^;]){0,600}?`;
  for (const m of sourceText.matchAll(new RegExp(String.raw`Retrofit\.Builder\s*\(\s*\)(${ONE_STATEMENT})\.create\s*\(\s*([A-Z]\w*)(?:::class\.java|\.class)\s*\)`, "g"))) {
    const base = /\.baseUrl\s*\(\s*([^)]+)\)/.exec(m[1]!)?.[1];
    push(m[2]!, base ? baseOf(base) : undefined, m.index!);
  }
  // A builder kept in a variable, the interfaces created from it elsewhere in the file.
  for (const m of sourceText.matchAll(/\b(?:val|var|final\s+\w+|Retrofit)\s+(\w+)\s*(?::\s*Retrofit\s*)?=\s*Retrofit\.Builder\s*\(\s*\)([\s\S]{0,600}?)\.build\s*\(\s*\)/g)) {
    const base = /\.baseUrl\s*\(\s*([^)]+)\)/.exec(m[2]!)?.[1];
    const created = new RegExp(`\\b${m[1]}\\s*\\.\\s*create\\s*\\(\\s*([A-Z]\\w*)(?:::class\\.java|\\.class)\\s*\\)`, "g");
    for (const c of sourceText.matchAll(created)) push(c[1]!, base ? baseOf(base) : undefined, c.index!);
  }
  return out;
}
