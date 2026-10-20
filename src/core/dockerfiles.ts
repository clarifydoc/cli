import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * What a Dockerfile says about the program a container runs.
 *
 *   FROM node:20 AS build … FROM node:20-slim
 *   WORKDIR /app
 *   ENV PORT=8080 ORDERS_URL=http://orders:8080
 *   EXPOSE 8080
 *   CMD ["node", "dist/server.js"]
 *
 * The final stage is what runs: its `ENTRYPOINT` + `CMD` (exec or shell
 * form; inherited from an earlier stage it is built `FROM`), its `ENV` and
 * `EXPOSE`. `entryFile` is the repository file that command starts, when it
 * names one the build context holds: a script path (`python app/main.py`,
 * `node dist/server.js` → `src/server.ts` when only the source is checked
 * in), a module (`python -m app.worker`, `uvicorn app.main:app`, `gunicorn
 * shop.wsgi`), or a package script (`npm start` → its `start` command). A
 * compiled artifact (`dotnet Orders.Api.dll`, `java -jar app.jar`) names a
 * project, not a file — the deployment pass matches those by artifact.
 */

export interface DockerfileFacts {
  /** Repo-relative path of the Dockerfile. */
  dockerfile: string;
  /** `ENTRYPOINT` and `CMD` joined, as one command line. */
  command?: string;
  env: Record<string, string>;
  expose: number[];
  workdir?: string;
}

interface Stage {
  name?: string;
  from: string;
  entrypoint?: string[];
  cmd?: string[];
  env: Record<string, string>;
  expose: number[];
  workdir?: string;
}

/** `["node", "a.js"]` (exec form) or `node a.js` (shell form) → words. */
function commandWords(arg: string): string[] {
  const t = arg.trim();
  if (t.startsWith("[")) {
    try {
      const v = JSON.parse(t) as unknown;
      if (Array.isArray(v)) return v.map(String);
    } catch {
      /* fall through to the shell form */
    }
  }
  // `sh -c "…"` keeps its script; quotes are dropped from plain words.
  return (t.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ""));
}

