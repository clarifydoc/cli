import type { CallBaseRef, HttpClientRegistration } from "../../../types/analysis.js";

/**
 * Go HTTP clients and URL holders with a stated base, keyed by the name a request names (its last segment, so
 * `s.client.R()` and `c.client = resty.New()` meet on `client`):
 *   client := resty.New().SetBaseURL("http://league-api:8080")      (also `SetHostURL`, a split chain,
 *   client.SetBaseURL(os.Getenv("LEAGUE_URL"))                        or a later `client.SetBaseURL(…)`)
 *   &Api{baseURL: "http://league-api:8080"}, a.baseURL = os.Getenv("LEAGUE_URL")   (a URL-named field or local a
 *                                                                       request joins its path onto)
 * A `:=` local is not a holder (the request's own local URL is read where it is built). Only a literal with a host, or an environment variable, is a base. Core refuses a name two registrations
 * of one file give different bases.
 */
const BASE_VALUE = String.raw`(?:"(https?:\/\/[^"\s]+)"|os\.Getenv\(\s*"(\w+)"\s*\))`;
const RESTY_BASE_RE = new RegExp(String.raw`\.\s*Set(?:BaseURL|HostURL)\(\s*${BASE_VALUE}\s*\)`);
const RESTY_DECL_RE = /^\s*(?:var\s+)?((?:\w+\.)*\w+)\s*(?::=|=)\s*resty\.New\w*\(/;
const RESTY_SET_RE = new RegExp(String.raw`(?:^\s*|[;{]\s*)((?:\w+\.)*\w+)\.Set(?:BaseURL|HostURL)\(\s*${BASE_VALUE}\s*\)`);
const URL_HOLDER_RE = new RegExp(String.raw`(?:^|[\s,{(])(?:\w+\.)?(\w*(?:[Bb]ase|URL|Url|Host|Addr|Endpoint)\w*)\s*(?:=|:)(?!=)\s*${BASE_VALUE}`);

const leaf = (name: string): string => name.slice(name.lastIndexOf(".") + 1);

function refOf(literal: string | undefined, env: string | undefined): CallBaseRef | null {
  if (literal) return { kind: "literal", key: literal };
  return env ? { kind: "env", key: env } : null;
}

/**
 * Client bases: resty `SetBaseURL`/`SetHostURL`, a URL-named field or assignment holding a literal or `os.Getenv`
 * state `httpClientRegistrations`; the api-call row names its receiver `client`.
 */
export function extractGoHttpClientRegistrations(lines: string[]): HttpClientRegistration[] {
  const out: HttpClientRegistration[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\/\//.test(line)) continue;
    const decl = RESTY_DECL_RE.exec(line);
    if (decl) {
      // The chain may run over the following lines (`.SetBaseURL(…)` on its own).
      let text = line;
      for (let j = i + 1; j < lines.length && j - i <= 6 && (text.trimEnd().endsWith(".") || /^\s*\./.test(lines[j]!)); j++) text += " " + lines[j]!.trim();
      const m = RESTY_BASE_RE.exec(text);
      const base = m ? refOf(m[1], m[2]) : null;
      if (base) out.push({ client: leaf(decl[1]!), scope: "file", base, line: i + 1 });
      continue;
    }
    const set = RESTY_SET_RE.exec(line);
    if (set) {
      const base = refOf(set[2], set[3]);
      if (base) out.push({ client: leaf(set[1]!), scope: "file", base, line: i + 1 });
      continue;
    }
    const holder = URL_HOLDER_RE.exec(line);
    if (holder) {
      const base = refOf(holder[2], holder[3]);
      if (base) out.push({ client: holder[1]!, scope: "file", base, line: i + 1 });
    }
  }
  return out;
}

/** The names the file registers, for the request rows that name one. */
export function goRegisteredClients(lines: string[]): Set<string> {
  return new Set(extractGoHttpClientRegistrations(lines).map((r) => r.client));
}
