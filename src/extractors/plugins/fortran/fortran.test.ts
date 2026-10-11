import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { pluginFor } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { isFixedForm, normalizeFortran } from "./source.js";

/** Through the plugin's preprocess, as the analyzer runs it. */
function analyze(src: string, path = "src/solver.f90"): FileAnalysis {
  const pre = pluginFor("fortran")!.preprocess!(src, path);
  const p = pre && "sourceText" in pre ? pre : null;
  const analysis = extractWithRegex(p?.sourceText ?? src, path, "fortran");
  p?.postExtract?.(analysis, src);
  return analysis;
}
const fn = (a: FileAnalysis, name: string) => a.functions.find((f) => f.name === name);
const calls = (a: FileAnalysis, name: string) => fn(a, name)?.calls.map((c) => c.name) ?? [];

describe("Fortran source forms", () => {
  it("joins fixed-form continuations, drops comments and the sequence area, keeping every line", () => {
    const lines = [
      "C     comment: CALL NEVER",
      "*     another",
      "      SUBROUTINE AXPY(N, A,",
      "     &                X, Y)",
      // Columns 73-80: the card sequence number.
      "      CALL SCALE(X)".padEnd(72) + "SEQ00010",
      "   10 CONTINUE",
      "\tCALL TABBED(Y)",
      "      END",
    ];
    const out = normalizeFortran(lines, isFixedForm("blas/axpy.f", lines));
    expect(out).toEqual([
      "", "", "      SUBROUTINE AXPY(N, A, X, Y)", "", "      CALL SCALE(X)", "      CONTINUE", "      CALL TABBED(Y)", "      END",
    ]);
  });

  it("joins free-form `&` continuations and drops `!` comments outside strings", () => {
    const lines = ["x = f(a, &   ! first", "    ! between", "     & b) ! done", "print *, 'not ! a comment'"];
    expect(normalizeFortran(lines, false)).toEqual(["x = f(a, b)", "", "", "print *, 'not ! a comment'"]);
  });

  it("reads a fixed-form extension holding free-form code as free form", () => {
    expect(isFixedForm("legacy/a.f", ["      PROGRAM A", "      END"])).toBe(true);
    expect(isFixedForm("modern/b.f", ["program b", "  implicit none", "end program"])).toBe(false);
    expect(isFixedForm("modern/c.F90", ["      PROGRAM C"])).toBe(false);
  });
});

describe("Fortran program units", () => {
  const a = analyze([
    "module solvers",
    "  use iso_fortran_env, only: dp => real64",
    "  implicit none",
    "  private",
    "  public :: solve, norm",
    "  interface",
    "    real(dp) function kernel(x)",
    "      real(dp), intent(in) :: x",
    "    end function kernel",
    "  end interface",
    "contains",
    "  subroutine solve(n, x)",
    "    integer, intent(in) :: n",
    "    real(dp), intent(inout) :: x(n)",
    "    integer :: i",
    "    do i = 1, n",
    "      x(i) = kernel(x(i)) + norm(x)",
    "    end do",
    "    if (n > 0) call report(n)",
    "  contains",
    "    subroutine report(k)",
    "      integer :: k",
    "      print *, k",
    "    end subroutine report",
    "  end subroutine solve",
    "  pure real(dp) function norm(v) result(r)",
    "    real(dp), intent(in) :: v(:)",
    "    r = sqrt(sum(v**2))",
    "  endfunction norm",
    "  recursive function fact(n) result(f)",
    "    integer :: n, f",
    "    f = 1",
    "    if (n > 1) f = n * fact(n - 1)",
    "  end function",
    "end module solvers",
  ].join("\n"));

  it("reads module, internal and recursive procedures — never interface declarations", () => {
    expect(a.functions.map((f) => [f.name, f.isExported, f.returnType, f.line, f.endLine])).toEqual([
      ["solve", true, null, 12, 25], ["report", false, null, 21, 24], ["norm", true, "real(dp)", 26, 29], ["fact", false, "integer", 30, 34],
    ]);
    expect(fn(a, "solve")!.params).toEqual([
      { name: "n", type: "integer", defaultValue: null }, { name: "x", type: "real(dp)", defaultValue: null },
    ]);
    expect(fn(a, "norm")!.decorators).toEqual(["pure"]);
  });

  it("reads calls and proven function references — never array elements or intrinsics", () => {
    // `x(i)` is an array element; `kernel` an interface's function; `norm` the module's.
    expect(calls(a, "solve")).toEqual(["kernel", "norm", "report"]);
    expect(calls(a, "norm")).toEqual([]);
    // A recursive function's reference to itself is a call.
    expect(calls(a, "fact")).toEqual(["fact"]);
  });

  it("reads use statements with their only-list", () => {
    expect(a.imports.map((i) => `${i.source}[${i.specifiers}]`)).toEqual(["iso_fortran_env[dp]"]);
  });
});

