import { describe, it, expect } from "vitest";
import { extractCustomElements } from "./web-components.js";

describe("web component (custom element) detection", () => {
  it("detects customElements.define('tag', Class)", () => {
    const src = `class UserCard extends HTMLElement {}
customElements.define('user-card', UserCard);`;
    expect(extractCustomElements(src)).toEqual([
      { tag: "user-card", className: "UserCard", line: 2 },
    ]);
  });

  it("detects window.customElements.define and Lit @customElement", () => {
    const src = `@customElement('my-badge')
export class MyBadge extends LitElement {}
window.customElements.define('user-avatar', UserAvatar);`;
    const defs = extractCustomElements(src);
    expect(defs.map((d) => `${d.tag}=${d.className}`).sort()).toEqual([
      "my-badge=MyBadge",
      "user-avatar=UserAvatar",
    ]);
  });

  it("requires a hyphenated tag (valid custom-element name) and skips plain files", () => {
    expect(extractCustomElements("const x = 1; foo.define('nothyphen', X);")).toEqual([]);
    expect(extractCustomElements("export function f() { return 1; }")).toEqual([]);
  });
});
