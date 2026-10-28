import { describe, it, expect } from "vitest";
import { pythonStandardImport } from "./standard-library.js";

const files = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

describe("pythonStandardImport", () => {
  it("reads a standard module as the library's beside a package module of that name", () => {
    const has = files("league/__init__.py", "league/types.py", "league/club.py");
    expect(pythonStandardImport("league/club.py", "types", has)).toBe(true);
    expect(pythonStandardImport("league/club.py", "xml.etree.ElementTree", has)).toBe(true);
  });

  it("leaves a top-level project module that shadows it to the project", () => {
    // A Django app beside manage.py: the project root is on sys.path first.
    const app = files("backend/manage.py", "backend/calendar/__init__.py", "backend/fixtures/__init__.py", "backend/fixtures/views.py");
    expect(pythonStandardImport("backend/fixtures/views.py", "calendar.models", app)).toBe(false);
    // A script directory (no `__init__.py`): the module beside the script.
    const scripts = files("tools/run.py", "tools/queue.py");
    expect(pythonStandardImport("tools/run.py", "queue", scripts)).toBe(false);
  });

  it("never claims a relative import or a third-party package", () => {
    const has = files("league/__init__.py");
    expect(pythonStandardImport("league/club.py", ".types", has)).toBe(false);
    expect(pythonStandardImport("league/club.py", "pydantic", has)).toBe(false);
  });
});
