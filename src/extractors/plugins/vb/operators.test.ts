import { describe, it, expect } from "vitest";
import { vbSpec } from "./index.js";

const classes = (src: string) => vbSpec.extractClasses!(src.split("\n"), []);

describe("VB operator declarations", () => {
  const SCORE = `Public Structure Score
    Public Property Goals As Integer
    Public Shared Operator +(a As Score, b As Score) As Score
        Return Combine(a, b)
    End Operator
    Public Shared Operator -(a As Score) As Score
        Return Negate(a)
    End Operator
    Public Shared Widening Operator CType(goals As Integer) As Score
        Return FromGoals(goals)
    End Operator
    Public Shared Narrowing Operator CType(s As Score) As Integer
        Return s.Goals
    End Operator
    Public Shared Operator <>(a As Score, b As Score) As Boolean
        Return Not Same(a, b)
    End Operator
    Public Shared Function Combine(a As Score, b As Score) As Score
        Return New Score()
    End Function
End Structure`;

  it("reads each operator as a method under the compiler's name, with its calls", () => {
    const [score] = classes(SCORE);
    expect(score!.endLine).toBe(21);
    expect(score!.methods.map((m) => [m.name, m.line, m.endLine, m.calls.map((c) => c.name)])).toEqual([
      ["op_Addition", 3, 5, ["Combine"]],
      ["op_UnaryNegation", 6, 8, ["Negate"]],
      ["op_Implicit", 9, 11, ["FromGoals"]],
      ["op_Explicit", 12, 14, []],
      ["op_Inequality", 15, 17, ["Same"]],
      ["Combine", 18, 20, ["Score"]],
    ]);
    expect(score!.methods[0]!.params.map((p) => `${p.name}:${p.type}`)).toEqual(["a:Score", "b:Score"]);
  });
});
