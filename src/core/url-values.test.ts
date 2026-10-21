import { describe, it, expect } from "vitest";
import { isLoopbackHost, parseAddress, urlValue } from "./url-values.js";

describe("urlValue", () => {
  it("keeps addresses and strips the credentials an address carries", () => {
    expect(urlValue("http://cars:8080")).toBe("http://cars:8080");
    expect(urlValue("HTTPS://svc:s3cret@api.partner.com/v1")).toBe("https://api.partner.com/v1");
    expect(urlValue("fleet:8080")).toBe("fleet:8080");
  });

  it("drops what is not an address — connection strings, keys, templates", () => {
    expect(urlValue("Host=db;Username=app;Password=hunter2")).toBeNull();
    expect(urlValue("sk_live_abc123")).toBeNull();
    expect(urlValue("http://${HOST}:8080")).toBeNull();
    expect(urlValue("")).toBeNull();
  });
});

describe("parseAddress", () => {
  it("reads host, port (scheme default when absent) and path", () => {
    expect(parseAddress("http://Cars:8080/api/")).toEqual({ host: "cars", port: 8080, path: "/api", scheme: "http" });
    expect(parseAddress("https://api.stripe.com")).toEqual({ host: "api.stripe.com", port: 443, path: "", scheme: "https" });
    expect(parseAddress("fleet:5102")).toEqual({ host: "fleet", port: 5102, path: "" });
  });

  it("ends the host where a runtime part starts, and names none for a runtime host", () => {
    expect(parseAddress("https://api.garage.example{$endpoint}")?.host).toBe("api.garage.example");
    expect(parseAddress("https://api.garage.example${path}")?.host).toBe("api.garage.example");
    expect(parseAddress("https://${host}/cars")).toBeNull();
  });

  it("knows the machine itself", () => {
    for (const h of ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "+", "*"]) expect(isLoopbackHost(h), h).toBe(true);
    expect(isLoopbackHost("cars")).toBe(false);
  });
});
