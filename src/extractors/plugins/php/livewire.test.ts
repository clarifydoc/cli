import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Livewire components: a Blade view's `wire:click` / `wire:submit` call the
 * methods of the component class that renders it — by the view its `render()`
 * names, or by Livewire's naming rule when it has no `render()`.
 */
const FILES: Record<string, string> = {
  "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0", "livewire/livewire": "^3.0" } }),
  "app/Models/Player.php": `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class Player extends Model { protected $table = 'players'; }
`,
  "app/Livewire/SquadList.php": `<?php
namespace App\\Livewire;
use Livewire\\Component;
use App\\Models\\Player;
class SquadList extends Component
{
    public $search = '';
    public function releasePlayer($id) { Player::find($id)->delete(); }
    public function signPlayer() { Player::create(['name' => 'x']); }
    public function updatedSearch() { Player::where('name', $this->search)->get(); }
    public function render() { return view('livewire.squad-list', ['players' => Player::all()]); }
}
`,
  "resources/views/livewire/squad-list.blade.php": `<div>
  <input type="text" wire:model.live="search">
  @foreach ($players as $player)
    <button wire:click="releasePlayer({{ $player->id }})">Release</button>
    <button wire:click="$refresh">Reload</button>
  @endforeach
  <form wire:submit="signPlayer"><button type="submit">Sign</button></form>
</div>
`,
  "app/Livewire/Garage/CarPark.php": `<?php
namespace App\\Livewire\\Garage;
use Livewire\\Component;
class CarPark extends Component
{
    public function parkCar() { }
}
`,
  "resources/views/livewire/garage/car-park.blade.php": `<div><button wire:click.prevent="parkCar">Park</button></div>
`,
};

describe("Livewire views and their component classes", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-livewire-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linksFrom = (view: string) => (summary.symbolLinks ?? [])
    .filter((l) => l.sourceFile === view)
    .map((l) => `${l.sourceSymbol}:${l.sourceLine} -> ${l.targetFile}::${l.targetSymbol}`).sort();

  it("links each wire action to the method of the component whose render() names the view", () => {
    expect(linksFrom("resources/views/livewire/squad-list.blade.php")).toEqual([
      "<component>:1 -> app/Livewire/SquadList.php::SquadList.render",
      "<component>:2 -> app/Livewire/SquadList.php::SquadList.updatedSearch",
      "<component>:4 -> app/Livewire/SquadList.php::SquadList.releasePlayer",
      "<component>:7 -> app/Livewire/SquadList.php::SquadList.signPlayer",
    ]);
  });

  it("joins a component without render() to its view by Livewire's naming rule", () => {
    expect(linksFrom("resources/views/livewire/garage/car-park.blade.php")).toEqual([
      "<component>:1 -> app/Livewire/Garage/CarPark.php::CarPark.parkCar",
    ]);
  });

  it("gives the view's screen the data its component's methods change", () => {
    const flows = (summary.dataFlows ?? []).filter((f) => f.entryKind === "screen" && f.entryFile === "resources/views/livewire/squad-list.blade.php");
    expect(flows.map((f) => `${f.effect} ${f.resource}`)).toEqual(expect.arrayContaining(["db-write Player", "db-read Player"]));
  });
});
