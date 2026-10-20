import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { collectProjectCommands } from "./project-commands.js";
import { orientation } from "../mcp/tools/context.js";

describe("how each sub-project is built, tested and started", () => {
  it("reads every language's manifests at each root, the first reader per kind", () => {
    const root = mkdtempSync(join(tmpdir(), "clarifydoc-commands-"));
    try {
      const put = (rel: string, text = "") => {
        mkdirSync(join(root, rel, ".."), { recursive: true });
        writeFileSync(join(root, rel), text);
      };
      put("web/package.json", JSON.stringify({ scripts: { build: "vite build", test: "vitest", dev: "vite", lint: "eslint ." } }));
      put("web/pnpm-lock.yaml");
      put("api/go.mod", "module shop/api\n");
      put("py/pyproject.toml", "[build-system]\nrequires = []\n[tool.pytest.ini_options]\n");
      put("py/manage.py");
      put("jvm/pom.xml", "<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>");
      put("jvm/mvnw");
      put("net/Shop.Api.csproj", "<Project/>");
      put("rs/Cargo.toml", "[package]\nname = \"x\"\n");
      put("rs/src/main.rs");
      put("rb/Gemfile", "gem 'rails'\n");
      put("rb/spec/a_spec.rb");
      put("rb/bin/rails");
      put("php/composer.json", JSON.stringify({ scripts: { test: "phpunit" } }));
      put("php/artisan");
      put("old/package.json", JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }));
      const ids = ["web", "api", "py", "jvm", "net", "rs", "rb", "php", "old"];
      const got = collectProjectCommands(root, ids.map((id) => ({ id, root: id })));
      const by = (id: string) => got.filter((c) => c.projectId === id).map((c) => `${c.kind}: ${c.command}`);
      expect(by("web")).toEqual(["build: pnpm build", "test: pnpm test", "dev: pnpm dev", "lint: pnpm lint"]);
      expect(by("api")).toEqual(["build: go build ./...", "test: go test ./..."]);
      expect(by("py")).toEqual(["build: python -m build", "test: pytest", "start: python manage.py runserver"]);
      expect(by("jvm")).toEqual(["build: ./mvnw package", "test: ./mvnw test", "start: ./mvnw spring-boot:run"]);
      expect(by("net")).toEqual(["build: dotnet build", "test: dotnet test", "start: dotnet run"]);
      expect(by("rs")).toEqual(["build: cargo build", "test: cargo test", "start: cargo run"]);
      expect(by("rb")).toEqual(["test: bundle exec rspec", "start: bin/rails server"]);
      expect(by("php")).toEqual(["test: composer test", "start: php artisan serve"]);
      // npm's placeholder test script is no test.
      expect(by("old")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("puts where to start in the status, per sub-project", () => {
    const lines = orientation({
      subProjects: [
        { id: "web", name: "web", root: "web", kind: "frontend" },
        { id: "api", name: "api", root: "api", kind: "backend" },
      ] as never,
      fileProjects: { "web/src/main.tsx": "web", "api/main.go": "api" },
      deadCode: { languages: [], judgedFiles: 2, entryFiles: 2, files: [], exports: [], entries: [{ filePath: "api/main.go", reason: "package main" }, { filePath: "web/src/main.tsx", reason: "vite entry" }] },
      projectCommands: [{ projectId: "web", root: "web", kind: "test", command: "pnpm test", source: "package.json scripts.test" }],
    });
    expect(lines).toEqual([
      "",
      "## Where to start",
      "- web (web): starts at web/src/main.tsx (vite entry) · test `pnpm test`",
      "- api (api): starts at api/main.go (package main)",
    ]);
  });
});
