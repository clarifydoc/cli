import { describe, it, expect } from "vitest";
import { scanRequestAccess } from "./request-access.js";

describe("JS request access", () => {
  it("reads a header through the Fetch Headers API, Express's req.get and the headers object", () => {
    const src = `const sig = request.headers.get("stripe-signature"); const has = request.headers.has("x-id");
const t = req.get("x-token"); const a = req.headers.authorization;`;
    expect(scanRequestAccess(src, "request").map((p) => `${p.binding}:${p.name}`)).toEqual(["header:stripe-signature"]);
    expect(scanRequestAccess(src, "req").map((p) => `${p.binding}:${p.name}`)).toEqual(["header:x-token", "header:authorization"]);
  });
});
