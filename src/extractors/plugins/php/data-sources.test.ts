import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PhpDataSourceExtractor } from "./data-sources.js";
import type { DataSourceInfo } from "../../../types/analysis.js";

/**
 * CodeIgniter Query Builder data access. The PHP extractor emitted entity-less
 * `database` sources for `$this->db->...`, which `attributeDataAccessToSymbols`
 * drops — so the whole CI data tier was invisible in Call Traces (photo-booth:
 * symbolDataAccess was 5, all JS noise, for 1245 PHP files). Setting `entity`
 * from the table-carrying verb's argument is the fix.
 */
async function dbSourcesOf(body: string): Promise<DataSourceInfo[]> {
  const src = `<?php
class M extends CI_Model {
  function q() {
${body}
  }
}`;
  const tree = await parseSource(src, "php" as any, "M.php");
  return new PhpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database");
}

describe("CodeIgniter query-builder entity attribution", () => {
  it("resolves the table from get('table')/from('table') as the entity", async () => {
    const sources = await dbSourcesOf(`    return $this->db->get('cars');`);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.entity).toBe("cars");
    expect(sources[0]!.target).toBe("cars");
  });

  it("resolves the table at the base of a fluent chain (from is captured directly)", async () => {
    const sources = await dbSourcesOf(
      `    return $this->db->select('*')->from('car_rows')->where('id', 1)->get();`,
    );
    // `from('car_rows')` carries the table; select/where/get carry none.
    expect(sources.map((s) => s.entity)).toContain("car_rows");
    // No column-as-table junk from where('id', 1).
    expect(sources.every((s) => s.entity && /^[a-z_]+$/.test(s.entity))).toBe(true);
  });

  it("captures insert/update/delete/join tables, drops a table alias", async () => {
    const ins = await dbSourcesOf(`    $this->db->insert('drivers', $data);`);
    expect(ins[0]!.entity).toBe("drivers");
    const join = await dbSourcesOf(`    $this->db->from('cars o')->join('clients c', 'c.id = o.cid');`);
    expect(join.map((s) => s.entity).sort()).toEqual(["cars", "clients"]);
  });

  it("does not treat query refinement (where/select/order_by) as data sources", async () => {
    const sources = await dbSourcesOf(
      `    $this->db->where('cars.driver_id', 5);
    $this->db->select('cars.total');
    $this->db->order_by('cars.id');`,
    );
    expect(sources).toHaveLength(0);
  });
});

describe("PHP HTTP client calls", () => {
  async function httpOf(body: string): Promise<Array<[string, string | null]>> {
    const src = `<?php
class Api {
  function call($client, $endpoint) {
${body}
  }
}`;
    const tree = await parseSource(src, "php" as any, "Api.php");
    return new PhpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call").map((d) => [d.name, d.target]);
  }

  it("takes the verb and the URL from `request`/`send`, not the verb as the URL", async () => {
    expect(await httpOf(`    $r = $client->request('POST', $endpoint, $param);
    $s = $client->request('GET', '/api/players');
    $t = Http::send('PUT', '/api/x');`)).toEqual([
      ["POST", "{$endpoint}"],
      ["GET", "/api/players"],
      ["PUT", "/api/x"],
    ]);
  });

  it("reads a verb method's URL from its first argument only", async () => {
    expect(await httpOf(`    $client->get('auth', ['cookies' => $jar]);
    $client->post($url, 'body-text');`)).toEqual([
      ["$client->get", "auth"],
      ["$client->post", "{$url}"],
    ]);
  });
});

/**
 * Eloquent chains: one row per chain, at the outermost verb, and no column
 * name mistaken for a table. The model itself is joined project-wide
 * (`PhpEntityExtractor.reconcileProject`), so per file these rows carry no
 * entity yet.
 */
async function eloquentRowsOf(body: string): Promise<DataSourceInfo[]> {
  const src = `<?php
namespace App\\Http\\Controllers;
class R {
  function q(Player $player) {
${body}
  }
}`;
  const tree = await parseSource(src, "php" as any, "R.php");
  return new PhpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database");
}

