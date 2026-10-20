import { readFile } from "fs/promises";
import { join, posix, resolve } from "path";
import { glob } from "./glob.js";
import { byOrdinal } from "./ordinal.js";
import { parseSimpleYaml, projectOfContext, type YamlMap, type YamlValue } from "./deployment.js";
import type { CiDeploy, SubProject } from "../types/analysis.js";

/**
 * What a repository's CI deploys, and when: the deploy steps of its
 * pipelines.
 *
 *   on: { push: { branches: [main] } }                         GitHub Actions
 *   jobs.release.steps:
 *     - uses: docker/build-push-action@v6 with: { context: ./orders, push: true }   → docker, orders/
 *     - run: kubectl apply -f k8s/orders                                          → kubernetes, k8s/orders
 *     - run: terraform apply -auto-approve  (working-directory: infra)            → terraform, infra/
 *   deploy_api: { stage: deploy, script: [cd api, npx serverless deploy] }       GitLab CI → serverless, api/
 *
 * Read: GitHub Actions workflows and `.gitlab-ci.yml` by their structure;
 * Azure Pipelines, CircleCI and Bitbucket Pipelines through every script
 * line and task under their jobs. A deploy is a step that ships something:
 * a container image built and pushed, manifests applied, a chart installed,
 * a Terraform/Serverless/CDK/SAM deployment, a package published, a site or
 * service deployed to a host. Its path — build context, manifest, chart,
 * working directory — names the sub-project it ships.
 */

type Provider = CiDeploy["provider"];
type Kind = CiDeploy["kind"];

/** Actions (`uses:`) that deploy, with the input that names what. */
const ACTIONS: Array<{ re: RegExp; kind: Kind; path?: (w: YamlMap) => string | undefined }> = [
  { re: /^docker\/build-push-action@/, kind: "docker", path: (w) => str(w.context) ?? (str(w.file) ? posix.dirname(str(w.file)!) : undefined) },
  { re: /^(?:azure\/k8s-deploy|azure\/k8s-bake|steebchen\/kubectl)@/, kind: "kubernetes", path: (w) => str(w.manifests)?.split(/\s+/)[0] },
  { re: /^(?:deliverybot\/helm|azure\/k8s-bake)@/, kind: "helm", path: (w) => str(w.chart) },
  { re: /^serverless\/github-action@/, kind: "serverless" },
  { re: /^(?:actions\/deploy-pages|peaceiris\/actions-gh-pages|JamesIves\/github-pages-deploy-action)@/, kind: "pages", path: (w) => str(w.publish_dir) ?? str(w.folder) ?? str(w.path) },
  { re: /^(?:google-github-actions\/deploy-(?:cloudrun|appengine|cloud-functions)|aws-actions\/amazon-ecs-deploy-task-definition|azure\/webapps-deploy|azure\/functions-action|azure\/static-web-apps-deploy|amondnet\/vercel-action|nwtgck\/actions-netlify|superfly\/flyctl-actions)@/, kind: "cloud", path: (w) => str(w.source) ?? str(w.package) ?? str(w["app-location"]) ?? str(w["publish-dir"]) ?? str(w["working-directory"]) },
];

