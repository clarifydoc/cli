import type { ClassInfo, DataSourceInfo } from "../../../types/analysis.js";

/**
 * HTTP calls a component makes through an injected `HttpClient`:
 *
 *   @inject HttpClient Http
 *   await Http.PostAsync($"/api/clubs/{Name}/promote", null);
 *   var all = await Http.GetFromJsonAsync<List<Club>>("api/clubs");
 *
 * Only a receiver the file declares as an `HttpClient` (an `@inject`, an `[Inject]`
 * property or a field) counts: `Repo.GetAsync("x")` is somebody else's method. A URL that
 * is not a literal (a variable, a concatenation) states no path and gives no row.
 */
const CLIENT_DECL_RES = [
  /^\s*@inject\s+(?:System\.Net\.Http\.)?HttpClient\s+(\w+)\s*$/,
  /(?:\[Inject\]\s*)?(?:public|private|protected|internal)?\s*(?:readonly\s+)?(?:System\.Net\.Http\.)?HttpClient\??\s+(\w+)\s*(?:[{;=]|$)/,
];
const VERBS: Record<string, string> = {
  GetAsync: "GET", GetStringAsync: "GET", GetStreamAsync: "GET", GetByteArrayAsync: "GET", GetFromJsonAsync: "GET",
  PostAsync: "POST", PostAsJsonAsync: "POST", PutAsync: "PUT", PutAsJsonAsync: "PUT",
  PatchAsync: "PATCH", PatchAsJsonAsync: "PATCH", DeleteAsync: "DELETE", DeleteFromJsonAsync: "DELETE",
};
const CALL_RE = /\b(\w+)\.(\w+Async)(?:<[\w.<>,\s?\[\]]*>)?\(\s*\$?"((?:[^"\\]|\\.)*)"/g;

export function extractBlazorDataSources(lines: string[], _classes: ClassInfo[]): DataSourceInfo[] {
  const clients = new Set<string>();
  for (const line of lines) for (const re of CLIENT_DECL_RES) {
    const m = re.exec(line);
    if (m) clients.add(m[1]!);
  }
  if (clients.size === 0) return [];
  const out: DataSourceInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(CALL_RE)) {
      const verb = VERBS[m[2]!];
      if (!verb || !clients.has(m[1]!)) continue;
      let target = m[3]!;
      if (!/^(?:https?:\/\/|\/?[\w{][\w{}\-./]*)(?:\?.*)?$/.test(target)) continue;
      target = target.replace(/\?.*$/, "");
      if (!/^https?:/.test(target) && !target.startsWith("/")) target = "/" + target;
      out.push({ kind: "api-call", name: `${verb} ${target}`, target, calls: [], line: i + 1 });
    }
  }
  return out;
}
