import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { createHash } from "crypto";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { LSP_CONFIGS, networkOf } from "./lsp-configs.js";
import { dockerRunArgs, pingDockerSocket, resolveDockerEndpoint, type EndpointEnv } from "./docker-runner.js";

function files(map: Record<string, string>, env: Record<string, string> = {}, platform: NodeJS.Platform = "linux"): EndpointEnv {
  return { env, home: "/home/coach", platform, readText: (p) => map[p] };
}
const metaPath = (name: string): string => `/home/coach/.docker/contexts/meta/${createHash("sha256").update(name).digest("hex")}/meta.json`;

describe("resolveDockerEndpoint", () => {
  it("reads DOCKER_HOST first", () => {
    expect(resolveDockerEndpoint(files({}, { DOCKER_HOST: "unix:///run/club.sock" }))).toEqual({ kind: "socket", candidates: ["/run/club.sock"] });
    expect(resolveDockerEndpoint(files({}, { DOCKER_HOST: "tcp://10.0.0.5:2375" }))).toEqual({ kind: "other" });
    expect(resolveDockerEndpoint(files({}, { DOCKER_HOST: "ssh://coach@garage" }))).toEqual({ kind: "other" });
  });
  it("reads the current context's meta.json", () => {
    const map = {
      "/home/coach/.docker/config.json": JSON.stringify({ currentContext: "stadium" }),
      [metaPath("stadium")]: JSON.stringify({ Endpoints: { docker: { Host: "unix:///home/coach/.stadium/docker.sock" } } }),
    };
    expect(resolveDockerEndpoint(files(map))).toEqual({ kind: "socket", candidates: ["/home/coach/.stadium/docker.sock"] });
    expect(resolveDockerEndpoint(files(map, { DOCKER_CONTEXT: "pit" }))).toEqual({ kind: "other" });
    const remote = { ...map, [metaPath("stadium")]: JSON.stringify({ Endpoints: { docker: { Host: "tcp://garage:2376" } } }) };
    expect(resolveDockerEndpoint(files(remote))).toEqual({ kind: "other" });
  });
  it("falls back to the platform defaults", () => {
    expect(resolveDockerEndpoint(files({}))).toEqual({ kind: "socket", candidates: ["/var/run/docker.sock", "/home/coach/.docker/run/docker.sock"] });
    const dflt = { "/home/coach/.docker/config.json": JSON.stringify({ currentContext: "default" }) };
    expect(resolveDockerEndpoint(files(dflt)).kind).toBe("socket");
    expect(resolveDockerEndpoint(files({}, {}, "win32"))).toEqual({ kind: "socket", candidates: ["//./pipe/docker_engine"] });
  });
  it("leaves a broken config to the CLI", () => {
    expect(resolveDockerEndpoint(files({ "/home/coach/.docker/config.json": "{" }))).toEqual({ kind: "other" });
  });
});

describe("pingDockerSocket", () => {
  it("answers false at once for a missing socket, true for a daemon that says 200 and undefined for a silent one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ping-"));
    try {
      expect(await pingDockerSocket(join(dir, "none.sock"))).toBe(false);
      const path = join(dir, "d.sock");
      const server = createServer((c) => c.on("data", () => c.end("HTTP/1.1 200 OK\r\n\r\nOK")));
      await new Promise<void>((r) => server.listen(path, r));
      expect(await pingDockerSocket(path)).toBe(true);
      server.close();
      const mute = createServer(() => undefined);
      const mutePath = join(dir, "m.sock");
      await new Promise<void>((r) => mute.listen(mutePath, r));
      expect(await pingDockerSocket(mutePath, 100)).toBeUndefined();
      mute.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dockerRunArgs", () => {
  const base = { image: "club-lsp", command: [], projectRoot: "/work/club", mountPath: "/workspace" };
  it("adds --network none only when asked, before the mount", () => {
    const off = dockerRunArgs({ ...base, network: "none" }, "c1");
    expect(off.slice(off.indexOf("--network"), off.indexOf("--network") + 2)).toEqual(["--network", "none"]);
    expect(off.indexOf("--network")).toBeLessThan(off.indexOf("-v"));
    expect(dockerRunArgs(base, "c1")).not.toContain("--network");
    const bridge = dockerRunArgs({ ...base, network: "bridge" }, "c1");
    expect(bridge.slice(bridge.indexOf("--network"), bridge.indexOf("--network") + 2)).toEqual(["--network", "bridge"]);
  });
  it("mounts read-only unless readOnly is false and keeps the command last", () => {
    expect(dockerRunArgs(base, "c1")).toContain("/work/club:/workspace:ro");
    const rw = dockerRunArgs({ ...base, readOnly: false, command: ["serve", "--stdio"] }, "c1");
    expect(rw).toContain("/work/club:/workspace");
    expect(rw.slice(-3)).toEqual(["club-lsp", "serve", "--stdio"]);
  });
});

describe("networkOf", () => {
  const car = LSP_CONFIGS[0]!;
  it("defaults to none, a config can ask for bridge, the environment overrides both", () => {
    expect(networkOf(car, {})).toBe("none");
    expect(networkOf({ ...car, network: "bridge" }, {})).toBe("bridge");
    expect(networkOf({ ...car, network: "bridge" }, { CLARIFYDOC_LSP_NETWORK: "none" })).toBe("none");
    expect(networkOf(car, { CLARIFYDOC_LSP_NETWORK: "bridge" })).toBe("bridge");
    expect(networkOf(car, { CLARIFYDOC_LSP_NETWORK: " Bridge " })).toBe("bridge");
    expect(networkOf(car, { CLARIFYDOC_LSP_NETWORK: "host" })).toBe("none");
    expect(LSP_CONFIGS.filter((c) => networkOf(c, {}) === "bridge").map((c) => c.id)).toEqual(["java", "dotnet"]);
  });
});
