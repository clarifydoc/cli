import { describe, it, expect } from "vitest";
import { blazorSpec } from "./index.js";
import type { FileAnalysis } from "../../../types/analysis.js";

/**
 * Blazor `.razor` markup extraction. A Blazor Hybrid desktop app (73
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

  it("captures a component's callback parameter, never an HTML attribute of that name", () => {
    const els = blazorSpec.extractInteractiveElements!(
      lines(`<EditForm EditContext="@editContext" FormName="transfer" OnValidSubmit="@SubmitTransferAsync" Enhance>
<FluentButton OnClick="Cancel">x</FluentButton>
<div OnClick="Ignored"></div>`),
    );
    expect(els).toEqual([
      { element: "form", event: "onvalidsubmit", handler: "SubmitTransferAsync", line: 1 },
      { element: "custom", event: "onclick", handler: "Cancel", line: 2 },
    ]);
  });
});

describe("Blazor events in less usual spellings", () => {
  it("reads an unquoted handler", () => {
    const els = blazorSpec.extractInteractiveElements!(lines(`<button @onclick=OnRepairAsync>Repair</button>\n<div @onmousedown=@OnDrag></div>`));
    expect(els.map((e) => `${e.event} ${e.handler}`)).toEqual(["onclick OnRepairAsync", "onmousedown OnDrag"]);
  });

  it("reads the markup a @code block renders, and nothing of its C#", () => {
    const src = `<Garage />
@code {
    private RenderFragment<bool> Toolbar { get; set; } = default!;

    protected override void OnInitialized()
    {
        Toolbar = (bool wide) => (__builder) =>
        {
            <Button IsVisible="@CanRepair"
                    Appearance="Stealth"
                    @onclick="@OnRepair">
                <TextBlock Text="Repair" />
            </Button>
            <tr @onclick="@(() => OnCarClick(car))"></tr>
        };
        var cars = new List<Car>();
    }
}`;
    const els = blazorSpec.extractInteractiveElements!(lines(src));
    expect(els.map((e) => `${e.line} ${e.element} ${e.handler}`)).toEqual(["11 custom OnRepair", "14 custom OnCarClick"]);
  });
});

describe("Blazor imports (@using)", () => {
  it("extracts @using namespaces", () => {
    const imp = blazorSpec.importPatterns[0]!;
    const m = `@using SampleBlazor.Components`.match(imp.pattern);
    expect(m && imp.getSource(m)).toBe("SampleBlazor.Components");
  });
});

describe("Blazor page attribute layer (auth + params)", () => {
  const PAGE = `@page "/cars/{id:int}"
@page "/cars/{id:int}/{slug?}"
@attribute [Authorize(Roles = "Admin, Editor", Policy = "CanView")]
@using SampleBlazor.Components

<Card Title="Car">@Id</Card>

@code {
    [Parameter] public int Id { get; set; }
    [Parameter] public string? Slug { get; set; }

    [SupplyParameterFromQuery]
    public string? Q { get; set; }

    [SupplyParameterFromQuery(Name = "page")]
    public int? PageNumber { get; set; }

    private string _notAParam = "x";
}`;
  const routes = blazorSpec.extractRoutes!(lines(PAGE), []);

  it("reads @attribute [Authorize(…)] as the page's own guards on every @page route", () => {
    expect(routes).toHaveLength(2);
    for (const r of routes) {
      expect(r.middleware).toEqual(['Authorize(Roles = "Admin, Editor", Policy = "CanView")']);
      expect(r.auth).toEqual({
        policies: ["CanView"], roles: ["Admin", "Editor"], schemes: [], anonymous: false, inherited: false,
      });
    }
  });

  it("types route tokens by constraint, else by the matching [Parameter] property", () => {
    expect(routes[0]!.params).toEqual([
      { name: "id", type: "int", binding: "route" },
      { name: "Q", type: "string?", binding: "query" },
      { name: "page", type: "int?", binding: "query" },
    ]);
    expect(routes[1]!.params![1]).toEqual({ name: "slug", type: "string?", binding: "route" });
  });

  it("reads [SupplyParameterFromQuery] properties from the @code block before it is blanked", () => {
    const names = routes[0]!.params!.filter((p) => p.binding === "query").map((p) => p.name);
    expect(names).toEqual(["Q", "page"]);
    expect(routes[0]!.params!.some((p) => p.name === "_notAParam")).toBe(false);
  });

  it("reads [AllowAnonymous] as anonymous and a bare [Authorize] as an empty guard", () => {
    const anon = blazorSpec.extractRoutes!(lines(`@page "/login"\n@attribute [AllowAnonymous]`), []);
    expect(anon[0]!.auth).toMatchObject({ anonymous: true, inherited: false });
    const bare = blazorSpec.extractRoutes!(lines(`@page "/secure"\n@attribute [Authorize]`), []);
    expect(bare[0]!.auth).toEqual({ policies: [], roles: [], schemes: [], anonymous: false, inherited: false });
    expect(bare[0]!.middleware).toEqual(["Authorize"]);
  });

  it("leaves auth and params absent on a page that declares neither", () => {
    const plain = blazorSpec.extractRoutes!(lines(`@page "/counter"\n<h1>Hi</h1>`), []);
    expect(plain[0]!.auth).toBeUndefined();
    expect(plain[0]!.params).toBeUndefined();
    expect(plain[0]!.middleware).toEqual([]);
  });

  it("never marks a page-declared binding as inferred", () => {
    expect(routes.flatMap((r) => r.params ?? []).some((p) => p.inferred)).toBe(false);
  });
});

describe("Blazor @code methods", () => {
  it("declares the component's own methods, typed through its @inject services", async () => {
    const { extractWithRegex } = await import("../../../core/regex-extractor.js");
    const src = `@page "/item/{itemId:int}"
@inject BasketState Basket
@inject NavigationManager Nav

<form method="post" @onsubmit="AddToGarageAsync">
  <button type="submit">Add</button>
</form>

@code {
    [Parameter] public int ItemId { get; set; }
    private CatalogItem? item;

    protected override async Task OnInitializedAsync()
    {
        item = await CatalogService.GetCatalogItem(ItemId);
    }

    private async Task AddToGarageAsync()
    {
        if (item is null) return;
        await Basket.AddAsync(item);
        Nav.NavigateTo("garage");
    }

    private string Label(int n) => $"{n} items";

    private int PendingCount(int playerId, int count)
        => PendingId == playerId
        ? PendingValue
        : count;

    private void Reset() { list.ForEach(x => x.Clear()); }
}`;
    const a = extractWithRegex(src, "src/WebApp/Components/Pages/Item/ItemPage.razor", "blazor");
    expect(a.functions.map((f) => `${f.name}@${f.line}-${f.endLine}`)).toEqual([
      "OnInitializedAsync@13-16",
      "AddToGarageAsync@18-23",
      "Label@25-25",
      "PendingCount@27-30",
      "Reset@32-32",
    ]);
    const add = a.functions.find((f) => f.name === "AddToGarageAsync")!;
    expect(add.calls.map((c) => c.name)).toEqual(expect.arrayContaining(["Basket.AddAsync", "Nav.NavigateTo"]));
    expect(add.localTypes).toEqual([{ name: "Basket", type: "BasketState" }, { name: "Nav", type: "NavigationManager" }]);
    expect(a.interactiveElements.find((e) => e.event === "onsubmit")?.handler).toBe("AddToGarageAsync");
  });
});

describe("Blazor component type (@inherits / @implements)", () => {
  it("declares the component as a class named after the file, extending its @inherits base", async () => {
    const { extractWithRegex } = await import("../../../core/regex-extractor.js");
    const src = `@page "/clubs"\n@inherits ClubPageBase\n@implements IDisposable\n@implements IAsyncDisposable\n<button @onclick="SaveClub">Save</button>`;
    const a = extractWithRegex(src, "Pages/ClubPage.razor", "blazor");
    expect(a.classes.map((c) => [c.name, c.extends, c.implements])).toEqual([["ClubPage", "ClubPageBase", ["IDisposable", "IAsyncDisposable"]]]);
  });

  it("keeps a generic base as written", async () => {
    const { extractWithRegex } = await import("../../../core/regex-extractor.js");
    const a = extractWithRegex(`@inherits OwningComponentBase<GarageService>\n<p>x</p>`, "Pages/GarageView.razor", "blazor");
    expect(a.classes[0]?.extends).toBe("OwningComponentBase<GarageService>");
  });

  it("declares nothing when the markup states no type (the .razor.cs partial owns it)", async () => {
    const { extractWithRegex } = await import("../../../core/regex-extractor.js");
    const a = extractWithRegex(`@page "/garage"\n<button @onclick="ParkCar">Park</button>`, "Pages/Garage.razor", "blazor");
    expect(a.classes).toEqual([]);
  });

  it("links a click to the method the base class declares", async () => {
    const { extractWithRegex } = await import("../../../core/regex-extractor.js");
    const { buildSymbolLinks } = await import("../../../core/symbol-linker.js");
    const page = extractWithRegex(`@page "/clubs"\n@inherits ClubPageBase\n<button @onclick="SaveClub">Save</button>\n<button @onclick="Close">Close</button>\n@code { void Close() { } }`, "Pages/ClubPage.razor", "blazor");
    page.projectId = "root";
    const base = {
      filePath: "Pages/ClubPageBase.cs", language: "csharp", projectId: "root", imports: [], exports: [], functions: [], routes: [], dataSources: [],
      classes: [{ name: "ClubPageBase", kind: "class", extends: "ComponentBase", implements: [], decorators: [], properties: [], isExported: true, line: 1, endLine: 9,
        methods: [{ name: "SaveClub", line: 5, endLine: 5, params: [], calls: [], returnType: null, isAsync: true, isExported: false, decorators: [] }] }],
    } as unknown as FileAnalysis;
    const links = buildSymbolLinks([page, base]).filter((l) => l.sourceSymbol === "<component>");
    expect(links.map((l) => [l.callName, l.targetFile, l.targetSymbol, l.strategy])).toEqual([["SaveClub", "Pages/ClubPageBase.cs", "ClubPageBase.SaveClub", "inheritance"]]);
  });
});
