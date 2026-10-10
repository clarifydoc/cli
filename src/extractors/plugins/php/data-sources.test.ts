import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PhpDataSourceExtractor } from "./data-sources.js";
import type { DataSourceInfo } from "../../../types/analysis.js";

/**
 * CodeIgniter Query Builder data access. The PHP extractor emitted entity-less
 * `database` sources for `$this->db->...`, which `attributeDataAccessToSymbols`
 * drops — so the whole CI data tier was invisible in Call Traces (ist-photo:
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
    const sources = await dbSourcesOf(`    return $this->db->get('orders');`);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.entity).toBe("orders");
    expect(sources[0]!.target).toBe("orders");
  });

  it("resolves the table at the base of a fluent chain (from is captured directly)", async () => {
    const sources = await dbSourcesOf(
      `    return $this->db->select('*')->from('order_rows')->where('id', 1)->get();`,
    );
    // `from('order_rows')` carries the table; select/where/get carry none.
    expect(sources.map((s) => s.entity)).toContain("order_rows");
    // No column-as-table junk from where('id', 1).
    expect(sources.every((s) => s.entity && /^[a-z_]+$/.test(s.entity))).toBe(true);
  });

  it("captures insert/update/delete/join tables, drops a table alias", async () => {
    const ins = await dbSourcesOf(`    $this->db->insert('customers', $data);`);
    expect(ins[0]!.entity).toBe("customers");
    const join = await dbSourcesOf(`    $this->db->from('orders o')->join('clients c', 'c.id = o.cid');`);
    expect(join.map((s) => s.entity).sort()).toEqual(["clients", "orders"]);
  });

  it("does not treat query refinement (where/select/order_by) as data sources", async () => {
    const sources = await dbSourcesOf(
      `    $this->db->where('orders.customer_id', 5);
    $this->db->select('orders.total');
    $this->db->order_by('orders.id');`,
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
    $s = $client->request('GET', '/api/users');
    $t = Http::send('PUT', '/api/x');`)).toEqual([
      ["POST", "{$endpoint}"],
      ["GET", "/api/users"],
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
class R {
  function q(User $user) {
${body}
  }
}`;
  const tree = await parseSource(src, "php" as any, "R.php");
  return new PhpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database");
}

describe("Eloquent chain rows", () => {
  it("emits one row for a fluent chain, at the terminal verb, with no column as target", async () => {
    const rows = await eloquentRowsOf(`    return $user->accounts()->where('name', $n)->where('id', '!=', 3)->first();`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("$user->accounts()->where('name', $n)->where('id', '!=', 3)->first");
    expect(rows[0]!.target).toBeNull();
    expect(rows[0]!.access).toBe("read");
  });

  it("folds a static root into its chain's one row and keeps a lone static as the row", async () => {
    const rows = await eloquentRowsOf(`    $a = Account::where('active', 1)->get();\n    $b = Account::find($id);\n    $c = Account::query()->onlyActive()->paginate();`);
    expect(rows.map((r) => r.name)).toEqual([
      "Account::where('active', 1)->get",
      "Account::find",
      "Account::query()->onlyActive()->paginate",
    ]);
    expect(rows[1]!.target).toBe("Account");
  });

  it("keeps the SQL text as a PDO target", async () => {
    const rows = await eloquentRowsOf(`    $rows = $pdo->query('SELECT * FROM orders')->fetchAll();`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("$pdo->query('SELECT * FROM orders')->fetchAll");
  });
});
