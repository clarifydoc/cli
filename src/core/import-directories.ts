/**
 * The ONE project directory a package import names (Go, Rust, Ruby —
 * `importsNameDirectories`): the directory whose path ends with the longest
 * run of the import's trailing segments (`code.gitea.io/gitea/modules/setting`
 * → `modules/setting`, never `routers/web/repo/setting`). Anchored when two or
 * more segments agree, or the whole directory path does (a root-level
 * `handler/` under a module path); otherwise only a directory unique by name
 * in the importer's sub-project. A tie is no directory — fanning one import
 * out across same-named packages made a large Go graph ~4× its real size.
 */
export function buildImportDirectoryResolver(
  analyses: ReadonlyArray<{ filePath: string; projectId?: string }>,
): (source: string, fromFile: string) => string | null {
  const projectOf = new Map<string, string>();
  const firstFileOf = new Map<string, string>();
  const dirsByName = new Map<string, string[]>();
  for (const a of analyses) {
    if (a.projectId) projectOf.set(a.filePath, a.projectId);
    const slash = a.filePath.lastIndexOf("/");
    const dir = slash >= 0 ? a.filePath.slice(0, slash) : "";
    if (firstFileOf.has(dir)) continue;
    firstFileOf.set(dir, a.filePath);
    if (!dir) continue;
    const name = dir.slice(dir.lastIndexOf("/") + 1);
    (dirsByName.get(name) ?? dirsByName.set(name, []).get(name)!).push(dir);
  }
  const cache = new Map<string, string | null>();
  return (source, fromFile) => {
    const project = projectOf.get(fromFile) ?? "";
    const key = `${project}\0${source}`;
    if (cache.has(key)) return cache.get(key)!;
    const segs = source.split(/[/\\.:]+/).filter(Boolean);
    const dirs = dirsByName.get(segs[segs.length - 1] ?? "") ?? [];
    const scored = dirs.map((d) => {
      const dsegs = d.split("/");
      let k = 0;
      while (k < dsegs.length && k < segs.length && dsegs[dsegs.length - 1 - k] === segs[segs.length - 1 - k]) k++;
      return { d, k, anchored: k >= 2 || k === dsegs.length };
    });
    const projectOfDir = (d: string) => projectOf.get(firstFileOf.get(d)!) ?? "";
    const unique = (list: typeof scored): string | null => {
      if (list.length === 1) return list[0]!.d;
      const own = list.filter((c) => projectOfDir(c.d) === project);
      return own.length === 1 ? own[0]!.d : null;
    };
    const anchored = scored.filter((c) => c.anchored);
    let result: string | null;
    if (anchored.length > 0) {
      const best = Math.max(...anchored.map((c) => c.k));
      result = unique(anchored.filter((c) => c.k === best));
    } else {
      const own = scored.filter((c) => projectOfDir(c.d) === project);
      result = own.length === 1 ? own[0]!.d : null;
    }
    cache.set(key, result);
    return result;
  };
}
