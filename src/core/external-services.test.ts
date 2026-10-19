import { describe, expect, it } from "vitest";
import { externalServices, serviceForHost } from "./external-services.js";

describe("serviceForHost", () => {
  it("names a known host, a subdomain of a known suffix, and nothing else", () => {
    expect(serviceForHost("api.stripe.com")).toBe("Stripe");
    expect(serviceForHost("API.SendGrid.com:443")).toBe("SendGrid");
    expect(serviceForHost("dev-123.okta.com")).toBe("Okta");
    expect(serviceForHost("maps.googleapis.com")).toBe("Google Maps");
    expect(serviceForHost("people.googleapis.com")).toBe("Google APIs");
    expect(serviceForHost("notstripe.com")).toBeUndefined();
    expect(serviceForHost("stripe.com.evil.test")).toBeUndefined();
  });
});

describe("externalServices", () => {
  const call = (filePath: string, host: string, service?: string) => ({ kind: "api-call", name: "get", target: `https://${host}/x`, calls: [], filePath, origin: { host, external: true, ...(service ? { service } : {}), confidence: "EXTRACTED", evidence: [] } }) as never;

  it("groups calls by service, known services first, and leaves internal calls out", () => {
    const got = externalServices([
      call("a.ts", "api.stripe.com", "Stripe"),
      call("b.ts", "files.stripe.com", "Stripe"),
      call("a.ts", "weather.test"),
      { kind: "api-call", name: "get", target: "/api/x", calls: [], filePath: "c.ts" } as never,
    ]);
    expect(got).toEqual([
      { name: "Stripe", known: true, hosts: ["api.stripe.com", "files.stripe.com"], calls: 2, files: ["a.ts", "b.ts"] },
      { name: "weather.test", known: false, hosts: ["weather.test"], calls: 1, files: ["a.ts"] },
    ]);
  });
});
