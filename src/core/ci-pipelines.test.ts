import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { detectCiDeploys } from "./ci-pipelines.js";
import type { SubProject } from "../types/analysis.js";

const projects = [
  { id: "root", name: "(root)", root: "", kind: "root", markers: [] },
  { id: "cars", name: "cars", root: "cars", kind: "node", markers: [] },
  { id: "api", name: "api", root: "api", kind: "node", markers: [] },
  { id: "web", name: "web", root: "web", kind: "node", markers: [] },
] as unknown as SubProject[];

describe("CI deploys", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-ci-"));
    await mkdir(join(dir, ".github/workflows"), { recursive: true });
    await writeFile(join(dir, ".github/workflows/release.yml"), `name: Release
on:
  push:
    branches: [main]
    tags: ["v*"]
  workflow_dispatch:
jobs:
  images:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Cars image
        uses: docker/build-push-action@v6
        with:
          context: ./cars
          push: true
      - uses: docker/build-push-action@v6
        with:
          context: ./web
          push: \${{ github.event_name == 'push' }}
      - name: Manifests
        run: |
          kubectl apply -f k8s/cars
          echo done
  infra:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: infra
    steps:
      - run: terraform init
      - run: terraform apply -auto-approve
  site:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci && npm run build
        working-directory: web
      - uses: peaceiris/actions-gh-pages@v4
        with:
          publish_dir: ./web/dist
  api-image:
    runs-on: ubuntu-latest
    steps:
      - name: Build and push the api image
        run: |
          docker build -t ghcr.io/example/league-api:\${{ github.ref_name }} -f api/Dockerfile .
          docker push ghcr.io/example/league-api:\${{ github.ref_name }}
`);
    await writeFile(join(dir, ".github/workflows/ci.yml"), `on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: docker build -t check .
`);
    await writeFile(join(dir, ".gitlab-ci.yml"), `stages: [deploy]
deploy_api:
  stage: deploy
  only: [main]
  script:
    - cd api
    - npx serverless deploy --stage prod
publish:
  when: manual
  script:
    - npm publish
`);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("finds each deploy step with its trigger, path and project — a script naming `${{ … }}` too; a docker build without a push is no deploy", async () => {
    const rows = await detectCiDeploys(dir, projects);
    expect(rows.map((r) => `${r.provider} ${r.file}:${r.line} ${r.job} [${r.triggers.join("; ")}] ${r.kind} ${r.path ?? "-"} ${r.project ?? "-"} · ${r.via}`)).toEqual([
      "github .github/workflows/release.yml:13 images [push main; tag v*; manual] docker cars cars · docker/build-push-action",
      "github .github/workflows/release.yml:17 images [push main; tag v*; manual] docker web web · docker/build-push-action",
      "github .github/workflows/release.yml:23 images [push main; tag v*; manual] kubernetes k8s/cars root · kubectl apply -f k8s/cars",
      "github .github/workflows/release.yml:32 infra [push main; tag v*; manual] terraform infra root · terraform apply -auto-approve",
      "github .github/workflows/release.yml:38 site [push main; tag v*; manual] pages web/dist web · peaceiris/actions-gh-pages",
      "github .github/workflows/release.yml:46 api-image [push main; tag v*; manual] docker . root · docker build -t ghcr.io/example/league-api:${{ github.ref_name }} -f api/Dockerfile .",
      "gitlab .gitlab-ci.yml:7 deploy_api [push main] serverless api api · npx serverless deploy --stage prod",
      "gitlab .gitlab-ci.yml:11 publish [manual] package - - · npm publish",
    ]);
    expect(rows.find((r) => r.kind === "docker" && r.path === "cars")?.workflow).toBe("Release");
  });
});