/** `ENV A=1 B="two words"` or the legacy `ENV A 1`. */
function envPairs(arg: string): Record<string, string> {
  const out: Record<string, string> = {};
  const t = arg.trim();
  if (!/^[A-Za-z_][\w.-]*=/.test(t)) {
    const m = /^([A-Za-z_][\w.-]*)\s+([\s\S]*)$/.exec(t);
    if (m) out[m[1]!] = m[2]!.trim();
    return out;
  }
  for (const m of t.matchAll(/([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/g)) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  return out;
}

export function parseDockerfile(text: string): Omit<DockerfileFacts, "dockerfile"> {
  const logical = text.replace(/\\\r?\n/g, " ").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const stages: Stage[] = [];
  let cur: Stage | null = null;
  for (const line of logical) {
    const m = /^(\w+)\s+([\s\S]*)$/.exec(line);
    if (!m) continue;
    const ins = m[1]!.toUpperCase();
    const arg = m[2]!;
    if (ins === "FROM") {
      const f = /^(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(arg);
      const base = stages.find((s) => s.name && s.name.toLowerCase() === f?.[1]?.toLowerCase());
      // Built FROM an earlier stage: what it set carries over.
      cur = base ? { ...base, name: f?.[2], env: { ...base.env }, expose: [...base.expose], from: f?.[1] ?? "" } : { from: f?.[1] ?? "", name: f?.[2], env: {}, expose: [] };
      stages.push(cur);
      continue;
    }
    if (!cur) continue;
    if (ins === "CMD") cur.cmd = commandWords(arg);
    else if (ins === "ENTRYPOINT") {
      cur.entrypoint = commandWords(arg);
      cur.cmd = undefined; // a new ENTRYPOINT resets an inherited CMD
    } else if (ins === "ENV") Object.assign(cur.env, envPairs(arg));
    else if (ins === "EXPOSE") for (const p of arg.split(/\s+/)) {
      const n = Number(p.split("/")[0]);
      if (Number.isInteger(n) && n > 0) cur.expose.push(n);
    }
    else if (ins === "WORKDIR") cur.workdir = arg.trim();
  }
  const last = stages[stages.length - 1];
  if (!last) return { env: {}, expose: [] };
  const words = [...(last.entrypoint ?? []), ...(last.cmd ?? [])];
  return {
    ...(words.length ? { command: words.join(" ") } : {}),
    env: last.env,
    expose: [...new Set(last.expose)],
    ...(last.workdir ? { workdir: last.workdir } : {}),
  };
}

/** Read and parse a Dockerfile; undefined when it cannot be read. */
export function readDockerfile(absRoot: string, rel: string): DockerfileFacts | undefined {
  try {
    const text = readFileSync(join(absRoot, rel), "utf8");
    if (text.length > 200_000) return undefined;
    return { dockerfile: rel, ...parseDockerfile(text) };
  } catch {
    return undefined;
  }
}

const SCRIPT_EXT = /\.(?:py|js|mjs|cjs|ts|rb|php|pl|sh|go|lua|jl|r|R)$/;
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".mjs", ".py", ".go", ".rb"];

/** The repository as `entryFileOf` reads it, by repo-relative path. */
export interface RepoFiles {
  exists(rel: string): boolean;
  read(rel: string): string | undefined;
}

/** The files under `absRoot`. */
export function repoFiles(absRoot: string): RepoFiles {
  return {
    exists: (rel) => existsSync(join(absRoot, rel)),
    read: (rel) => {
      try {
        return readFileSync(join(absRoot, rel), "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * The repository file a container's command starts, under its build
 * `context` (repo-relative, "" for the root).
 */
export function entryFileOf(command: string | undefined, context: string, repo: RepoFiles, depth = 0): string | undefined {
  if (!command || depth > 2) return undefined;
  const words = commandWords(command).filter((w) => !/^-{1,2}\w/.test(w) || /^-m$/.test(w));
  const under = (p: string) => posix.normalize(posix.join(context, p.replace(/^\/(?:app|usr\/src\/app|srv|code|workspace|opt\/app)\//, "").replace(/^\.\//, "")));
  const firstExisting = (cands: string[]) => cands.map(under).find((c) => !c.startsWith("..") && repo.exists(c));
  // `sh -c "node server.js"`: the script's own command.
  const shc = words.findIndex((w) => w === "-c");
  if (shc > 0 && words[shc + 1]) return entryFileOf(words.slice(shc + 1).join(" "), context, repo, depth + 1);
  // A package script: `npm start`, `npm run serve`, `yarn start`, `pnpm start`.
  const pm = /^(?:npm|yarn|pnpm)$/.test(words[0] ?? "") ? words.slice(1).filter((w) => w !== "run")[0] : undefined;
  if (pm) {
    try {
      const pkg = JSON.parse(repo.read(posix.join(context, "package.json")) ?? "{}") as { scripts?: Record<string, string>; main?: string };
      const script = pkg.scripts?.[pm];
      if (script) return entryFileOf(script, context, repo, depth + 1);
      if (pm === "start" && pkg.main) return firstExisting([pkg.main]);
    } catch {
      return undefined;
    }
    return undefined;
  }
  // A module: `python -m app.worker`, `uvicorn app.main:app`, `gunicorn shop.wsgi:application`, `flask --app app.web run`.
  const m = words.indexOf("-m");
  const moduleArg = m >= 0 ? words[m + 1] : /(?:^|\/)(?:uvicorn|gunicorn|hypercorn|daphne|celery)$/.test(words[0] ?? "") ? words.find((w, i) => i > 0 && /^[\w.]+(?::[\w.]+)?$/.test(w) && !/^(?:worker|beat|run|-)/.test(w)) : undefined;
  if (moduleArg && !/^(?:uvicorn|gunicorn|flask|celery|pytest)$/.test(moduleArg)) {
    const mod = moduleArg.split(":")[0]!.replace(/\./g, "/");
    return firstExisting([`${mod}.py`, `${mod}/__main__.py`, `${mod}/__init__.py`, `src/${mod}.py`]);
  }
  if (m >= 0 && /^(?:uvicorn|gunicorn|celery)$/.test(words[m + 1] ?? "")) {
    return entryFileOf(words.slice(m + 1).join(" "), context, repo, depth + 1);
  }
  // A script path: the first word that is a file.
  for (const w of words) {
    if (!SCRIPT_EXT.test(w) || w.startsWith("-")) continue;
    const direct = firstExisting([w]);
    if (direct) return direct;
    // Build output (`dist/server.js`, `build/index.js`) from checked-in source (`src/server.ts`).
    const built = /^(?:dist|build|out|lib)\/(.+)\.(?:m?js|cjs)$/.exec(w.replace(/^\/(?:app|usr\/src\/app|srv|code|workspace|opt\/app)\//, "").replace(/^\.\//, ""));
    if (built) {
      const found = firstExisting(SOURCE_EXTS.flatMap((e) => [`src/${built[1]}${e}`, `${built[1]}${e}`]));
      if (found) return found;
    }
  }
  return undefined;
}