describe("Eloquent chain rows", () => {
  it("emits one row for a fluent chain, at the terminal verb, with no column as target", async () => {
    const rows = await eloquentRowsOf(`    return $player->clubs()->where('name', $n)->where('id', '!=', 3)->first();`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("$player->clubs()->where('name', $n)->where('id', '!=', 3)->first");
    expect(rows[0]!.target).toBeNull();
    expect(rows[0]!.access).toBe("read");
  });

  it("folds a static root into its chain's one row and keeps a lone static as the row", async () => {
    const rows = await eloquentRowsOf(`    $a = Club::where('active', 1)->get();\n    $b = Club::find($id);\n    $c = Club::query()->onlyActive()->paginate();`);
    expect(rows.map((r) => r.name)).toEqual([
      "Club::where('active', 1)->get",
      "Club::find",
      "Club::query()->onlyActive()->paginate",
    ]);
    expect(rows[1]!.target).toBe("Club");
  });

  it("reads a PDO query's table from its SQL, once per chain", async () => {
    const rows = await eloquentRowsOf(`    $rows = $pdo->query('SELECT * FROM cars')->fetchAll();`);
    expect(rows.map((r) => [r.name, r.target, r.entity, r.access])).toEqual([["$pdo->query", "cars", "cars", "read"]]);
  });
});

describe("CodeIgniter raw SQL, library handles and verb-sharing calls", () => {
  it("names every table a `$this->db->query(…)` statement touches, literals concatenated", async () => {
    const rows = await dbSourcesOf(`    $this->db->query(" UPDATE laps l INNER JOIN driver_laps dl ON dl.lap_id = l.id SET l.valid = 0");
    $this->db->query("SELECT * FROM garages WHERE owner_id ='".$owner_id."' AND open = 1");
    $sql = "x"; $this->db->query($sql);
    $this->db->query(<<<SQL
DELETE FROM pit_stops WHERE race_id = {$race}
SQL);`);
    expect(rows.map((r) => [r.name, r.target, r.access, r.joined ?? false])).toEqual([
      ["$this->db->query", "laps", "write", false],
      ["$this->db->query", "driver_laps", "read", true],
      ["$this->db->query", "garages", "read", false],
      ["$this->db->query", "pit_stops", "write", false],
    ]);
  });

  it("reads a library's `get_instance()` handle as the query builder", async () => {
    const rows = await dbSourcesOf(`    $this->CI->db->delete('cart_rows');
    $query = $this->CI->db->where('active', 1)->get('mechanics');
    $CI =& get_instance(); $CI->db->insert('invoices', $row);
    get_instance()->db->truncate('sessions');`);
    expect(rows.map((r) => [r.target, r.access])).toEqual([
      ["cart_rows", "write"],
      ["mechanics", "read"],
      ["invoices", "write"],
      ["sessions", "write"],
    ]);
  });

  it("drops no-SQL text and verb-sharing calls in a file no model can be imported into", async () => {
    const rows = await dbSourcesOf(`    $page = $this->input->get('page');
    $writer->save($path);
    $this->price_model->get($id);
    $nodes = $xpath->query("//table/tr");
    $rows = $stmt->fetchAll();`);
    expect(rows.map((r) => r.name)).toEqual(["$stmt->fetchAll"]);
  });
});

describe("curl URLs from the file's constants", () => {
  it("reads a define()d or class constant base concatenated with a runtime path", async () => {
    const src = `<?php
define('FLEET_API_URL', "https://api.fleet.example");
// define('FLEET_API_URL', "https://staging.fleet.example");
class Fleet_api {
  const TOKEN_URL = 'https://auth.fleet.example/token';
  function call($endpoint, $query) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, FLEET_API_URL.$endpoint.'?'.http_build_query($query));
    curl_exec($ch);
    $t = curl_init(self::TOKEN_URL);
    curl_exec($t);
    $u = curl_init();
    curl_setopt($u, CURLOPT_URL, $endpoint);
    curl_exec($u);
  }
}`;
    const tree = await parseSource(src, "php" as any, "application/libraries/fleet_api.php");
    const calls = new PhpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call").map((d) => d.target);
    expect(calls).toEqual(["https://api.fleet.example{$endpoint}?{…}", "https://auth.fleet.example/token", null]);
  });
});

describe("CodeIgniter writes name their table", () => {
  it("records the table a query-builder write targets", async () => {
    const { PhpMutationExtractor } = await import("./data-mutations.js");
    const src = `<?php
class Cars_model extends CI_Model {
  function save($row) {
    $this->db->insert('cars', $row);
    $this->db->where('id', 1)->delete('pit_stops p');
    $this->CI->db->update($table, $row);
  }
}`;
    const tree = await parseSource(src, "php" as any, "application/models/cars_model.php");
    const targets = new PhpMutationExtractor().extract(tree, src).filter((m) => m.kind === "db-write").map((m) => m.target);
    expect(targets).toEqual(["cars", "pit_stops", "$this->CI->db->update"]);
  });
});
