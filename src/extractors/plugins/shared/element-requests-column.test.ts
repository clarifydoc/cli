import { describe, it, expect } from "vitest";
import { extractHtmlInteractiveElements } from "../html/index.js";
import { materializeElementRequests } from "./element-requests.js";
import { readPhpView } from "../php/views.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const blank = (filePath: string) => ({ filePath, language: "php", functions: [], classes: [], imports: [], dataSources: [], interactiveElements: [], screens: [], subComponents: [] }) as unknown as FileAnalysis;

describe("element requests carry a column", () => {
  it("points the api-call row at the form tag, after a non-ASCII prefix too", () => {
    const a = blank("clubs.html");
    a.interactiveElements = extractHtmlInteractiveElements(['<p>é🚗</p> <form action="/clubs" method="post"></form>', '  <a href="/players">Players</a>', '<!-- x --> <a href="/cars">Cars</a>'], { requests: true });
    materializeElementRequests(a);
    expect(a.dataSources.map((d) => [d.name, d.line, d.column])).toEqual([["POST /clubs", 1, 11], ["GET /players", 2, 2], ["GET /cars", 3, undefined]]);
  });

  it("states a PHP view column only where no PHP tag rewrote the line before it", () => {
    const a = blank("views/clubs.php");
    readPhpView(a, `<div>
  <a href="/clubs">Clubs</a>
  <?= $x ?> <a href="/players">Players</a>
</div>`);
    expect(a.dataSources.filter((d) => d.kind === "api-call").map((d) => [d.line, d.column])).toEqual([[2, 2], [3, undefined]]);
  });
});
