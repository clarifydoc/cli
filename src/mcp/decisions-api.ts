/**
 * The decisions about one file as data, for a host that is not an MCP client
 * (an editor hover): the same documents, staleness and markers the
 * clarifydoc_context_docs tool prints, from the same functions.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { AnalysisStore } from "./store.js";
import { contextIndex, decisionsOfFile } from "./tools/decisions.js";
import type { ContextDoc, DecisionMarker, DocStaleness } from "../core/context-docs.js";

export interface FileDecisions {
  /** Documents that name the file, each with whether what they name changed after them. */
  docs: Array<ContextDoc & { staleness?: DocStaleness }>;
  /** `WHY:` / `DECISION:` … comments in the file's source. */
  markers: DecisionMarker[];
}

const stores = new Map<string, AnalysisStore>();

/**
 * The decision records, context documents and decision markers that concern
 * `file` (project-relative, posix) of the analysis in `analysisDir`. Read-only:
 * never starts an analysis. The context index is reused for 30 s per loaded
 * analysis, like the MCP tool's. Undefined when there is no analysis.
 */
export async function decisionsAbout(projectRoot: string, analysisDir: string, file: string): Promise<FileDecisions | undefined> {
  const key = `${projectRoot}\\0${analysisDir}`;
  let store = stores.get(key);
  if (!store) stores.set(key, (store = new AnalysisStore({ projectRoot, analysisDir, allowAnalyze: false, allowColdStart: false })));
  const loaded = await store.load().catch(() => undefined);
  if (!loaded) return undefined;
  const index = await contextIndex(store, loaded);
  const source = await readFile(join(projectRoot, file), "utf8").catch(() => "");
  const { docs, markers } = decisionsOfFile(index, file, source);
  return { docs: docs.map((d) => ({ ...d, staleness: index.staleness.get(d.path) })), markers };
}
