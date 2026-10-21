import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { pluginFor } from "../../registry.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the plugin's preprocess, as the analyzer runs it. */
function analyze(src: string, path = "scripts/run.ps1"): FileAnalysis {
  const pre = pluginFor("powershell")!.preprocess!(src, path);
  const p = pre && "sourceText" in pre ? pre : null;
  const analysis = extractWithRegex(p?.sourceText ?? src, path, "powershell");
  p?.postExtract?.(analysis, src);
  analysis.projectId = "app";
  return analysis;
}
const fn = (a: FileAnalysis, name: string) => [...a.functions, ...a.classes.flatMap((c) => c.methods)].find((f) => f.name === name);
const calls = (a: FileAnalysis, name: string) => fn(a, name)?.calls.map((c) => c.name) ?? [];

describe("PowerShell functions", () => {
  const SRC = [
    "<#",
    ".EXAMPLE",
    "    Get-AppPlayer -Id 5",
    "#>",
    "function Get-AppPlayer {",
    "    [CmdletBinding()]",
    "    param(",
    "        [Parameter(Mandatory = $false)]",
    "        [int]$Id,",
    "        [ValidateSet('a', 'b')][string[]]$Tags = @('a')",
    "    )",
    "    $rows = Invoke-Sqlcmd -Query 'SELECT 1' | Where-Object { $_.Id -eq $Id }",
    "    Write-Output (Get-Date)",
    "    if ($Id -and ($Tags)) { return Format-Player $rows }",
    "    $repo.Save($rows)",
    "    [PlayerRepository]::new('db').Find($Id)",
    "    $result = @{ Name = 'x'; Count = Measure-Ball }",
    "}",
    "function script:Helper($a, [int]$b = 2) { Write-Host $a }",
  ].join("\n");
  const a = analyze(SRC);

  it("reads functions and their param() block, attributes and all", () => {
    expect(a.functions.map((f) => f.name)).toEqual(["Get-AppPlayer", "Helper"]);
    expect(fn(a, "Get-AppPlayer")!.params).toEqual([
      { name: "Id", type: "int", defaultValue: null },
      { name: "Tags", type: "string[]", defaultValue: "@('a')" },
    ]);
    expect(fn(a, "Helper")!.params.map((p) => [p.name, p.type, p.defaultValue])).toEqual([["a", null, null], ["b", "int", "2"]]);
  });

  it("reads commands, methods and static calls — never parameters, attributes or keywords", () => {
    expect(calls(a, "Get-AppPlayer")).toEqual([
      "Invoke-Sqlcmd", "Where-Object", "Write-Output", "Get-Date", "Format-Player", "repo.Save", "new PlayerRepository", "Measure-Ball",
    ]);
  });

  it("never reads comment-based help as code", () => {
    expect(a.functions.find((f) => f.name === "<setup>")).toBeUndefined();
  });
});

describe("PowerShell imports", () => {
  it("reads modules, dot-sourcing and scripts run by path", () => {
    const a = analyze([
      "#Requires -Modules Pester, @{ ModuleName = 'Az.Accounts'; ModuleVersion = '2.0' }",
      "Import-Module Pode",
      'Import-Module "$PSScriptRoot\\modules\\Players.psm1"',
      "using module ./Shared.psm1",
      "using namespace System.Collections.Generic",
      ". $PSScriptRoot\\..\\lib\\Common.ps1",
      ". (Join-Path $PSScriptRoot 'helpers.ps1')",
      '& "$PSScriptRoot\\build.ps1" -Release',
      ". $PSScriptRoot\\Private\\*.ps1",
    ].join("\n"));
    expect(a.imports.map((i) => i.source)).toEqual([
      "Pester", "Az.Accounts", "Pode", "./modules/Players.psm1", "./Shared.psm1", "System.Collections.Generic",
      "../lib/Common.ps1", "./helpers.ps1", "./build.ps1",
    ]);
  });
});

