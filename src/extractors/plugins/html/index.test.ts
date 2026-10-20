import { describe, it, expect } from "vitest";
import { htmlSpec, pageRoutePath, htmlPreprocess } from "./index.js";

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
    // A Vite page loads its TS entry straight from source.
    expect(src(`<script type="module" src="/src/main.ts"></script>`)).toBe("/src/main.ts");
    expect(src(`<script type="module" src="/src/standalone.tsx"></script>`)).toBe("/src/standalone.tsx");
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
      { element: "button", event: "click", handler: "log", line: 3, caption: "LOGIN" }, // submit input → button
      { element: "button", event: "click", handler: "showbtn", line: 4, caption: "SHOW" },
    ]);
  });

  it("does NOT read attributes merely containing 'on' as events (content= matched as ontent)", () => {
    const out = els(`<meta name="google" content="notranslate">
<a href="#" data-context="x">y</a>`);
    expect(out).toEqual([]);
  });

  it("resolves an inline on*= handler to its invoked function", () => {
    const out = els(`<button onclick="addToCart(3)">Add</button>`);
    expect(out[0]).toEqual({ element: "button", event: "onclick", handler: "addToCart", line: 1, caption: "Add" });
  });

  it("emits a non-control tag only when it carries an inline handler, and every <a href> as a click", () => {
    const out = els(`<a href="x.html">plain</a>\n<a href="#" onclick="logout()">Logout</a>\n<a href="#top">up</a>\n<a href="javascript:void(0)">x</a>\n<span>no</span>`);
    expect(out).toEqual([
      { element: "link", event: "click", handler: null, line: 1, caption: "plain" }, // a page: navigation, no request
      { element: "link", event: "onclick", handler: "logout", line: 2, caption: "Logout" },
    ]);
  });

  it("names a link to an app route after its GET, base-path template dropped", () => {
    const out = els(`<a class="cymbal-button-primary" href="{{ $.baseUrl }}/" role="button">Continue</a>\n<a href="{{ $.baseUrl }}/product/{{.Item.Id}}">\n  <img src="{{.Item.Picture}}">\n</a>\n<a href="/logo.png">x</a>\n<a data-href="/x" href="https://example.com/docs">ext</a>`);
    expect(out).toEqual([
      { element: "link", event: "click", handler: "root", line: 1, caption: "Continue", request: { method: "GET", target: "/" } },
      // an image, no text: no caption
      { element: "link", event: "click", handler: "product_x", line: 2, request: { method: "GET", target: "/product/:param" } },
      { element: "link", event: "click", handler: null, line: 5, caption: "x" },
      { element: "link", event: "click", handler: null, line: 6, caption: "ext" },
    ]);
  });

  it("gives a submit button its form's action and method (cart.html)", () => {
    const out = els(`<form method="POST" action="{{ $.baseUrl }}/cart/empty">
  <button class="cart-summary-empty-cart-button" type="submit">
    Empty Cart
  </button>
  <a class="cymbal-button-primary" href="{{ $.baseUrl }}/" role="button">Continue</a>
</form>
<form class="cart-checkout-form"
      action="{{ $.baseUrl }}/cart/checkout" method="POST">
  <input type="email" id="email">
  <button class="cymbal-button-primary" type="submit">Place Order</button>
</form>
<button type="button" id="toggle">x</button>`);
    expect(out).toEqual([
      { element: "form", event: "submit", handler: "post_cart_empty", line: 1, request: { method: "POST", target: "/cart/empty" } },
      { element: "button", event: "click", handler: "post_cart_empty", line: 2, caption: "Empty Cart", request: { method: "POST", target: "/cart/empty" } },
      { element: "link", event: "click", handler: "root", line: 5, caption: "Continue", request: { method: "GET", target: "/" } },
      // attributes wrapped onto the next line are still read
      { element: "form", event: "submit", handler: "post_cart_checkout", line: 7, request: { method: "POST", target: "/cart/checkout" } },
      { element: "input", event: "input", handler: "email", line: 9 },
      { element: "button", event: "click", handler: "post_cart_checkout", line: 10, caption: "Place Order", request: { method: "POST", target: "/cart/checkout" } },
      { element: "button", event: "click", handler: "toggle", line: 12, caption: "x" }, // outside the form, not a submit
    ]);
  });

  it("reads a typeless button as submit, formaction over the form's, and GET for a form with no method", () => {
    const out = els(`<form action="/search">
  <button>Go</button>
  <input type="submit" formaction="/orders/delete" formmethod="post" value="Delete">
  <button type="submit" onclick="check()">Check</button>
</form>
<form method="post"><button>Save</button></form>`);
    expect(out).toEqual([
      { element: "form", event: "submit", handler: "search", line: 1, request: { method: "GET", target: "/search" } },
      { element: "button", event: "click", handler: "search", line: 2, caption: "Go", request: { method: "GET", target: "/search" } },
      { element: "button", event: "click", handler: "post_orders_delete", line: 3, caption: "Delete", request: { method: "POST", target: "/orders/delete" } },
      { element: "button", event: "onclick", handler: "check", line: 4, caption: "Check" }, // its own handler runs first
      // no action: the page posts to itself, which names no route
      { element: "form", event: "submit", handler: null, line: 6 },
      { element: "button", event: "click", handler: null, line: 6, caption: "Save" },
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
    expect(out).toEqual([{ element: "button", event: "click", handler: "real", line: 5, caption: "y" }]);
  });
});

describe("apiDocGeneratorOf / htmlPreprocess", () => {
  it("skips DocInsight pages (meta name-then-content)", () => {
    const page = `<!DOCTYPE html>\n<html><head>\n<meta name="generator" content="DocInsight" />\n<title>ZXing.Reader Unit</title></head><body></body></html>`;
    expect(htmlPreprocess(page)).toEqual({ skip: "generated API documentation (DocInsight)" });
  });

  it("skips Doxygen pages regardless of attribute order and version suffix", () => {
    const page = `<html><head><meta content="Doxygen 1.9.8" name="generator"><title>Class X</title></head></html>`;
    expect(htmlPreprocess(page)).not.toBeNull();
  });

  it("skips javadoc pages (comment stamp, no meta)", () => {
    const page = `<!DOCTYPE HTML>\n<!-- Generated by javadoc (17) on Mon Mar 06 2023 -->\n<html><head><title>Foo (api)</title></head></html>`;
    expect(htmlPreprocess(page)).toEqual({ skip: "generated API documentation (javadoc)" });
  });

  it("keeps hand-written pages and SITE-generator output (Hugo)", () => {
    expect(htmlPreprocess(`<html><head><title>Shop</title></head><body><a href="cart.html">Cart</a></body></html>`)).toBeNull();
    expect(htmlPreprocess(`<html><head><meta name="generator" content="Hugo 0.118.2"></head><body></body></html>`)).toBeNull();
  });

  it("ignores generator strings outside the head window", () => {
    const page = `<html><head><title>x</title></head><body>${"a".repeat(5000)}<meta name="generator" content="Doxygen"></body></html>`;
    expect(htmlPreprocess(page)).toBeNull();
  });
});
