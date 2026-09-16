import type { ComponentLaunch, FileAnalysis, ScreenInfo, SymbolLink } from "../types/analysis.js";

/** Component files we treat as "launchable" UI — SFCs and JSX/TSX components. */
const COMPONENT_FILE_RE = /\.(vue|tsx|jsx)$/i;

/**
 * Derive "file opens component" relationships from the symbol-link table.
 *
 * The JS extractor records a dynamic `import("./X.vue")` inside a function body
 * as a cross-file call named `"default"`, so a symbol link with
 * `callName === "default"` whose target is a component file IS a launcher edge:
 * `launcherFn --opens--> component`. Launchers are commonly dialog-barrel
 * functions (`DutyDialog()`), so we also walk one hop back to every caller of
 * the launcher — those callers (screens/pages) are what a reader thinks of as
 * "opening" the dialog.
 *
 * Emits both the direct edge (launcher's own file → component) and the
 * transitive edges (each caller of the launcher → component), deduped per
 * (sourceFile, targetFile, launcher).
 */
export function buildComponentLaunches(symbolLinks: SymbolLink[]): ComponentLaunch[] {
  const launcherEdges = symbolLinks.filter(
    (l) => l.callName === "default" && COMPONENT_FILE_RE.test(l.targetFile),
  );
  if (launcherEdges.length === 0) return [];

  // Index every link by the (file::symbol) it points AT, so we can find the
  // callers of a launcher function in O(1).
  const callersOf = new Map<string, SymbolLink[]>();
  for (const l of symbolLinks) {
    const key = `${l.targetFile}::${l.targetSymbol}`;
    let arr = callersOf.get(key);
    if (!arr) callersOf.set(key, (arr = []));
    arr.push(l);
  }

  const out: ComponentLaunch[] = [];
  const seen = new Set<string>();
  const emit = (
    sourceFile: string,
    sourceSymbol: string,
    targetFile: string,
    launcher: string,
    line: number,
  ) => {
    if (sourceFile === targetFile) return; // a component opening itself is noise
    const key = `${sourceFile}\u0000${targetFile}\u0000${launcher}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ sourceFile, sourceSymbol, targetFile, launcher, line });
  };

  for (const le of launcherEdges) {
    // Direct: the launcher function's own file opens the component.
    emit(le.sourceFile, le.sourceSymbol, le.targetFile, le.sourceSymbol, le.sourceLine);
    // Transitive: every caller of the launcher opens the component too.
    for (const caller of callersOf.get(`${le.sourceFile}::${le.sourceSymbol}`) ?? []) {
      emit(caller.sourceFile, caller.sourceSymbol, le.targetFile, le.sourceSymbol, caller.sourceLine);
    }
  }

  return out;
}

// ─── Delphi form navigation ───────────────────────────────────────────────

/** Show methods that open a form that already exists as a global instance. */
const SHOW_METHODS = new Set(["show", "showmodal"]);

/** The synthetic symbol the Pascal extractor uses for unit-level code; it
 *  re-reports the calls of the real routines, so it is never the launcher. */
const SYNTHETIC_SYMBOL = "<setup>";

/**
 * Derive "form opens form" relationships for Delphi projects.
 *
 * A VCL app navigates by instantiating a form class and showing it — there is
 * no router and no import of the target, so neither the symbol linker nor the
 * dynamic-import launcher pass above sees any of it:
 *
 *     frmRedigerTiltag := TFTiltagRedigering.Create(Self);   // ← the edge
 *     if frmRedigerTiltag.ShowModal = mrOK then …
 *
 *     with TfrmClipboardDialog.Create(nil) do try ShowModal; finally Free; end;
 *
 *     frmWait.Show;                                          // global instance
 *
 * The `.dfm` is an authoritative registry for this: its root object declares
 * BOTH the form class (`object frmWait: TWaitForm` → class `TWaitForm`) and the
 * global instance variable (`frmWait`). So a `TWaitForm.Create` or a
 * `frmWait.Show` anywhere in the project names a specific screen file, with no
 * guessing — and `TpFIBQuery.Create` / `TFileStream.Create`, which outnumber the
 * form constructions, are excluded because they are not in the registry.
 *
 * Edges are reported between the SCREEN files (`.dfm`) so they land on the
 * screens the reader is looking at; a launcher in a unit with no form of its own
 * (a `ShowXDialog` helper) is reported against that unit instead.
 */
export function buildFormLaunches(
  analyses: FileAnalysis[],
  symbolLinks: SymbolLink[] = [],
): ComponentLaunch[] {
  const byClass = new Map<string, string>();    // TWaitForm      → WaitForm.dfm
  const byInstance = new Map<string, string>(); // frmWait        → WaitForm.dfm
  const screenOfUnit = new Map<string, string>(); // waitform      → WaitForm.dfm
  for (const a of analyses) {
    if (a.language !== "dfm") continue;
    const root = a.classes?.[0]?.name;
    if (root) {
      const key = root.toLowerCase();
      // A class declared by two forms is ambiguous — drop it rather than guess.
      byClass.set(key, byClass.has(key) ? "" : a.filePath);
    }
    const instance = a.exports?.find((e) => e.kind === "variable")?.name;
    if (instance) {
      const key = instance.toLowerCase();
      byInstance.set(key, byInstance.has(key) ? "" : a.filePath);
    }
    screenOfUnit.set(a.filePath.replace(/\.(dfm|lfm|fmx)$/i, "").toLowerCase(), a.filePath);
  }
  if (byClass.size === 0) return [];

  const out: ComponentLaunch[] = [];
  const seen = new Set<string>();
  const emit = (l: ComponentLaunch) => {
    const key = `${l.sourceFile} ${l.targetFile} ${l.launcher}`;
    if (l.sourceFile === l.targetFile || seen.has(key)) return;
    seen.add(key);
    out.push(l);
  };
  /** Routines that open the form declared by their own unit (see below). */
  const selfLaunchers: { file: string; routine: string; target: string }[] = [];

  for (const a of analyses) {
    if (a.language !== "pascal") continue;
    // Report the edge from this unit's own form, when it has one.
    const sourceFile =
      screenOfUnit.get(a.filePath.replace(/\.(pas|pp)$/i, "").toLowerCase()) ?? a.filePath;

    const routines = [
      ...(a.classes ?? []).flatMap((c) => c.methods ?? []),
      ...(a.functions ?? []),
    ];
    for (const routine of routines) {
      if (routine.name === SYNTHETIC_SYMBOL) continue;
      for (const call of routine.calls ?? []) {
        const dot = call.name.lastIndexOf(".");
        if (dot <= 0) continue;
        const receiver = call.name.slice(0, dot);
        const method = call.name.slice(dot + 1).toLowerCase();
        if (receiver.includes(".")) continue; // `DM.qry.Create` — not a bare class
        let target: string | undefined;
        if (method === "create") target = byClass.get(receiver.toLowerCase());
        else if (SHOW_METHODS.has(method)) target = byInstance.get(receiver.toLowerCase());
        if (!target) continue; // "" = a class two forms declare — ambiguous
        if (target === sourceFile) {
          // A routine constructing its OWN form is the `ShowPupilsWindow` /
          // `VisKlasser` dialog-opener idiom, not navigation. The screens that
          // navigate are its CALLERS, resolved one hop back below.
          selfLaunchers.push({ file: a.filePath, routine: routine.name, target });
          continue;
        }

        emit({
          sourceFile,
          sourceSymbol: routine.name,
          targetFile: target,
          launcher: routine.name,
          line: call.line,
        });
      }
    }
  }

  // One hop back: every screen that CALLS a dialog-opener opens that dialog.
  // Resolved through the symbol-link table rather than by routine name, so a
  // launcher called `Execute` attributes only to the callers the linker
  // actually resolved to it.
  if (selfLaunchers.length > 0 && symbolLinks.length > 0) {
    const callersOf = new Map<string, SymbolLink[]>();
    for (const l of symbolLinks) {
      const leaf = l.targetSymbol.split(".").pop() ?? l.targetSymbol;
      const key = `${l.targetFile}::${leaf.toLowerCase()}`;
      let arr = callersOf.get(key);
      if (!arr) callersOf.set(key, (arr = []));
      arr.push(l);
    }
    for (const sl of selfLaunchers) {
      for (const caller of callersOf.get(`${sl.file}::${sl.routine.toLowerCase()}`) ?? []) {
        emit({
          sourceFile:
            screenOfUnit.get(caller.sourceFile.replace(/\.(pas|pp)$/i, "").toLowerCase()) ??
            caller.sourceFile,
          // The link table attributes some calls to the unit-level bucket rather
          // than to a routine. The navigation is still real, so keep the edge —
          // but report the launcher, which names something that exists, instead
          // of a placeholder no reader or deep link can resolve.
          sourceSymbol: caller.sourceSymbol === SYNTHETIC_SYMBOL ? sl.routine : caller.sourceSymbol,
          targetFile: sl.target,
          launcher: sl.routine,
          line: caller.sourceLine,
        });
      }
    }
  }
  return out;
}

/**
 * Mark the application's main form, and the other forms it auto-creates.
 *
 * A Delphi project file says this explicitly, and in order:
 *
 *     program tea;
 *     begin
 *       Application.Initialize;
 *       Application.CreateForm(TMainForm, MainForm);   // ← the main form
 *       Application.CreateForm(TFProgress, FProgress); // ← auto-created
 *       Application.CreateForm(TDM, DM);               // ← a data module
 *       Application.Run;
 *     end.
 *
 * The FIRST `Application.CreateForm` is the main form: the window the user gets
 * on launch, which the IDE also writes back as the project's MainForm setting.
 * Later calls construct forms and data modules eagerly at startup, but the app
 * shows them on demand. Everything else is built later, in code.
 *
 * Reading this turns the screen graph from a flat list into something rooted —
 * the entry point is known, so "what can the user reach from startup" has an
 * answer. Data modules carry no screen and are simply not marked.
 *
 * Mutates the matching `ScreenInfo`s in place.
 */
export function markStartupScreens(
  analyses: FileAnalysis[],
  screens: ScreenInfo[],
  sources: ReadonlyMap<string, string>,
): void {
  const screenByFile = new Map<string, ScreenInfo>();
  for (const s of screens) if (s.filePath) screenByFile.set(s.filePath, s);

  // Form class → its screen file, from each .dfm's root object.
  const screenOfClass = new Map<string, string>();
  for (const a of analyses) {
    if (a.language !== "dfm") continue;
    const root = a.classes?.[0]?.name;
    if (!root) continue;
    const key = root.toLowerCase();
    screenOfClass.set(key, screenOfClass.has(key) ? "" : a.filePath);
  }
  if (screenOfClass.size === 0) return;

  for (const a of analyses) {
    if (!/\.(dpr|lpr)$/i.test(a.filePath)) continue;
    const source = sources.get(a.filePath);
    if (!source) continue;
    let first = true;
    for (const m of source.matchAll(/\bApplication\s*\.\s*CreateForm\s*\(\s*([A-Za-z_]\w*)/gi)) {
      const file = screenOfClass.get(m[1]!.toLowerCase());
      // "" is an ambiguous class; a data module has no .dfm screen at all.
      const screen = file ? screenByFile.get(file) : undefined;
      if (screen && !screen.startup) screen.startup = first ? "main" : "auto-created";
      // Only the first CreateForm can be the main form, whether or not it
      // resolved to a screen — a data module created first does not promote
      // the next form to main.
      first = false;
    }
  }
}
