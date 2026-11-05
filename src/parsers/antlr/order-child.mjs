// Child process of order.test.ts: reads the files named in a JSON job, in the order given, with the plugin readers
// the analysis uses, and prints each file's reading as JSON on stdout. A fresh process starts with the grammars'
// prediction caches empty, which is the point. The TypeScript sources load through Vite's SSR loader, so nothing
// depends on dist/.
import { readFileSync } from "node:fs";
import { createServer } from "vite";

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
const root = new URL("../../..", import.meta.url).pathname;
const server = await createServer({ root, logLevel: "silent", server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true } });
try {
  const readers = {};
  for (const [lang, spec] of Object.entries(job.readers)) readers[lang] = (await server.ssrLoadModule(spec.module))[spec.export];
  const out = {};
  for (const { path, lang } of job.files) {
    const parsed = readers[lang](readFileSync(path, "utf8"));
    out[path] = parsed;
  }
  process.stdout.write(JSON.stringify(out));
} finally {
  await server.close();
}
