import { describe, it, expect } from "vitest";
import type { FunctionInfo } from "../../../types/analysis.js";
import { withCompositeArgs } from "./call-args.js";

const fnWith = (calls: Array<{ name: string; line: number }>): FunctionInfo =>
  ({ name: "clubsList", params: [], calls: calls.map((c) => ({ ...c, kind: "internal", target: null })) }) as unknown as FunctionInfo;

describe("Go call arguments", () => {
  it("records the arguments of a call handing a composite literal's address, others as empty, never a value literal", () => {
    const lines = [
      "func clubsList(ctx context.Context) error {",
      "\tresult, err := handler.DoReadAll(ctx, &models.Club{}, a, in.Q)",
      "\terr = handler.DoDelete(ctx, &models.Club{",
      "\t\tID: in.ID,",
      "\t}, a)",
      "\tc.JSON(200, gin.H{\"club\": club})",
      "\treturn handler.DoReadOne(ctx, club, a)",
      "}",
    ];
    const [fn] = withCompositeArgs(lines, [fnWith([
      { name: "handler.DoReadAll", line: 2 },
      { name: "handler.DoDelete", line: 3 },
      { name: "c.JSON", line: 6 },
      { name: "handler.DoReadOne", line: 7 },
    ])]);
    expect(fn!.calls.map((c) => c.args)).toEqual([
      ["", "&models.Club{…}", "", ""],
      ["", "&models.Club{…}", ""],
      undefined,
      undefined,
    ]);
  });
});
