import { describe, expect, it } from "vitest";
import { joinRootedPath, joinRoutePath, joinTrimmedPath } from "./route-paths.js";

/** Inputs the plugins' own route tests and callers feed their joins (Club/Player/Match names are invented). */
const PAIRS: Array<[string, string]> = [
  ["", ""], ["", "/"], ["/", ""], ["/", "/"], ["", "/clubs"], ["", "clubs"], ["/api", "/clubs"], ["/api/", "clubs"],
  ["api", "clubs"], ["/api//", "//clubs//"], ["/api", ""], ["/api", "/"], ["/api/v2", "/clubs/{id}"], ["/a//b", "c"],
  ["/league", "players/:id/"], ["//", "x"], ["/api/", "/"], ["clubs", "/{club}/matches"],
];

/** The bodies the plugins carried before they were merged, kept here as the reference. */
const legacy = {
  ktor: (prefixes: string[], path: string | null) =>
    "/" + [...prefixes, path ?? ""].map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/"),
  symfony: (prefix: string, path: string) => "/" + (prefix + "/" + path).split("/").filter(Boolean).join("/"),
  grape: (...parts: Array<string | undefined>) => "/" + parts.flatMap((p) => (p ?? "").split("/")).filter(Boolean).join("/"),
  crystal: (prefix: string, path: string) => {
    const joined = `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    return joined.length > 1 ? joined.replace(/\/+$/, "") : "/";
  },
  powershell: (prefix: string, path: string) => {
    const joined = (prefix.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "")).replace(/\/+$/, "");
    return joined === "" ? "/" : joined;
  },
  rust: (prefix: string, path: string) => (prefix + "/" + path).replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/",
  ocaml: (prefix: string, path: string) => {
    if (!prefix) return path;
    const joined = `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    return joined.length > 1 ? joined.replace(/\/+$/, "") : "/";
  },
};

describe("joinRoutePath", () => {
  it.each([
    ["/api", "/x", "/api/x"],
    ["/seller", "product-list", "/seller/product-list"],
    ["/api/", "/", "/api"],
    ["", "", "/"],
    ["", "x", "x"],
    ["/api//", "//x", "/api/x"],
  ])("%s + %s", (prefix, path, expected) => expect(joinRoutePath(prefix, path)).toBe(expected));
});

describe("joinRootedPath", () => {
  it("is always rooted and never ends in a slash", () => {
    expect(joinRootedPath([])).toBe("/");
    expect(joinRootedPath(["/"])).toBe("/");
    expect(joinRootedPath(["/api/", undefined, "clubs/"])).toBe("/api/clubs");
  });
  it("keeps an inner double slash only when collapse is off", () => {
    expect(joinRootedPath(["/a//b", "c"])).toBe("/a/b/c");
    expect(joinRootedPath(["/a//b", "c"], { collapse: false })).toBe("/a//b/c");
  });
  it.each(PAIRS)("matches the Symfony, Grape and Ktor readers on %j + %j", (prefix, path) => {
    expect(joinRootedPath([prefix, path])).toBe(legacy.symfony(prefix, path));
    expect(joinRootedPath([prefix, path])).toBe(legacy.grape(prefix, path));
    expect(joinRootedPath([prefix, path], { collapse: false })).toBe(legacy.ktor([prefix], path));
  });
});

describe("joinTrimmedPath", () => {
  it.each(PAIRS)("matches the Crystal, PowerShell, Rust and OCaml readers on %j + %j", (prefix, path) => {
    expect(joinTrimmedPath(prefix, path)).toBe(legacy.crystal(prefix, path));
    expect(joinTrimmedPath(prefix, path)).toBe(legacy.powershell(prefix, path));
    expect(joinTrimmedPath(prefix, path, { collapse: true })).toBe(legacy.rust(prefix, path));
    expect(joinTrimmedPath(prefix, path, { prefixOptional: true })).toBe(legacy.ocaml(prefix, path));
  });
  it("does not root a bare prefix", () => expect(joinTrimmedPath("api", "x")).toBe("api/x"));
  it("returns the path as written without a prefix when asked", () => {
    expect(joinTrimmedPath("", "clubs", { prefixOptional: true })).toBe("clubs");
    expect(joinTrimmedPath("", "clubs")).toBe("/clubs");
  });
});
