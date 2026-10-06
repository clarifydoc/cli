import { open, readdir, readFile } from "fs/promises";
import { join } from "path";

/**
 * Executable scripts with no extension — Express's `bin/www`, a repo's
 * `perf/run-benchmarks` — whose `#!` line names an interpreter. Discovery
 * globs by extension, so they are never analyzed, yet they import the code
 * beside them: without them that code looks unreachable. Reachability models
 * read them for that one fact.
 *
 * Bounded: only the given directories (where the language's files live), only
 * regular extension-less files (no links, no dotfiles), names that do not look
 * like credentials, and the first bytes are checked for `#!` before a file is
 * read whole.
 */
export async function findShebangScripts(
  projectRoot: string,
  dirs: Iterable<string>,
  interpreter: RegExp,
): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = [];
  for (const dir of new Set(dirs)) {
    let entries: import("fs").Dirent[];
    try {
      entries = await readdir(join(projectRoot, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || e.name.includes(".") || CREDENTIAL_NAME_RE.test(e.name)) continue;
      const abs = join(projectRoot, dir, e.name);
      const head = await readHead(abs, 128);
      const firstLine = head?.split("\n")[0] ?? "";
      if (!firstLine.startsWith("#!") || !interpreter.test(firstLine)) continue;
      const text = await readFile(abs, "utf-8").catch(() => null);
      if (text !== null && text.length <= MAX_SCRIPT_BYTES) out.push({ path: dir ? `${dir}/${e.name}` : e.name, text });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Where extension-less scripts live besides the code's own directories. */
export const SCRIPT_DIRS: readonly string[] = ["bin", "scripts", "tools"];

const MAX_SCRIPT_BYTES = 512 * 1024;
const CREDENTIAL_NAME_RE = /^id_|key|secret|token|passw|credential|htpasswd/i;

async function readHead(path: string, bytes: number): Promise<string | null> {
  let fh: import("fs/promises").FileHandle | undefined;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
