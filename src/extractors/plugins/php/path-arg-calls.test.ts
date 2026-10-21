import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PhpDataSourceExtractor } from "./data-sources.js";
import { extractPhpPathArgCalls } from "./path-arg-calls.js";
import { analyze } from "../../../core/analyzer.js";
import { denormalizeProject } from "../../../core/element-registry.js";

/** A project's own Guzzle wrapper: every controller asks it for a verb and an endpoint. */
const WRAPPER = `<?php
namespace App\\Http\\Model;

use GuzzleHttp\\Client;

class ApiConnection
{
    private $baseURI = 'https://league.example.com/';

    public function request(string $requestType, string $endpoint, array $body = [])
    {
        $client = new Client(['base_uri' => $this->baseURI]);
        $result = [];
        $response = $client->request($requestType, $endpoint, ['json' => $body]);
        return $this->parse($response);
    }
}
`;

const VERB = `<?php
namespace App\\Enums;

final class Verb
{
    public const GET = 'GET';
    public const POST = 'POST';
    public const DELETE = 'DELETE';
}
`;

const BASE = `<?php
namespace App\\Http\\Controllers;

use Illuminate\\Http\\Request;

class BaseController extends Controller
{
    public function makeEndpoint(Request $request, $endpoint)
    {
        $url = $_SERVER['REQUEST_URI'];
        if (($pos = strpos($url, "?")) !== FALSE) {
            $endpoint = $endpoint . "?" . substr($url, $pos + 1);
        }
        return $endpoint;
    }
}
`;

const CONTROLLER = `<?php
namespace App\\Http\\Controllers;

use App\\Enums\\Verb;
use App\\Http\\Model\\ApiConnection;
use Illuminate\\Http\\Request;
use Illuminate\\Http\\Response;

class ClubController extends BaseController
{
    private $endpoint = "/league/clubs";

    public function get($id)
    {
        $connection = new ApiConnection();
        $response = $connection->request(Verb::GET, "/league/clubs/" . $id);
        return new Response($response['body'], $response['code']);
    }

    public function create(Request $request)
    {
        $connection = new ApiConnection();
        $response = $connection->request(Verb::POST, "/league/clubs", $request->all());
        return new Response($response['body'], $response['code']);
    }

    public function delete(Request $request, $id)
    {
        $connection = new ApiConnection();
        $response = $connection->request(Verb::DELETE, $this->makeEndpoint($request, $this->endpoint . "/" . $id));
        return new Response($response['body'], $response['code']);
    }

    public function squad($id)
    {
        $endpoint = "league/clubs/" . $id . "/squad";
        $response = (new ApiConnection())->request('GET', $endpoint);
        return new Response($response['body'], $response['code']);
    }
}
`;

async function sitesOf(src: string) {
  const tree = await parseSource(src, "php" as any, "C.php");
  return extractPhpPathArgCalls(tree, src);
}

async function sourcesOf(src: string) {
  const tree = await parseSource(src, "php" as any, "C.php");
  return new PhpDataSourceExtractor().extract(tree, src);
}

