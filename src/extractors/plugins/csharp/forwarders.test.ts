import { describe, it, expect } from "vitest";
import { yarpForwarders } from "./forwarders.js";

describe("yarpForwarders", () => {
  it("reads app.MapForwarder as a forwarding rule from the pattern's literal prefix", () => {
    const src = `var app = builder.Build();
app.MapForwarder("/api/v2/cars/{**catch-all}", "http://cars-service:8080");
app.MapForwarder("/garages/{id}", "http://garages:5000", ForwarderRequestConfig.Empty);
app.MapForwarder("/local", configuration["Upstream"]);`;
    expect(yarpForwarders(src, "gateway/Program.cs")).toEqual([
      { pathPrefix: "/api/v2/cars", target: "http://cars-service:8080", via: "yarp", file: "gateway/Program.cs", line: 2 },
      { pathPrefix: "/garages", target: "http://garages:5000", via: "yarp", file: "gateway/Program.cs", line: 3 },
    ]);
  });
});
