import { spawn, type ChildProcess } from "child_process";
import { Readable, Writable } from "stream";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { connect } from "net";
import { homedir } from "os";

// Every docker call spawns the binary directly, never through a shell: `docker`
// is a real executable on every platform, a shell would only concatenate the
// args unescaped (Node 24 warns about it, and a project path with a space
// would break the `-v` mount), and a missing binary still surfaces as the
// 'error' event the callers already handle.

export interface DockerContainerOptions {
  image: string;
  command: string[];
  projectRoot: string;
  mountPath: string;
  name?: string;
  readOnly?: boolean;
}

export interface DockerContainer {
  process: ChildProcess;
  stdin: Writable;
  stdout: Readable;
  name: string;
}

/** How long a socket `GET /_ping` may take before the daemon counts as absent. */
const PING_TIMEOUT_MS = 500;
/** The bound on `docker info` for an endpoint a socket cannot answer for (tcp, ssh, unknown). */
const INFO_TIMEOUT_MS = 1500;

/** Where the CLI would send a request: sockets we can ping, or `other` (tcp, ssh, unknown) that only the CLI can judge. */
export type DockerEndpoint = { kind: "socket"; candidates: string[] } | { kind: "other" };

export interface EndpointEnv {
  env: Record<string, string | undefined>;
  home: string;
  platform: NodeJS.Platform;
  readText: (path: string) => string | undefined;
}

/** A `unix://` or `npipe://` URL as the socket path it names; undefined for anything else. */
function socketPathOf(host: string): string | undefined {
  if (host.startsWith("unix://")) return host.slice("unix://".length) || undefined;
  if (host.startsWith("npipe://")) return host.slice("npipe://".length) || undefined;
  return undefined;
}

/**
 * The endpoint the Docker CLI would use, read the way it reads it: `DOCKER_HOST`, else the context
 * (`DOCKER_CONTEXT`, else `currentContext` of `config.json`) and its `meta.json`, else the platform's sockets.
 */
export function resolveDockerEndpoint(ctx: EndpointEnv): DockerEndpoint {
  const { env, home, platform, readText } = ctx;
  const defaults = (): DockerEndpoint => ({
    kind: "socket",
    candidates:
      platform === "win32"
        ? ["//./pipe/docker_engine"]
        : ["/var/run/docker.sock", `${home}/.docker/run/docker.sock`],
  });
  const fromHost = (host: string): DockerEndpoint => {
    const socket = socketPathOf(host.trim());
    return socket ? { kind: "socket", candidates: [socket] } : { kind: "other" };
  };
  if (env.DOCKER_HOST?.trim()) return fromHost(env.DOCKER_HOST);

  const configDir = env.DOCKER_CONFIG?.trim() || `${home}/.docker`;
  let name = env.DOCKER_CONTEXT?.trim();
  if (!name) {
    const raw = readText(`${configDir}/config.json`);
    if (raw) {
      try {
        const current = (JSON.parse(raw) as { currentContext?: unknown }).currentContext;
        if (typeof current === "string") name = current;
      } catch {
        return { kind: "other" };
      }
    }
  }
  if (!name || name === "default") return defaults();

  const metaRaw = readText(`${configDir}/contexts/meta/${createHash("sha256").update(name).digest("hex")}/meta.json`);
  if (!metaRaw) return { kind: "other" };
  try {
    const host = (JSON.parse(metaRaw) as { Endpoints?: { docker?: { Host?: unknown } } }).Endpoints?.docker?.Host;
    if (typeof host !== "string" || !host) return defaults();
    return fromHost(host);
  } catch {
    return { kind: "other" };
  }
}

/** `GET /_ping` on one socket: true when the daemon answers 200 within the timeout; false at once on a refused or missing socket. */
export function pingDockerSocket(path: string, timeoutMs = PING_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const sock = connect({ path });
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    let head = "";
    sock.on("connect", () => sock.write("GET /_ping HTTP/1.0\r\nHost: docker\r\n\r\n"));
    sock.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (head.includes("\r\n")) done(/^HTTP\/1\.[01] 200\b/.test(head));
    });
    sock.on("error", () => done(false));
    sock.on("close", () => done(false));
  });
}