describe("PHP request wrapper — per file", () => {
  it("records each call site with its path, receiver class and verb", async () => {
    expect(await sitesOf(CONTROLLER)).toEqual([
      { callee: "request", args: [null, "/league/clubs/{}"], line: 16, receiverType: "ApiConnection", method: "GET" },
      { callee: "request", args: [null, "/league/clubs", null], line: 23, receiverType: "ApiConnection", method: "POST" },
      { callee: "request", args: [null, "/league/clubs/{}"], line: 30, receiverType: "ApiConnection", method: "DELETE" },
      { callee: "request", args: [null, "league/clubs/{}/squad"], line: 37, receiverType: "ApiConnection", method: "GET" },
    ]);
  });

  it("reads typed parameters and properties as the receiver's class, and leaves client requests alone", async () => {
    const sites = await sitesOf(`<?php
class TransferController {
    public function __construct(private ApiConnection $api) {}
    public function list(ApiConnection $connection) {
        $connection->request(Verb::GET, "league/transfers");
        $this->api->request(Verb::POST, "league/transfers");
        $client = new Client();
        $client->request('GET', '/league/table');
        Route::get('/league/table', [TableController::class, 'index']);
    }
}`);
    expect(sites.map((s) => [s.line, s.receiverType, s.method])).toEqual([
      [5, "ApiConnection", "GET"],
      [6, "ApiConnection", "POST"],
      [9, "Route", undefined],
    ]);
  });

  it("gives the wrapper's client call its endpoint parameter as the URL", async () => {
    const rows = (await sourcesOf(WRAPPER)).filter((d) => d.kind === "api-call");
    expect(rows.map((r) => [r.name, r.target])).toEqual([["$client->request", "{$endpoint}"]]);
  });

  it("does not read the HTTP request's input as a database access", async () => {
    const rows = await sourcesOf(`<?php
namespace App\\Http\\Controllers;
class PlayerController {
    public function store(Request $request, StorePlayerRequest $form, $req) {
        $a = $request->all();
        $b = $form->all();
        $c = $req->query('page');
        $d = $this->request->get('name');
        $e = request()->all();
        $players = Player::all();
        $transfer = TransferRequest::find(1);
        $transfer->delete();
    }
}`);
    expect(rows.filter((d) => d.kind === "database").map((d) => d.name)).toEqual(["Player::all", "TransferRequest::find", "$transfer->delete"]);
  });
});

describe("PHP request wrapper — end to end", () => {
  let dir: string;
  let summary: Record<string, any>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-php-wrapper-"));
    const web = join(dir, "web");
    await mkdir(join(web, "app", "Http", "Model"), { recursive: true });
    await mkdir(join(web, "app", "Http", "Controllers"), { recursive: true });
    await mkdir(join(web, "app", "Enums"), { recursive: true });
    await writeFile(join(web, "composer.json"), JSON.stringify({ require: { "laravel/framework": "^10.0", "guzzlehttp/guzzle": "^7.0" }, autoload: { "psr-4": { "App\\": "app/" } } }));
    await writeFile(join(web, "app", "Http", "Model", "ApiConnection.php"), WRAPPER);
    await writeFile(join(web, "app", "Enums", "Verb.php"), VERB);
    await writeFile(join(web, "app", "Http", "Controllers", "BaseController.php"), BASE);
    await writeFile(join(web, "app", "Http", "Controllers", "ClubController.php"), CONTROLLER);
    const api = join(dir, "api");
    await mkdir(api, { recursive: true });
    await writeFile(join(api, "package.json"), JSON.stringify({ name: "api", dependencies: { express: "4.0.0" } }));
    await writeFile(
      join(api, "server.js"),
      'const express = require("express");\nconst app = express();\n' +
        'app.get("/league/clubs/:id", (req, res) => res.json({}));\n' +
        'app.delete("/league/clubs/:id", (req, res) => res.json({}));\n' +
        'app.post("/league/clubs", (req, res) => res.json({}));\n' +
        'app.get("/league/clubs/:id/squad", (req, res) => res.json({}));\n',
    );
    const out = join(dir, "out");
    await analyze({ projectRoot: dir, outputDir: out, incremental: false, lsp: false, gitHistory: false });
    summary = denormalizeProject(JSON.parse(await readFile(join(out, "project-summary.json"), "utf8"))) as Record<string, any>;
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("turns each controller call into a request with the verb its constant names", () => {
    const viaWrapper = (summary.apiCalls as any[])
      .filter((c) => c.via === "request")
      .map((c) => [c.line, c.name, c.target]);
    expect(viaWrapper).toEqual([
      [16, "GET", "/league/clubs/{}"],
      [23, "POST", "/league/clubs"],
      [30, "DELETE", "/league/clubs/{}"],
      [37, "GET", "/league/clubs/{}/squad"],
    ]);
  });

  it("links them to the routes serving that method", () => {
    const joined = (summary.apiRouteLinks as any[])
      .filter((l) => l.source === "web/app/Http/Controllers/ClubController.php")
      .map((l) => `${l.sourceLine} ${l.method} ${l.routePath}`)
      .sort();
    expect(joined).toEqual([
      "16 GET /league/clubs/:id",
      "23 POST /league/clubs",
      "30 DELETE /league/clubs/:id",
      "37 GET /league/clubs/:id/squad",
    ]);
  });
});
