/** Node's built-in modules, imported by bare name (`assert`, `fs/promises`) or with `node:`. */
export const NODE_BUILTINS: ReadonlySet<string> = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https",
  "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty",
  "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib", "test",
]);

/**
 * The project file a JS/TS import names, where the generic path rules would
 * guess: a Node built-in (`import assert from "assert"`, `require("fs/promises")`,
 * `node:path`) is never the project's `assert.js` or `util.ts`, whatever a
 * basename match finds. Undefined for everything else (the generic rules decide).
 */
export function jsImportedFile(_importingFile: string, source: string): null | undefined {
  if (source.startsWith("node:")) return null;
  const root = source.split("/")[0]!;
  return NODE_BUILTINS.has(root) ? null : undefined;
}
