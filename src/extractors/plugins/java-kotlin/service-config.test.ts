import { describe, it, expect } from "vitest";
import { jvmServiceConfig } from "./service-config.js";

/** Every entry the Spring config files at one root state, as core hands them to `routeBaseOf`. */
function entriesOf(files: Record<string, string>) {
  const src = jvmServiceConfig.sources![0]!;
  return Object.entries(files).flatMap(([path, text]) => src.parse(text, path).map((e) => ({ ...e, file: path })));
}
const baseOf = (files: Record<string, string>) => jvmServiceConfig.routeBaseOf!(entriesOf(files));

describe("Spring route base", () => {
  it("reads server.servlet.context-path, its line and file", () => {
    expect(baseOf({ "src/main/resources/application.yml": "server:\n  port: 8085\n  servlet:\n    context-path: /league/\n" })).toEqual({
      path: "/league",
      key: "server.servlet.context-path",
      file: "src/main/resources/application.yml",
      line: 4,
    });
  });

  it("joins the DispatcherServlet path inside the context path, in .properties too", () => {
    const base = baseOf({ "src/main/resources/application.properties": "server.servlet.contextPath=/league\nspring.mvc.servlet.path=/api\n" });
    expect(base?.path).toBe("/league/api");
  });

  it("reads Boot 1.x server.context-path and WebFlux's base path", () => {
    expect(baseOf({ "application.properties": "server.context-path=/garage" })?.path).toBe("/garage");
    expect(baseOf({ "application.yml": "spring:\n  webflux:\n    base-path: /garage\n" })?.path).toBe("/garage");
  });

  it("takes a placeholder's default, never a profile's value", () => {
    expect(baseOf({
      "src/main/resources/application.yml": "server:\n  servlet:\n    context-path: ${CONTEXT_PATH:/league}\n",
      "src/main/resources/application-dev.yml": "server:\n  servlet:\n    context-path: /dev-league\n",
    })?.path).toBe("/league");
    // A profile document inside the main file is a profile too.
    expect(baseOf({ "application.yml": "server:\n  port: 1\n---\nspring:\n  config:\n    activate:\n      on-profile: cloud\nserver:\n  servlet:\n    context-path: /cloud\n" })).toBeNull();
  });

  it("states no base for the root, an unknown value or files that disagree", () => {
    expect(baseOf({ "application.yml": "server:\n  servlet:\n    context-path: /\n" })).toBeNull();
    expect(baseOf({ "application.yml": "server:\n  servlet:\n    context-path: ${CONTEXT_PATH}\n" })).toBeNull();
    expect(baseOf({ "application.yml": "server.servlet.context-path: /a\n", "config/application.yml": "server.servlet.context-path: /b\n" })).toBeNull();
  });
});
