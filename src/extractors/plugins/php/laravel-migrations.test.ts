import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A Laravel schema built by migrations (real-repo FP: 80 `Schema::create` tables gave 52 entities,
 * columns only from `$fillable` and untyped, and every migration's methods were dropped).
 */
const FILES: Record<string, string> = {
  "composer.json": JSON.stringify({ require: { "laravel/framework": "^10.0" } }),
  "database/migrations/2024_01_01_000000_create_leagues_table.php": `<?php
use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('leagues', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->timestamps();
        });
        Schema::create('clubs', function (Blueprint $table) {
            $table->id();
            $table->foreignId('league_id')->constrained();
            $table->string('crest')->nullable();
        });
        $this->createFailedTransfers();
    }

    private function createFailedTransfers(): void
    {
        Schema::create('failed_transfers', static function (Blueprint $table): void {
            $table->id();
            $table->text('payload');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('clubs');
        Schema::dropIfExists('leagues');
    }
};
`,
  "database/migrations/2024_02_01_000000_alter_clubs_table.php": `<?php
return new class extends Migration {
    public function up(): void
    {
        Schema::table('clubs', function (Blueprint $table) {
            $table->dropColumn('crest');
            $table->integer('founded');
        });
    }
};
`,
  "app/Models/Club.php": `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class Club extends Model {
    protected $fillable = ['name'];
    public function league() { return $this->belongsTo(League::class); }
}
`,
  "app/Models/League.php": `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class League extends Model {
    public function clubs() { return $this->hasMany(Club::class); }
}
`,
};

describe("Laravel migrations", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-laravel-migrations-"));
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

  it("replay into the schema the last migration leaves, a model taking its table's typed columns", () => {
    const nodes = (summary.entityGraph?.nodes ?? []).map((n) => `${n.name} ${n.columns.map((c) => `${c.name}:${c.type ?? "?"}`).join(",")}`).sort();
    expect(nodes).toEqual([
      "Club name:?,id:bigIncrements,league_id:foreignId,founded:integer",
      "League id:bigIncrements,name:string,created_at:timestamp,updated_at:timestamp",
      "failed_transfers id:bigIncrements,payload:text",
    ]);
  });

  it("keeps an anonymous migration class's methods", async () => {
    const { readFileSync } = await import("fs");
    const file = JSON.parse(readFileSync(join(dir, "out", "database/migrations/2024_01_01_000000_create_leagues_table.php.json"), "utf8"));
    const anon = file.classes.find((c: { name: string }) => c.name === "class@anonymous");
    expect([anon?.extends, anon?.methods.map((m: { name: string }) => m.name)]).toEqual(["Migration", ["up", "createFailedTransfers", "down"]]);
  });
});
