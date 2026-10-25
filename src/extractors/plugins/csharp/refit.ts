import type { Node } from "web-tree-sitter";

/**
 * Refit API interfaces: each method's verb attribute declares the request a
 * call through the generated client sends —
 *
 *   public interface IClubApi {
 *     [Get("/{id}")] Task<Club> GetClub(int id);
 *     [Post("")] Task CreateClub([Body] Club club);
 *   }
 *
 * The base is the client's: `AddRefitClient<IClubApi>().ConfigureHttpClient(c =>
 * c.BaseAddress = …)` or `RestService.For<IClubApi>(…)`, registered under the
 * interface's name (http-clients.ts). Each row's target starts with that client
 * as an unknown base (`${IClubApi}/{id}`), which core replaces with the
 * registration's address — and which, unregistered, keeps the path from
 * passing for a whole one.
 */

/** A file that uses Refit. */
export const REFIT_GATE = /\busing\s+Refit\s*;|\bRefit\.(?:Get|Post|Put|Delete|Patch|Head|Options)\b/;

const VERB_ATTRIBUTE = /\[\s*(?:Refit\.)?(Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*@?"([^"]*)"/;

export interface RefitCall {
  verb: string;
  target: string;
  client: string;
  line: number;
}

/** The requests a Refit interface declares, one per method carrying a verb attribute. */
export function refitInterfaceCalls(iface: Node): RefitCall[] {
  const name = iface.childForFieldName("name")?.text;
  const body = iface.childForFieldName("body");
  if (!name || !body) return [];
  const out: RefitCall[] = [];
  for (const m of body.namedChildren) {
    if (m?.type !== "method_declaration") continue;
    for (const list of m.namedChildren) {
      if (list?.type !== "attribute_list") continue;
      const hit = VERB_ATTRIBUTE.exec(list.text);
      if (!hit) continue;
      const path = hit[2]!.split("?")[0]!;
      const tail = path === "" || path === "/" ? "" : path.startsWith("/") ? path : `/${path}`;
      out.push({ verb: hit[1]!.toUpperCase(), target: `\${${name}}${tail || "/"}`, client: name, line: list.startPosition.row + 1 });
      break;
    }
  }
  return out;
}
