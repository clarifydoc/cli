import { pythonProjectCommands } from "./project-commands.js";
import { pythonTestCommand } from "./test-command.js";
import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { pythonFrameworkRules } from "./frameworks.js";
import { pypiPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const pythonManifest: LanguagePluginManifest = {
  blockingCalls: /^(?:time\.sleep|requests\.(?:get|post|put|patch|delete|head|request)|urllib\.request\.urlopen|urlopen|subprocess\.(?:run|call|check_call|check_output))$/,
  testCommand: pythonTestCommand,
  projectCommands: pythonProjectCommands,
  language: "python",
  family: "python",
  packageManagers: [pypiPackageManager],
  packageEcosystems: ["pypi"],
  parsing: "tree-sitter",
  extensions: [".py", ".pyw"],
  // A field is only reached through the instance (`this.x`); a bare name never is one.
  explicitSelfMembers: true,
  // `class D(B, C)`: bases are classes, searched in C3 order.
  multipleInheritance: true,
  grammar: { variants: { python: { pkg: "tree-sitter-python", wasm: "tree-sitter-python.wasm" } } },
  testFilePatterns: [/(^|[\\/])test_[^\\/]*\.py$/, /_test\.py$/, /(^|[\\/])conftest\.py$/],
  builtinMembers: ["append", "extend", "insert", "remove", "pop", "clear", "index", "count", "sort", "reverse", "copy", "items", "keys", "values", "update", "setdefault", "strip", "lstrip", "rstrip", "lower", "upper", "title", "capitalize", "startswith", "endswith", "split", "rsplit", "splitlines", "join", "format", "replace", "encode", "decode", "find", "rfind", "isdigit", "isalpha", "read", "readline", "readlines", "write", "writelines", "close", "flush", "seek", "tell", "open", "connect", "login", "sendmail", "quit", "send", "recv", "bind", "listen", "accept", "get", "add", "discard", "union", "intersection", "difference"],
  externalModulePrefixes: ["os", "sys", "json", "re", "math", "datetime", "typing", "enum", "collections", "itertools", "functools", "pathlib", "hashlib", "asyncio", "logging", "unittest", "abc", "fastapi", "flask", "django", "pydantic", "sqlalchemy", "requests", "httpx", "aiohttp", "pytest", "numpy", "pandas", "scipy"],
  frameworkImportHints: { sqlalchemy: "sqlalchemy", "django.db.models": "django-orm", "django.db": "django-orm", tortoise: "tortoise-orm", peewee: "peewee", pony: "pony-orm", "pony.orm": "pony-orm" },
  frameworkRules: pythonFrameworkRules,
  activationFiles: ["requirements.txt", "pyproject.toml"],
  // protoc output for Python.
  generatedFilePatterns: [/_pb2\.py$/, /_pb2_grpc\.py$/],
};
