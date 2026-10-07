import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { batchImports } from "./index.js";

const SRC = [
  "@echo off",
  ":: comment: call :never",
  "call :build || goto :fail",
  "if exist out (rmdir /s /q out) else msbuild Shop.sln",
  'call "%~dp0tools\\publish.cmd" 1.0',
  "scripts\\lint.bat",
  "exit /b 0",
  ":build",
  "REM restore first",
  "dotnet restore & dotnet build",
  'sqlcmd -Q "DELETE FROM Sessions WHERE Expired = 1"',
  "goto :eof",
  ":fail",
  "echo failed",
].join("\n");

describe("Batch scripts", () => {
  const a = extractWithRegex(SRC, "build.cmd", "batch");

  it("reads labels as functions running to the next label", () => {
    expect(a.functions.map((f) => `${f.name}@${f.line}-${f.endLine}`)).toEqual(["<setup>@1-1", "build@8-12", "fail@13-14"]);
  });

  it("reads label calls and commands — never keywords, comments or paths", () => {
    const calls = Object.fromEntries(a.functions.map((f) => [f.name, f.calls.map((c) => c.name)]));
    expect(calls).toEqual({ "<setup>": ["build", "msbuild"], build: ["dotnet", "sqlcmd"], fail: [] });
  });

  it("reads SQL given to a database client", () => {
    expect(a.dataSources.map((d) => `${d.name} ${d.entity}@${d.line}`)).toEqual(["DELETE FROM Sessions@11"]);
  });

  it("records the scripts it runs, anchored on %~dp0 or not", () => {
    expect(batchImports(SRC.split("\n")).map((i) => `${i.source} ${i.executes}`)).toEqual([
      "./tools/publish.cmd true", "scripts/lint.bat true",
    ]);
  });
});
