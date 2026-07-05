import { describe, it, expect } from "vitest";
import { htmlSpec, pageRoutePath } from "./index.js";

/**
 * Plain HTML page extraction. Vanilla multi-page static sites (the Food-order
 * website: 9 hand-written `.html` pages) were 100% invisible — `.html` was in no
 * extension allowlist, so screens/routes/interactiveElements were all 0. Each
 * page is a routed screen; its `<script src>` includes link it to the JS call
 * graph; `<a href>` links become navigation (built in core).
 */

const lines = (s: string) => s.split("\n");

describe("HTML page-route extraction (the page IS the screen)", () => {
  it("emits one inline frontend route at the page's URL, titled by <title>", () => {
    const routes = htmlSpec.extractRoutes!(
      lines(`<html><head><title>Search Page</title></head><body></body></html>`),
      [],
      "searchPage/search.html",
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      path: "/searchPage/search.html",
      kind: "frontend",
      httpMethod: null,
      componentPath: null, // inline → the page itself is the screen
      handler: "Search Page",
    });
  });

  it("maps index.html to its directory and the top-level index to '/'", () => {
    expect(pageRoutePath("index.html")).toBe("/");
    expect(pageRoutePath("shop/index.html")).toBe("/shop/");
    expect(pageRoutePath("cartpage/cart.html")).toBe("/cartpage/cart.html");
    expect(pageRoutePath("a\\b\\page.htm")).toBe("/a/b/page.htm"); // backslashes normalised
  });

  it("returns no route without a file path (path is derived from it)", () => {
    expect(htmlSpec.extractRoutes!(lines(`<title>x</title>`), [])).toEqual([]);
  });
});

describe("HTML local <script src> imports (page → JS call graph)", () => {
  const imp = htmlSpec.importPatterns[0]!;
  const src = (line: string) => {
    const m = line.match(imp.pattern);
    return m ? imp.getSource(m) : null;
  };
  it("captures a local script include", () => {
    expect(src(`<script src="./homepage/index.js"></script>`)).toBe("./homepage/index.js");
    expect(src(`<script src="login1.js" type=""></script>`)).toBe("login1.js");
  });
  it("ignores CDN / absolute-URL scripts (not project files)", () => {
    expect(src(`<script src="https://cdn.tailwindcss.com"></script>`)).toBe(null);
    expect(src(`<script src="//cdn.example.com/x.js"></script>`)).toBe(null);
  });
});

describe("HTML interactive-element extraction", () => {
  const els = (s: string) => htmlSpec.extractInteractiveElements!(lines(s));

  it("captures forms, buttons and submit-inputs, naming by id when there's no inline handler", () => {
    const out = els(
      `<form id="login-form">\n  <input type="text" id="mobile">\n  <input type="submit" value="LOGIN" id="log">\n  <button id="showbtn">SHOW</button>\n</form>`,
    );
    expect(out).toEqual([
      { element: "form", event: "submit", handler: "login-form", line: 1 },
      { element: "input", event: "input", handler: "mobile", line: 2 },
      { element: "button", event: "click", handler: "log", line: 3 }, // submit input → button
      { element: "button", event: "click", handler: "showbtn", line: 4 },
    ]);
  });

  it("resolves an inline on*= handler to its invoked function", () => {
    const out = els(`<button onclick="addToCart(3)">Add</button>`);
    expect(out[0]).toEqual({ element: "button", event: "onclick", handler: "addToCart", line: 1 });
  });

  it("emits a non-control tag only when it carries an inline handler (anchors→link)", () => {
    const out = els(`<a href="x.html">plain</a>\n<a href="#" onclick="logout()">Logout</a>`);
    expect(out).toEqual([
      { element: "link", event: "onclick", handler: "logout", line: 2 },
    ]);
  });

  it("skips checkbox/radio/hidden inputs (filter/state noise, not actions)", () => {
    const out = els(
      `<input type="checkbox" name="CUISINES" value="Asian">\n<input type="radio" name="x">\n<input type="hidden" name="t">\n<input type="email" id="email">`,
    );
    expect(out).toEqual([{ element: "input", event: "input", handler: "email", line: 4 }]);
  });

  it("does not read tag-like content inside comments or inline <script> as elements", () => {
    const out = els(
      `<!-- <button id="ghost">x</button> -->\n<script>\n  if (a < b) { document.querySelector("input"); }\n</script>\n<button id="real">y</button>`,
    );
    expect(out).toEqual([{ element: "button", event: "click", handler: "real", line: 5 }]);
  });
});
