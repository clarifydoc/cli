import { spawn, type ChildProcess } from "child_process";
import { Readable, Writable } from "stream";

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

/**
 * Check if Docker is available and running.
 */
export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["info"], {
      stdio: ["ignore", "ignore", "ignore"],
      shell: true,
    });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Check if a Docker image exists locally.
 */
export async function imageExists(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["image", "inspect", image], {
      stdio: ["ignore", "ignore", "ignore"],
      shell: true,
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
      shell: true,
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
  const containerName = opts.name ?? `reversedoc-lsp-${Date.now()}`;

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
      shell: true,
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
 * Stop all containers with the reversedoc-lsp prefix.
 * Used for cleanup on unexpected exit.
 */
export async function stopAllContainers(): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn(
      "docker",
      ["ps", "-q", "--filter", "name=reversedoc-lsp-"],
      { stdio: ["ignore", "pipe", "ignore"], shell: true },
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
        shell: true,
      });
      killProc.on("close", () => resolve());
      killProc.on("error", () => resolve());
    });

    proc.on("error", () => resolve());
  });
}
