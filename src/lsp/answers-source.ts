import { readFile } from "fs/promises";
import type { DefinitionClient, DefinitionSource } from "./lsp-enhancer.js";
import type { DefinitionResult } from "./lsp-client.js";

/**
 * Definition answers computed outside this process — by an editor that
 * already runs the project's language servers — for the questions
 * `planDefinitionQueries` listed (`lsp-update --emit-queries`). Lines are
 * 1-based and columns 0-based, as in the queries; paths are project-relative.
 */
export interface DefinitionAnswerFile {
  /** Who answered, recorded as `lspStats.source` (`editor`). */
  source: string;
  /** The servers that answered, recorded as `lspStats.serversUsed`. */
  servers?: string[];
  answers: DefinitionAnswer[];
}

export interface DefinitionAnswer {
  file: string;
  line: number;
  column: number;
  /** Every location the server gave; empty when it gave none. */
  targets: Array<{ file: string; line: number }>;
}

/** A project-relative posix path that stays inside the project. */
function insideProject(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.includes("\\") && !p.split("/").includes("..");
}

const isLine = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1;

/** Reads and checks an answers file; malformed rows are dropped, never trusted. */
export async function readDefinitionAnswers(path: string): Promise<DefinitionAnswerFile> {
  const raw = JSON.parse(await readFile(path, "utf-8")) as Partial<DefinitionAnswerFile>;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.answers)) throw new Error(`${path}: expected { source, answers: [...] }`);
  const answers: DefinitionAnswer[] = [];
  for (const a of raw.answers) {
    if (!a || !insideProject(a.file) || !isLine(a.line) || typeof a.column !== "number" || a.column < 0 || !Array.isArray(a.targets)) continue;
    answers.push({
      file: a.file,
      line: a.line,
      column: a.column,
      targets: a.targets.filter((t) => t && insideProject(t.file) && isLine(t.line)).map((t) => ({ file: t.file, line: t.line })),
    });
  }
  return {
    source: typeof raw.source === "string" && /^[\w.-]{1,40}$/.test(raw.source) ? raw.source : "external",
    ...(Array.isArray(raw.servers) ? { servers: raw.servers.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, 80)).slice(0, 50) } : {}),
    answers,
  };
}

/**
 * A definition source that replays answers. A question with more than one
 * distinct target is abstained on — the editor's providers can disagree (two
 * extensions for one language, an overload set), and layer 2 only adds links
 * it can stand behind. A question that was never put (the editor's budget ran
 * out) is skipped, not counted as a miss. There are no reference answers, so
 * Phase B does not run.
 */
export function answersDefinitionSource(file: DefinitionAnswerFile): DefinitionSource & { abstained(): number } {
  const byPos = new Map<string, DefinitionAnswer>();
  for (const a of file.answers) byPos.set(`${a.file}:${a.line}:${a.column}`, a);
  let abstained = 0;
  const client: DefinitionClient = {
    supportsReferences: false,
    asked: (f, line, col) => byPos.has(`${f}:${line + 1}:${col}`),
    async getDefinition(f, line, col): Promise<DefinitionResult[]> {
      const a = byPos.get(`${f}:${line + 1}:${col}`);
      if (!a || a.targets.length === 0) return [];
      const distinct = new Map(a.targets.map((t) => [`${t.file}:${t.line}`, t]));
      if (distinct.size > 1) {
        abstained++;
        return [];
      }
      const t = [...distinct.values()][0]!;
      return [{ uri: t.file, line: t.line - 1, character: 0 }];
    },
    getReferences: async () => [],
  };
  return {
    kind: file.source,
    initialize: async () => (file.answers.length ? (file.servers?.length ? file.servers : [file.source]) : []),
    clientFor: () => client,
    shutdown: async () => {},
    abstained: () => abstained,
  };
}