/** Shell commands that deploy, with how to read their path. */
const COMMANDS: Array<{ re: RegExp; kind: Kind; path?: (m: RegExpExecArray, line: string) => string | undefined }> = [
  // A docker build ships only in a job that pushes (see `jobDeploys`).
  { re: /\bdocker\s+(?:buildx\s+)?build\b(.*)$/, kind: "docker", path: (m) => dockerContext(m[1]!) },
  { re: /\bdocker\s+compose\b.*?(?:-f|--file)\s+(\S+).*\bbuild\b/, kind: "docker", path: (m) => posix.dirname(m[1]!) },
  { re: /\bkubectl\s+apply\b.*?\s-[fk]\s+(\S+)/, kind: "kubernetes", path: (m) => (m[1] === "-" ? undefined : m[1]) },
  { re: /\bskaffold\s+(?:run|deploy)\b/, kind: "kubernetes" },
  { re: /\bhelm\s+(?:upgrade|install)\b(.*)$/, kind: "helm", path: (m) => m[1]!.split(/\s+/).find((w) => /^\.{0,2}\/|^charts?\//.test(w)) },
  { re: /\bterraform\s+(?:-chdir=(\S+)\s+)?apply\b/, kind: "terraform", path: (m) => m[1] },
  { re: /\b(?:serverless|sls)\s+deploy\b/, kind: "serverless" },
  { re: /\bcdk\s+deploy\b/, kind: "cdk" },
  { re: /\bsam\s+deploy\b/, kind: "sam" },
  { re: /\b(?:npm|yarn|pnpm)\s+publish\b|\bdotnet\s+nuget\s+push\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgem\s+push\b|\bmvn\b.*\bdeploy\b|\bgradle\w*\b.*\bpublish\b/, kind: "package" },
  { re: /\bgcloud\s+(?:run|app|functions)\s+deploy\b.*?(?:--source[= ](\S+))?/, kind: "cloud", path: (m) => m[1] },
  { re: /\baz\s+(?:webapp|functionapp|containerapp)\s+(?:deploy|up|update)\b|\bfly(?:ctl)?\s+deploy\b|\bvercel\b.*--prod\b|\bnetlify\s+deploy\b/, kind: "cloud" },
  { re: /\baws\s+s3\s+sync\s+(\S+)\s+s3:\/\//, kind: "cloud", path: (m) => m[1] },
];

const str = (v: YamlValue | undefined): string | undefined => (typeof v === "string" && v && !v.includes("${{") ? v : undefined);
const map = (v: YamlValue | undefined): YamlMap => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const list = (v: YamlValue | undefined): YamlValue[] => (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]);

/** `docker build -t x -f orders/Dockerfile ./orders` → `./orders` (else the Dockerfile's directory). */
function dockerContext(args: string): string | undefined {
  const words = args.trim().split(/\s+/);
  let file: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "-f" || w === "--file") file = words[++i];
    else if (/^--?[\w-]+=/.test(w)) continue;
    else if (/^-{1,2}[\w-]+$/.test(w)) i++;
    else positional.push(w);
  }
  const ctx = positional.find((w) => !w.includes("$") && (/^\.{1,2}(?:\/|$)/.test(w) || /^[\w.-]+\//.test(w)));
  return ctx ?? (file ? posix.dirname(file) : undefined);
}

/** `on:` as triggers: `push main`, `tag v*`, `pull_request`, `manual`, `schedule`. */
function githubTriggers(on: YamlValue | undefined): string[] {
  if (typeof on === "string") return [on === "workflow_dispatch" ? "manual" : on];
  if (Array.isArray(on)) return on.filter((x): x is string => typeof x === "string").map((x) => (x === "workflow_dispatch" ? "manual" : x));
  const out: string[] = [];
  for (const [event, cfg] of Object.entries(map(on))) {
    if (event === "workflow_dispatch") out.push("manual");
    else if (event === "push") {
      const c = map(cfg);
      const branches = list(c.branches).filter((b): b is string => typeof b === "string");
      const tags = list(c.tags).filter((b): b is string => typeof b === "string");
      if (branches.length) out.push(`push ${branches.join(",")}`);
      if (tags.length) out.push(`tag ${tags.join(",")}`);
      if (!branches.length && !tags.length) out.push("push");
    } else out.push(event);
  }
  return out;
}

interface Step {
  text?: string;
  uses?: string;
  with?: YamlMap;
  workdir?: string;
  line: number;
}


function deploysOf(step: Step): Array<{ kind: Kind; path?: string; via: string }> {
  const out: Array<{ kind: Kind; path?: string; via: string }> = [];
  if (step.uses) {
    for (const a of ACTIONS) {
      if (!a.re.test(step.uses)) continue;
      // build-push-action deploys when it pushes — always, or on the events an expression names.
      const push = step.with?.push;
      if (a.kind === "docker" && !(push === "true" || (typeof push === "string" && push.includes("${{")) || /push=true/.test(String(step.with?.outputs ?? "")))) continue;
      out.push({ kind: a.kind, path: a.path?.(step.with ?? {}) ?? step.workdir, via: step.uses.replace(/@.*$/, "") });
    }
  }
  for (const line of (step.text ?? "").split(/\n|&&|;/)) {
    const l = line.trim();
    for (const c of COMMANDS) {
      const m = c.re.exec(l);
      if (!m) continue;
      out.push({ kind: c.kind, path: c.path?.(m, l) ?? step.workdir, via: l.length > 100 ? `${l.slice(0, 97)}…` : l });
      break;
    }
  }
  return out;
}

/** `cd api && npx serverless deploy`: a `cd` earlier in the same script moves the steps after it. */
function withCd(text: string, workdir: string | undefined): Step[] {
  const steps: Step[] = [];
  let dir = workdir;
  for (const part of text.split(/\n|&&|;/)) {
    const cd = /^\s*cd\s+(\S+)\s*$/.exec(part);
    if (cd) {
      dir = dir && !cd[1]!.startsWith("/") ? posix.join(dir, cd[1]!) : cd[1]!;
      continue;
    }
    if (part.trim()) steps.push({ text: part.trim(), workdir: dir, line: 0 });
  }
  return steps;
}

export async function detectCiDeploys(projectRoot: string, subProjects: readonly SubProject[]): Promise<CiDeploy[]> {
  const absRoot = resolve(projectRoot);
  const files = (await glob([".github/workflows/*.{yml,yaml}", "**/.gitlab-ci.yml", "azure-pipelines.{yml,yaml}", "**/azure-pipelines*.{yml,yaml}", ".circleci/config.yml", "bitbucket-pipelines.yml"], {
    cwd: absRoot,
    absolute: false,
    dot: true,
    deep: 4,
    ignore: ["**/node_modules/**", "**/vendor/**"],
  })).map((f) => f.split("\\").join("/")).sort(byOrdinal).slice(0, 60);

  const out: CiDeploy[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(join(absRoot, file), "utf8");
    } catch {
      continue;
    }
    if (raw.length > 500_000) continue;
    const doc = parseSimpleYaml(raw);
    // Steps are located in file order: the same text twice (two build-push steps) is two lines.
    let cursor = 0;
    const locate = (needle: string | undefined): number => {
      if (!needle) return 1;
      const first = needle.split("\n")[0]!.trim().slice(0, 60);
      let at = first ? raw.indexOf(first, cursor) : -1;
      if (at < 0 && first) at = raw.indexOf(first);
      if (at < 0) return 1;
      cursor = at + first.length;
      return raw.slice(0, at).split("\n").length;
    };
    const provider: Provider = file.startsWith(".github/") ? "github" : file.endsWith(".gitlab-ci.yml") ? "gitlab" : file.includes("azure-pipelines") ? "azure" : file.startsWith(".circleci/") ? "circleci" : "bitbucket";
    const jobs: Array<{ name: string; triggers: string[]; steps: Step[] }> = [];
    if (provider === "github") {
      const triggers = githubTriggers(doc.on);
      for (const [name, jobV] of Object.entries(map(doc.jobs))) {
        const job = map(jobV);
        const jobDir = str(map(map(job.defaults).run)["working-directory"]);
        const steps: Step[] = [];
        for (const s of list(job.steps)) {
          const step = map(s);
          const workdir = str(step["working-directory"]) ?? jobDir;
          if (str(step.uses)) steps.push({ uses: str(step.uses), with: map(step.with), workdir, line: locate(str(step.uses)) });
          if (str(step.run)) for (const sub of withCd(str(step.run)!, workdir)) steps.push({ ...sub, line: locate(sub.text) });
        }
        jobs.push({ name, triggers, steps });
      }
    } else if (provider === "gitlab") {
      const RESERVED = new Set(["stages", "variables", "image", "before_script", "after_script", "default", "include", "workflow", "services", "cache", "pages:deploy"]);
      for (const [name, jobV] of Object.entries(doc)) {
        if (RESERVED.has(name) || name.startsWith(".")) continue;
        const job = map(jobV);
        const script = list(job.script).filter((x): x is string => typeof x === "string").join("\n");
        if (!script) continue;
        const triggers = [
          ...list(job.only).filter((x): x is string => typeof x === "string").map((b) => `push ${b}`),
          ...(str(job.when) === "manual" ? ["manual"] : []),
          ...list(job.rules).map((r) => str(map(r).if)).filter((x): x is string => !!x).map((c) => `if ${c}`),
        ];
        const steps = withCd(script, undefined).map((s) => ({ ...s, line: locate(s.text) }));
        // GitLab Pages: a job named `pages` publishes its `public/`.
        if (name === "pages") steps.push({ uses: "gitlab-pages", text: "", workdir: "public", line: locate("pages:") });
        jobs.push({ name, triggers: triggers.length ? triggers : ["push"], steps });
      }
    } else {
      // Azure / CircleCI / Bitbucket: every script line under a job-shaped map, and Azure tasks.
      const walk = (v: YamlValue, job: string): void => {
        if (Array.isArray(v)) {
          for (const x of v) walk(x, job);
          return;
        }
        if (!v || typeof v !== "object") return;
        for (const [k, x] of Object.entries(v)) {
          const nextJob = /^(?:job|deployment|stage)$/.test(k) && typeof x === "string" ? x : job;
          if ((k === "script" || k === "bash" || k === "run" || k === "command" || k === "pwsh") && (typeof x === "string" || Array.isArray(x))) {
            const text = (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : [x as string]).join("\n");
            const into = jobs.find((j) => j.name === nextJob) ?? jobs[jobs.push({ name: nextJob, triggers: [], steps: [] }) - 1]!;
            for (const s of withCd(text, undefined)) into.steps.push({ ...s, line: locate(s.text) });
          } else if (k === "task" && typeof x === "string" && /^(?:Docker|KubernetesManifest|HelmDeploy|AzureWebApp|AzureFunctionApp|TerraformTask\w*)@/.test(x)) {
            const inputs = map((v as YamlMap).inputs);
            const into = jobs.find((j) => j.name === nextJob) ?? jobs[jobs.push({ name: nextJob, triggers: [], steps: [] }) - 1]!;
            const cmd = str(inputs.command) ?? "";
            const kind: Kind | null = /^Docker@/.test(x) ? (/push/i.test(cmd) ? "docker" : null) : /^KubernetesManifest@/.test(x) ? "kubernetes" : /^HelmDeploy@/.test(x) ? "helm" : /^Terraform/.test(x) ? (/apply/i.test(cmd) ? "terraform" : null) : "cloud";
            const path = str(inputs.buildContext) ?? (str(inputs.Dockerfile) ? posix.dirname(str(inputs.Dockerfile)!) : undefined) ?? str(inputs.manifests) ?? str(inputs.chartPath) ?? str(inputs.workingDirectory) ?? str(inputs.package);
            if (kind) out.push(...[{ kind, path, via: x.replace(/@.*$/, "") }].map((d) => row(file, provider, undefined, into.name, locate(x), [], d)));
          } else walk(x, nextJob);
        }
      };
      walk(doc, "pipeline");
    }
    const workflow = provider === "github" ? str(doc.name) : undefined;
    for (const job of jobs) {
      // A `docker build` ships only when the job pushes: `docker push`, `buildx --push`, `compose push`.
      const pushes = job.steps.some((st) => /\bdocker\s+(?:push|buildx\s+build\b.*--push|compose\b.*\bpush)\b/.test(st.text ?? ""));
      for (const step of job.steps) {
        for (const d of deploysOf(step)) {
          if (d.kind === "docker" && !step.uses && !pushes) continue;
          out.push(row(file, provider, workflow, job.name, step.line, job.triggers, d));
        }
      }
    }
  }
  for (const d of out) {
    if (!d.path) continue;
    d.path = posix.normalize(d.path).replace(/\/$/, "") || ".";
    const project = projectOfContext(d.path === "." ? "" : d.path, subProjects);
    if (project) d.project = project;
  }
  return out;
}

function row(file: string, provider: Provider, workflow: string | undefined, job: string, line: number, triggers: string[], d: { kind: Kind; path?: string; via: string }): CiDeploy {
  return { file, provider, ...(workflow ? { workflow } : {}), job, line, triggers, kind: d.kind, ...(d.path ? { path: d.path } : {}), via: d.via };
}