describe("PowerShell classes", () => {
  it("reads classes, base types, properties and methods", () => {
    const a = analyze([
      "class PlayerRepository : BaseRepository, IDisposable {",
      "    hidden [string] $Table = 'Players'",
      "    static [int] $Count",
      "    PlayerRepository([string]$server) { $this.Server = $server }",
      "    [object[]] FindAll() {",
      "        return Invoke-Sqlcmd -Query \"SELECT * FROM Players\"",
      "    }",
      "}",
    ].join("\n"));
    const cls = a.classes[0]!;
    expect([cls.name, cls.extends, cls.implements]).toEqual(["PlayerRepository", "BaseRepository", ["IDisposable"]]);
    expect(cls.properties.map((p) => [p.name, p.type, p.visibility, p.isStatic])).toEqual([
      ["Table", "string", "private", false], ["Count", "int", "public", true],
    ]);
    expect(cls.methods.map((m) => m.name)).toEqual(["PlayerRepository", "FindAll"]);
    expect(calls(a, "FindAll")).toEqual(["Invoke-Sqlcmd"]);
  });
});

describe("Pode routes", () => {
  it("reads routes, groups, methods, guards and the script block's calls", () => {
    const a = analyze([
      "Start-PodeServer {",
      "    Add-PodeRoute -Method Get -Path '/api/players' -ScriptBlock {",
      "        Write-PodeJsonResponse -Value (Get-AppPlayer)",
      "    }",
      "    Add-PodeRoute -Path '/api/players/:id' -Method Delete `",
      "        -ScriptBlock { Remove-AppPlayer -Id $WebEvent.Parameters['id'] }",
      "    Add-PodeRouteGroup -Path '/api/admin' -Routes {",
      "        Add-PodeRoute -Method Post, Put -Path '/sync' -Authentication 'Login' -ScriptBlock { Sync-AppPlayers }",
      "    }",
      "    Add-PodeRoute -Method Get -Path '/after' -ScriptBlock { Get-After }",
      "}",
    ].join("\n"), "server.ps1");
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} [${r.middleware}] ${r.calls.map((c) => c.name)}`)).toEqual([
      "GET /api/players [] Write-PodeJsonResponse,Get-AppPlayer",
      "DELETE /api/players/:id [] Remove-AppPlayer",
      "POST /api/admin/sync [Authentication(Login)] Sync-AppPlayers",
      "PUT /api/admin/sync [Authentication(Login)] Sync-AppPlayers",
      "GET /after [] Get-After",
    ]);
  });
});

describe("PowerShell data access", () => {
  const a = analyze([
    "function Sync {",
    '    $c = Invoke-RestMethod -Uri "$env:CRM_URL/api/drivers/$($player.Id)" -Method Get',
    "    irm 'https://audit.example.com/api/events' -Method Post",
    "    $sql = @\"",
    "MERGE INTO Players AS t",
    "USING (SELECT 1 AS Id) AS s ON t.Id = s.Id;",
    "\"@",
    "    Invoke-Sqlcmd -Query \"DELETE FROM Sessions WHERE Expired = 1\"",
    "    Invoke-Sqlcmd -Query 'SELECT Name FROM Players WHERE Name = ''it''''s'''",
    "}",
  ].join("\n"));
  const sources = a.dataSources.map((d) => `${d.kind} ${d.name}${d.baseEnv ? ` (${d.baseEnv})` : ""}@${d.line}`);

  it("reads REST calls, a base URL from the environment kept apart", () => {
    expect(sources.filter((s) => s.startsWith("api-call"))).toEqual([
      "api-call GET /api/drivers/{id} (CRM_URL)@2",
      "api-call POST https://audit.example.com/api/events@3",
    ]);
  });

  it("reads SQL in strings and here-strings", () => {
    expect(sources.filter((s) => s.startsWith("database"))).toEqual([
      "database MERGE INTO@5", "database DELETE FROM@8", "database SELECT@9",
    ]);
  });
});

describe("PowerShell scope sharing", () => {
  it("links a bare command to the one dot-sourced or imported file defining it", () => {
    const lib = analyze("function Write-Log { param([string]$m) Write-Host $m }", "lib/Common.ps1");
    const other = analyze("function Write-Log { }", "lib/Other.ps1");
    const script = analyze(". $PSScriptRoot\\..\\lib\\Common.ps1\nwrite-log 'deploying'", "scripts/deploy.ps1");
    const links = buildSymbolLinks([lib, other, script]);
    expect(links.map((l) => `${l.sourceFile}:${l.sourceSymbol} -> ${l.targetFile}:${l.targetSymbol} ${l.strategy}`)).toEqual([
      "scripts/deploy.ps1:<setup> -> lib/Common.ps1:Write-Log import-file",
    ]);
  });
});