describe("Fortran 77", () => {
  it("proves functions by declaration in a self-contained unit, and closes units with a bare END", () => {
    const a = analyze([
      "      PROGRAM MAIN",
      "      DOUBLE PRECISION X, Y, DLAMCH, DSQRT, AREA",
      "      DIMENSION W(10)",
      "      CHARACTER*8 NAME",
      "      EXTERNAL FCN",
      "      AREA(R) = 3.14D0 * R * R",
      "      X = DLAMCH('E') + FCN(2.0D0) + AREA(1.0D0)",
      "      Y = DSQRT(X) + W(3) + ZETA(X)",
      "      NAME(1:2) = 'AB'",
      "      CALL SOLVE(W, 10)",
      "      END",
      "      SUBROUTINE SOLVE(W, N)",
      "      INCLUDE 'common.inc'",
      "      DIMENSION W(N)",
      "      W(1) = GAMMA(W(2))",
      "      RETURN",
      "      END",
    ].join("\n"), "legacy/main.f");
    expect(a.functions.map((f) => `${f.name}@${f.line}-${f.endLine}`)).toEqual(["MAIN@1-11", "SOLVE@12-17"]);
    // DLAMCH: a typed scalar; FCN: external; AREA: a statement function; ZETA:
    // undeclared in a unit with no use/include/host. DSQRT is an intrinsic,
    // W an array, NAME a character substring.
    expect(calls(a, "MAIN")).toEqual(["DLAMCH", "FCN", "AREA", "ZETA", "SOLVE"]);
    // An INCLUDE may declare arrays: an undeclared GAMMA(…) proves nothing there.
    expect(calls(a, "SOLVE")).toEqual([]);
    expect(a.imports.map((i) => i.source)).toEqual(["common.inc"]);
  });
});

describe("Fortran derived types", () => {
  it("reads extends, components with their visibility, and type-bound procedures", () => {
    const a = analyze([
      "module shapes",
      "  type, abstract :: shape",
      "    private",
      "    real :: x = 0, y = 0",
      "    character(len=:), allocatable, public :: label",
      "  contains",
      "    procedure(area_i), deferred :: area",
      "    procedure :: move => shape_move, describe",
      "    generic :: write(formatted) => write_shape",
      "    generic :: scale => scale_int, scale_real",
      "  end type shape",
      "  type, extends(shape) :: circle",
      "    real :: r",
      "  end type",
      "contains",
      "  subroutine shape_move(self, dx)",
      "    class(shape), intent(inout) :: self",
      "    real :: dx",
      "    call self%nudge(dx)",
      "  end subroutine",
      "end module",
    ].join("\n"));
    expect(a.classes.map((c) => [c.name, c.extends, c.decorators.join(",")])).toEqual([
      ["shape", null, "abstract"], ["circle", "shape", "extends(shape)"],
    ]);
    expect(a.classes[0]!.properties.map((p) => `${p.name}:${p.type}:${p.visibility}`)).toEqual([
      "x:real:private", "y:real:private", "label:character(len=:):public",
    ]);
    expect(a.classes[0]!.methods.map((m) => m.name)).toEqual(["area", "move", "describe", "write", "scale"]);
    expect(fn(a, "shape_move")!.localTypes).toEqual([{ name: "self", type: "shape" }]);
    expect(calls(a, "shape_move")).toEqual(["self.nudge"]);
  });
});

describe("Fortran line endings", () => {
  const root = resolve(__dirname, "../../../..");
  const files = globSync("test-fixtures/sample-fortran-app/**/*.{f,f90}", { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} with CRLF or CR line endings as with LF`, () => {
      const lf = readFileSync(resolve(root, rel), "utf-8").replace(/\r\n?/g, "\n");
      expect(analyze(lf.replace(/\n/g, "\r\n"), rel)).toEqual(analyze(lf, rel));
      expect(analyze(lf.replace(/\n/g, "\r"), rel)).toEqual(analyze(lf, rel));
    });
  }
});
