import { describe, expect, it } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractAttributeReads } from "./attribute-reads.js";

describe("URL attributes a script reads", () => {
  it("names each data-*url attribute read, with the one verb its function requests it with", async () => {
    const src = `export async function linkAction(el) {
  const url = el.getAttribute('data-url');
  const method = el.getAttribute('data-method') || 'POST';
  await fetch(url, { method });
}
export function rename(btn) {
  return PUT(btn.dataset.updateUrl, {});
}
export function preview(el) {
  const href = el.dataset.previewUrl;
  return href;
}`;
    const tree = await parseSource(src, "typescript" as never, "x.ts");
    expect(extractAttributeReads(tree, src)).toEqual([
      { attribute: "data-url", method: "POST", line: 2 },
      { attribute: "data-update-url", method: "PUT", line: 7 },
      { attribute: "data-preview-url", line: 10 },
    ]);
  });
});
