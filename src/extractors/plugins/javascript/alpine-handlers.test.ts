import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Real-repo shape: Blade views carry Alpine.js `@click` handlers; each page loads
 * its component module through `@vite`, the module's factory returns the
 * component's methods and registers them with `Alpine.data`, and the shared
 * date-range menu sits in the layout every page extends.
 */
const FILES: Record<string, string> = {
  "composer.json": `{"require": {"laravel/framework": "^11.0"}}`,
  "resources/views/layout/session.blade.php": `<html>
<body>
  <x-layout.range />
  @yield('content')
  @yield('scripts')
</body>
</html>
`,
  "resources/views/components/layout/range.blade.php": `<ul x-data="dates">
  <li><a href="#" class="dropdown-item" @click="changeRange">next</a></li>
  <li><a href="#" class="dropdown-item" x-on:click.prevent="changeRange">prev</a></li>
</ul>
`,
  "resources/views/clubs/show.blade.php": `@extends('layout.session')
@section('content')
<div x-data="show">
  <button type="button" class="btn" @click="relegate(club.id)">Relegate</button>
  <input type="text" @keyup.enter="search">
  @include('partials.club-form')
</div>
@endsection
@section('scripts')
  @vite(['js/pages/clubs/show.js'])
@endsection
`,
  "resources/views/clubs/edit.blade.php": `@extends('layout.session')
@section('content')
<div x-data="edit">
  @include('partials.club-form')
</div>
@endsection
@section('scripts')
  @vite(['js/pages/clubs/edit.js'])
@endsection
`,
  "resources/views/partials/club-form.blade.php": `<form>
  <button type="button" class="btn" @click="save">Save</button>
</form>
`,
  "resources/assets/js/pages/shared/dates.js": `export default {
  changeRange(e) {
    window.store.set("range", e.target.dataset.range);
  },
};
`,
  "resources/assets/js/pages/clubs/show.js": `import Alpine from "alpinejs";
import dates from "../shared/dates.js";

let show = function () {
  return {
    club: null,
    relegate(id) {
      return fetch("/api/v1/clubs/" + id + "/relegate", { method: "POST" });
    },
    search() {
      return fetch("/api/v1/clubs/search");
    },
    save() {
      return fetch("/api/v1/clubs", { method: "PUT" });
    },
  };
};

const comps = { show, dates };
Object.keys(comps).forEach((comp) => {
  let data = comps[comp]();
  Alpine.data(comp, () => data);
});
`,
  "resources/assets/js/pages/clubs/edit.js": `import Alpine from "alpinejs";
import dates from "../shared/dates.js";

let edit = function () {
  return {
    save() {
      return fetch("/api/v1/clubs", { method: "PUT" });
    },
  };
};

const comps = { edit, dates };
Object.keys(comps).forEach((comp) => {
  let data = comps[comp]();
  Alpine.data(comp, () => data);
});
`,
};

describe("Alpine.js handlers in Blade views", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-alpine-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linksFrom = (file: string) =>
    summary.symbolLinks
      .filter((l) => l.sourceFile === `resources/views/${file}` && l.sourceSymbol === "<component>")
      .map((l) => `${l.callName} -> ${l.targetFile.replace("resources/assets/js/pages/", "")}::${l.targetSymbol}`)
      .sort();

  it("reads @click / x-on: directives as inline handlers", () => {
    const handlers = (summary.interactiveElements ?? [])
      .filter((e) => e.filePath === "resources/views/clubs/show.blade.php" && e.event.startsWith("on"))
      .map((e) => `${e.event} ${e.handler}`);
    expect(handlers).toEqual(["onclick relegate", "onkeyup search"]);
  });

  it("links a view's handlers to the members of the component its @vite module builds", () => {
    expect(linksFrom("clubs/show.blade.php")).toEqual(["relegate -> clubs/show.js::show.relegate", "search -> clubs/show.js::show.search"]);
  });

  it("links a partial's handler through each page that includes it", () => {
    expect(linksFrom("partials/club-form.blade.php")).toEqual(["save -> clubs/edit.js::edit.save", "save -> clubs/show.js::show.save"]);
  });

  it("links a layout component's handler through the module every page imports", () => {
    expect(linksFrom("components/layout/range.blade.php")).toEqual(["changeRange -> shared/dates.js::changeRange"]);
  });
});