/** The CLI's own judgment, bounded: for an endpoint only it can reach (a remote daemon may never answer). */
function dockerInfoBounded(timeoutMs = INFO_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["info"], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      proc.kill();
      resolve(false);
    }, timeoutMs);
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function readTextOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Check if Docker is available and running: a socket ping when the endpoint is a local socket (a stopped
 * daemon answers at once), a bounded `docker info` otherwise.
 */
export async function isDockerAvailable(): Promise<boolean> {
  const endpoint = resolveDockerEndpoint({ env: process.env, home: homedir(), platform: process.platform, readText: readTextOrUndefined });
  if (endpoint.kind === "other") return dockerInfoBounded();
  for (const path of endpoint.candidates) if (await pingDockerSocket(path)) return true;
  return false;
}

/**
 * Check if a Docker image exists locally.
 */
export async function imageExists(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["image", "inspect", image], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Build a Docker image from a Dockerfile directory.
 */
export async function buildImage(
  dockerfilePath: string,
  imageName: string,
  verbose: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["build", "-t", imageName, dockerfilePath];
    const proc = spawn("docker", args, {
      stdio: verbose ? ["ignore", "inherit", "inherit"] : ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    if (!verbose && proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }

    proc.on("error", (err) => reject(new Error(`Failed to spawn docker build: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Docker build failed for ${imageName} (exit ${code})${stderr ? `: ${stderr.slice(0, 500)}` : ""}`));
    });
  });
}

/**
 * Start a Docker container for an LSP server.
 * The container runs interactively (-i) so we can communicate over stdin/stdout.
 */
export function startContainer(opts: DockerContainerOptions): DockerContainer {
  const containerName = opts.name ?? `clarifydoc-lsp-${Date.now()}`;

  // Normalize the project root path for Docker volume mounting
  // On Windows, convert C:\path to /c/path for Docker
  let mountSource = opts.projectRoot.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(mountSource)) {
    mountSource = `/${mountSource[0]!.toLowerCase()}${mountSource.slice(2)}`;
  }

  const args = [
    "run",
    "--rm",
    "-i",
    "--name", containerName,
    "-v", `${mountSource}:${opts.mountPath}${opts.readOnly !== false ? ":ro" : ""}`,
    "-w", opts.mountPath,
    opts.image,
    ...opts.command,
  ];

  const proc = spawn("docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!proc.stdin || !proc.stdout) {
    proc.kill();
    throw new Error(`Failed to start container ${containerName}: no stdio streams`);
  }

  return {
    process: proc,
    stdin: proc.stdin,
    stdout: proc.stdout,
    name: containerName,
  };
}

/**
 * Stop a running Docker container.
 */
export async function stopContainer(container: DockerContainer): Promise<void> {
  return new Promise((resolve) => {
    // Try graceful kill first
    const killProc = spawn("docker", ["kill", container.name], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    killProc.on("close", () => resolve());
    killProc.on("error", () => resolve());

    // Fallback: kill the process directly after timeout
    setTimeout(() => {
      try {
        container.process.kill("SIGKILL");
      } catch {
        // Process may already be dead
      }
      resolve();
    }, 5000);
  });
}

/**
 * Stop all containers with the clarifydoc-lsp prefix.
 * Used for cleanup on unexpected exit.
 */
export async function stopAllContainers(): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn(
      "docker",
      ["ps", "-q", "--filter", "name=clarifydoc-lsp-"],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );

    let output = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("close", () => {
      const ids = output.trim().split("\n").filter(Boolean);
      if (ids.length === 0) {
        resolve();
        return;
      }

      const killProc = spawn("docker", ["kill", ...ids], {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      killProc.on("close", () => resolve());
      killProc.on("error", () => resolve());
    });

    proc.on("error", () => resolve());
  });
}
