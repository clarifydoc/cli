import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/** Django's manage.py, pytest or tox configuration, a PEP 517 build backend. */
export function pythonProjectCommands(root: ProjectRootView): ProjectCommand[] {
  const pyproject = root.read("pyproject.toml") ?? "";
  const has = (f: string) => root.entries.includes(f);
  if (!pyproject && !has("setup.py") && !has("setup.cfg") && !has("requirements.txt") && !has("manage.py")) return [];
  const out: ProjectCommand[] = [];
  if (/^\[build-system\]/m.test(pyproject)) out.push({ kind: "build", command: "python -m build", source: "pyproject.toml [build-system]" });
  if (has("tox.ini")) out.push({ kind: "test", command: "tox", source: "tox.ini" });
  else if (has("pytest.ini") || /^\[tool\.pytest/m.test(pyproject) || /\bpytest\b/.test(root.read("requirements-dev.txt") ?? "") || /\bpytest\b/.test(root.read("setup.cfg") ?? "") || /\bpytest\b/.test(pyproject)) {
    out.push({ kind: "test", command: "pytest", source: has("pytest.ini") ? "pytest.ini" : "pyproject.toml" });
  } else if (has("manage.py")) out.push({ kind: "test", command: "python manage.py test", source: "manage.py" });
  if (has("manage.py")) out.push({ kind: "start", command: "python manage.py runserver", source: "manage.py" });
  return out;
}
