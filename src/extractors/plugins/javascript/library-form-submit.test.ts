import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A form library's submit handed to an event runs the `onSubmit` the hook call writes (real-repo FP):
 * `<form onSubmit={formik.handleSubmit}>`, a destructured `handleSubmit`, and `formik.submitForm()` in a click.
 * Decoys: a project hook named `useFormik`, a method no option runs (`handleChange`), and a member of a plain local
 * object handed to an event, which stays a handed-on reference.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { react: "^18.3.0", formik: "^2.4.0" } }),
  "src/api.ts": `export const renameClub = (name: string) => fetch("/api/clubs", { method: "PUT", body: name });
export const transferPlayer = (id: string) => fetch("/api/players/transfer", { method: "POST", body: id });
export const signCoach = (name: string) => fetch("/api/coaches", { method: "POST", body: name });
export const saveGarage = (name: string) => fetch("/api/garages", { method: "POST", body: name });
`,
  "src/RenameClubForm.tsx": `import { useFormik } from "formik";
import { renameClub } from "./api";
export function RenameClubForm() {
  const formik = useFormik({ initialValues: { name: "" }, onSubmit: async (values) => { await renameClub(values.name); } });
  return (
    <form onSubmit={formik.handleSubmit}>
      <input name="name" onChange={formik.handleChange} value={formik.values.name} />
    </form>
  );
}
`,
  "src/TransferForm.tsx": `import { useFormik } from "formik";
import { transferPlayer } from "./api";
export function TransferForm() {
  const submitTransfer = async (values: { id: string }) => { await transferPlayer(values.id); };
  const { handleSubmit, values } = useFormik({ initialValues: { id: "" }, onSubmit: submitTransfer });
  return <form onSubmit={handleSubmit}><input value={values.id} readOnly /></form>;
}
`,
  "src/CoachForm.tsx": `import { useFormik } from "formik";
import { signCoach } from "./api";
export function CoachForm() {
  const formik = useFormik({ initialValues: { name: "" }, onSubmit: (values) => signCoach(values.name) });
  return <button onClick={() => formik.submitForm()}>Sign</button>;
}
`,
  "src/forms.ts": `export function useFormik(options: { onSubmit: (v: { name: string }) => void }) {
  return { handleSubmit: () => {} };
}
`,
  "src/GarageForm.tsx": `import { useFormik } from "./forms";
import { saveGarage } from "./api";
export function GarageForm() {
  const formik = useFormik({ onSubmit: (v) => saveGarage(v.name) });
  const pit = { stop: () => saveGarage("pit") };
  return <form onSubmit={formik.handleSubmit}><button onClick={pit.stop}>Stop</button></form>;
}
`,
};

const linksFrom = (s: ProjectAnalysis, file: string): string[] =>
  (s.symbolLinks ?? [])
    .filter((l) => l.sourceFile === file && l.strategy !== "reference")
    .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol}`);

describe("a form library's submit handed to an event", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-library-form-submit-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs onSubmit from handleSubmit handed to the form, a destructured handleSubmit and submitForm()", () => {
    expect(linksFrom(summary, "src/RenameClubForm.tsx")).toContain("RenameClubForm -formik.handleSubmit-> src/RenameClubForm.tsx#<useFormik:onSubmit@4>");
    expect(linksFrom(summary, "src/TransferForm.tsx")).toContain("TransferForm -handleSubmit.handleSubmit-> src/TransferForm.tsx#submitTransfer");
    expect(linksFrom(summary, "src/CoachForm.tsx")).toContain("CoachForm -formik.submitForm-> src/CoachForm.tsx#<useFormik:onSubmit@4>");
  });

  it("runs nothing for a method no option runs", () => {
    expect(linksFrom(summary, "src/RenameClubForm.tsx").filter((r) => r.includes("handleChange"))).toEqual([]);
  });

  it("never reads a project hook named like the factory as the library's, and keeps a plain object's member a reference", () => {
    const rows = linksFrom(summary, "src/GarageForm.tsx");
    expect(rows.filter((r) => r.includes("handleSubmit"))).toEqual([]);
    expect(rows.filter((r) => r.includes("<useFormik:"))).toEqual([]);
  });
});
