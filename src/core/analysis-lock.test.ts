import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat, utimes } from "fs/promises";
import { tmpdir } from "os";
import { hostname } from "os";
import { join } from "path";
import {
  acquireAnalysisLock,
  currentLockHolder,
  readLockOwner,
  lockPath,
  waitFor,
} from "./analysis-lock.js";
import { ensureSelfIgnored } from "./output-writer.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clarifydoc-lock-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("analysis lock", () => {
  it("lets one holder in and turns the second away", async () => {
    const first = await acquireAnalysisLock(dir, "analyze");
    expect(first).not.toBeNull();

    const second = await acquireAnalysisLock(dir, "analyze");
    expect(second).toBeNull();

    await first!.release();
    const third = await acquireAnalysisLock(dir, "analyze");
    expect(third).not.toBeNull();
    await third!.release();
  });

  it("records who holds it, so the message can name the run", async () => {
    const lock = await acquireAnalysisLock(dir, "analyze");
    const owner = await readLockOwner(dir);
    expect(owner?.pid).toBe(process.pid);
    expect(owner?.host).toBe(hostname());
    expect(owner?.label).toBe("analyze");
    await lock!.release();
    expect(await readLockOwner(dir)).toBeNull();
  });

  it("steals a lock whose owning process is gone", async () => {
    // pid 1 exists but is not ours; use an implausible pid on this host instead.
    await writeFile(
      lockPath(dir),
      JSON.stringify({ pid: 0x7ffffff0, host: hostname(), startedAt: new Date().toISOString() }),
    );
    expect(await currentLockHolder(dir)).toBeNull();

    const lock = await acquireAnalysisLock(dir);
    expect(lock).not.toBeNull();
    expect((await readLockOwner(dir))?.pid).toBe(process.pid);
    await lock!.release();
  });

  it("steals a lock whose heartbeat stopped, even from an unknown host", async () => {
    await writeFile(
      lockPath(dir),
      JSON.stringify({ pid: 1, host: "some-other-machine", startedAt: new Date().toISOString() }),
    );
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath(dir), old, old);

    expect(await currentLockHolder(dir)).toBeNull();
    const lock = await acquireAnalysisLock(dir);
    expect(lock).not.toBeNull();
    await lock!.release();
  });

  it("keeps a live foreign lock, whose heartbeat is fresh", async () => {
    await writeFile(
      lockPath(dir),
      JSON.stringify({ pid: 1, host: "some-other-machine", startedAt: new Date().toISOString() }),
    );
    const holder = await currentLockHolder(dir);
    expect(holder?.host).toBe("some-other-machine");
    expect(await acquireAnalysisLock(dir)).toBeNull();
  });

  it("release is idempotent", async () => {
    const lock = await acquireAnalysisLock(dir);
    await lock!.release();
    await lock!.release();
    expect(await currentLockHolder(dir)).toBeNull();
  });

  it("waitFor resolves true when the condition arrives and false on timeout", async () => {
    let ready = false;
    setTimeout(() => (ready = true), 60);
    expect(await waitFor(async () => ready, 2_000, 20)).toBe(true);
    expect(await waitFor(async () => false, 60, 20)).toBe(false);
  });
});

describe("self-ignoring analysis directory", () => {
  it("ignores itself when the analysis lives inside the project", async () => {
    const out = join(dir, ".clarifydoc", "proj");
    await ensureSelfIgnored(out, dir);
    const body = await readFile(join(out, ".gitignore"), "utf-8");
    expect(body).toMatch(/^\*$/m);
  });

  it("never overwrites the marker, so emptying it opts into committing", async () => {
    const out = join(dir, ".clarifydoc", "proj");
    await ensureSelfIgnored(out, dir);
    await writeFile(join(out, ".gitignore"), "", "utf-8");
    await ensureSelfIgnored(out, dir);
    expect((await stat(join(out, ".gitignore"))).size).toBe(0);
  });

  it("writes nothing when the analysis lives outside the project", async () => {
    const outside = await mkdtemp(join(tmpdir(), "clarifydoc-out-"));
    try {
      await ensureSelfIgnored(outside, dir);
      await expect(stat(join(outside, ".gitignore"))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
