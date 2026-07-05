import { describe, it, expect } from "vitest";
import { blazorSpec } from "./index.js";

/**
 * Blazor `.razor` markup extraction. DevToys (a Blazor Hybrid desktop app, 73
 * `.razor` files) was 100% invisible to the engine — `.razor` was in no
 * extension allowlist, so screens/componentUsage/interactiveElements were all 0.
 * This spec is the UI-markup half (the C# logic lives in `.razor.cs`).
 */

const lines = (s: string) => s.split("\n");

describe("Blazor route extraction (@page)", () => {
  it("maps each @page directive to a frontend route", () => {
    const routes = blazorSpec.extractRoutes!(
      lines(`@page "/"\n@page "/counter"\n<h1>Hi</h1>`),
      [],
    );
    expect(routes.map((r) => r.path)).toEqual(["/", "/counter"]);
    expect(routes.every((r) => r.kind === "frontend" && r.httpMethod === null)).toBe(true);
  });

  it("returns no routes for a component file with no @page", () => {
    expect(blazorSpec.extractRoutes!(lines(`<div>@Title</div>`), [])).toEqual([]);
  });
});

describe("Blazor sub-component (componentUsage) extraction", () => {
  it("captures PascalCase tags as components and ignores native HTML + closing tags", () => {
    const subs = blazorSpec.extractSubComponents!(
      lines(`<Card Title="x">\n  <Stack>\n    <button>native</button>\n    <Button />\n  </Stack>\n</Card>`),
    );
    expect(subs.map((s) => s.name).sort()).toEqual(["Button", "Card", "Stack"]);
    // Blazor resolves components by namespace, not file path.
    expect(subs.every((s) => s.importSource === null)).toBe(true);
    expect(subs.find((s) => s.name === "Card")!.props).toContain("Title");
  });

  it("does NOT read C# generics inside a @code block as component tags", () => {
    const subs = blazorSpec.extractSubComponents!(
      lines(`<Stack />\n@code {\n  private Dictionary<String, Foo> _map = new();\n  private List<Bar> _items = [];\n}`),
    );
    expect(subs.map((s) => s.name)).toEqual(["Stack"]);
  });

  it("ignores tags inside a @* … *@ comment", () => {
    const subs = blazorSpec.extractSubComponents!(
      lines(`@* <Ghost /> *@\n<Real />`),
    );
    expect(subs.map((s) => s.name)).toEqual(["Real"]);
  });
});

describe("Blazor interactive-element extraction", () => {
  it("captures @onclick on a native button (handler resolved)", () => {
    const els = blazorSpec.extractInteractiveElements!(
      lines(`<button @onclick="IncrementCount">Click</button>`),
    );
    expect(els).toEqual([
      { element: "button", event: "onclick", handler: "IncrementCount", line: 1 },
    ]);
  });

  it("tags @onclick on a component as a custom element", () => {
    const els = blazorSpec.extractInteractiveElements!(
      lines(`<Button @onclick="OnGreet">Greet</Button>`),
    );
    expect(els[0]).toMatchObject({ element: "custom", event: "onclick", handler: "OnGreet" });
  });

  it("captures @bind as an input element bound to a field", () => {
    const els = blazorSpec.extractInteractiveElements!(
      lines(`<input @bind="stepText" />`),
    );
    expect(els[0]).toMatchObject({ element: "input", event: "bind", handler: "stepText" });
  });

  it("resolves a lambda handler to its invoked method, else null", () => {
    const els = blazorSpec.extractInteractiveElements!(
      lines(`<button @onclick="() => Close(item)">x</button>\n<button @onclick="@(() => { })">y</button>`),
    );
    expect(els[0]!.handler).toBe("Close");
    expect(els[1]!.handler).toBe(null);
  });
});

describe("Blazor imports (@using)", () => {
  it("extracts @using namespaces", () => {
    const imp = blazorSpec.importPatterns[0]!;
    const m = `@using SampleBlazor.Components`.match(imp.pattern);
    expect(m && imp.getSource(m)).toBe("SampleBlazor.Components");
  });
});
