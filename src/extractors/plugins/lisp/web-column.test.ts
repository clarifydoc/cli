import { describe, it, expect } from "vitest";
import { tryReadForms } from "../shared/sexpr.js";
import { extractLispDataSources } from "./web.js";

describe("Lisp api calls carry a column", () => {
  it("points each call at its open paren, after a non-ASCII prefix and a line break", () => {
    const src = `(defun sync (id)\r\n  (list "é🚗" (dex:post "https://clubs.example.com/v1/players" :content id))\r\n  (dex:get "/clubs"))`;
    const calls = extractLispDataSources(tryReadForms(src, "lisp")!).filter((d) => d.kind === "api-call");
    expect(calls.map((d) => [d.name, d.line, d.column])).toEqual([
      ["POST https://clubs.example.com/v1/players", 2, 14],
      ["GET /clubs", 3, 2],
    ]);
  });
});
