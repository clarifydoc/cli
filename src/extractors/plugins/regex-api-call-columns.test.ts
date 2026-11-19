import { describe, it, expect } from "vitest";
import "../registry.js";
import { regexSpecFor } from "../registry.js";
import type { Language } from "../../types/analysis.js";

/** One api-call per sample; the row's column must be where the call's token starts on its line (UTF-16 units, after a non-ASCII prefix). */
const SAMPLES: Array<{ language: Language; lines: string[]; line: number; token: string }> = [
  { language: "applescript", lines: ['set s to "é🚗" & do shell script "curl https://clubs.example/api/clubs"'], line: 0, token: "do shell script" },
  { language: "autohotkey", lines: ['http := ComObject("WinHttp.WinHttpRequest.5.1")', 's := "é🚗", http.Open("GET", "https://clubs.example/api/clubs")'], line: 1, token: "http.Open" },
  { language: "autoit", lines: ['$http = ObjCreate("winhttp.winhttprequest.5.1")', 'Local $s = "é🚗", $r = InetGet("https://clubs.example/api/clubs")'], line: 1, token: "InetGet" },
  { language: "batch", lines: ["echo é🚗 & curl -X POST https://clubs.example/api/clubs"], line: 0, token: "curl" },
  { language: "blazor", lines: ["@inject HttpClient Http", '@code { async Task Load() { var s = "é🚗"; await Http.GetFromJsonAsync<Club[]>("/api/clubs"); } }'], line: 1, token: "Http.GetFromJsonAsync" },
  { language: "clojure", lines: ['(def s "é🚗") (http/get "https://clubs.example/api/clubs")'], line: 0, token: "(http/get" },
  { language: "coffeescript", lines: ["s = 'é🚗'; fetch('/api/clubs')"], line: 0, token: "fetch" },
  { language: "crystal", lines: ['s = "é🚗"; HTTP::Client.get "https://clubs.example/api/clubs"'], line: 0, token: "HTTP::Client.get" },
  { language: "dlang", lines: ['auto s = "é🚗"; requestHTTP("https://clubs.example/api/clubs", (scope req) {});'], line: 0, token: "requestHTTP" },
  { language: "groovy", lines: ['def s = "é🚗"; restTemplate.getForObject("/api/clubs", String)'], line: 0, token: ".getForObject" },
  { language: "haxe", lines: ['var s = "é🚗"; Http.requestUrl("https://clubs.example/api/clubs");'], line: 0, token: "Http.requestUrl" },
  { language: "mojo", lines: ['var requests = Python.import_module("requests")', 'var s = "é🚗"; requests.get("https://clubs.example/api/clubs")'], line: 1, token: "requests.get" },
  { language: "nim", lines: ['let s = "é🚗"; discard client.getContent("https://clubs.example/api/clubs")'], line: 0, token: ".getContent" },
  { language: "powershell", lines: ['$s = "é🚗"; Invoke-RestMethod -Uri "https://clubs.example/api/clubs"'], line: 0, token: "Invoke-RestMethod" },
  { language: "raku", lines: ["my $s = 'é🚗'; Cro::HTTP::Client.get('https://clubs.example/api/clubs');"], line: 0, token: "Cro::HTTP::Client" },
  { language: "vlang", lines: ["s := 'é🚗'; http.get('https://clubs.example/api/clubs')!"], line: 0, token: "http.get" },
  { language: "jsp", lines: ['<p>é🚗</p> <a href="/club/list.do">Clubs</a>'], line: 0, token: "<a href" },
];

describe("regex-tier api calls carry a column", () => {
  for (const s of SAMPLES) {
    it(`${s.language}: the call's start on its line`, () => {
      const spec = regexSpecFor(s.language);
      expect(spec, `${s.language} has a regex spec`).toBeDefined();
      const rows = (spec!.extractDataSources?.(s.lines, []) ?? []).filter((d) => d.kind === "api-call");
      expect(rows.length).toBe(1);
      expect(rows[0]!.line).toBe(s.line + 1);
      expect(rows[0]!.column).toBe(s.lines[s.line]!.indexOf(s.token));
    });
  }
});
