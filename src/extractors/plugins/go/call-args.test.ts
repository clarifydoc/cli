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

describe("Go call arguments — a field of a parameter addressed", () => {
  it("stands for a literal of the field's type, through an anonymous struct, an embedded field and a local", () => {
    const lines = [
      "type clubReadBody struct {",
      "\tmodels.Club",
      "\tMaxPermission models.Permission `json:\"max_permission\"`",
      "}",
      "func clubsUpdate(ctx context.Context, in *struct { ID int64 `path:\"id\"` Body clubReadBody }) error {",
      "\tclub := &in.Body.Club",
      "\tclub.ID = in.ID",
      "\treturn handler.DoUpdate(ctx, club, a)",
      "}",
      "func clubsCreate(ctx context.Context, in *struct { Body models.Club }) error {",
      "\treturn handler.DoCreate(ctx, &in.Body, a)",
      "}",
      "func clubsCount(ctx context.Context, in *struct { Body clubReadBody }) error {",
      "\treturn handler.DoCount(ctx, &in.Body.MaxPermission.Level, a)",
      "}",
    ];
    const fn = (name: string, params: Array<[string, string]>, line: number, endLine: number, call: [string, number]): FunctionInfo =>
      ({ name, params: params.map(([n, t]) => ({ name: n, type: t, defaultValue: null })), line, endLine, calls: [{ name: call[0], line: call[1], kind: "internal", target: null }] }) as unknown as FunctionInfo;
    const fns = withCompositeArgs(lines, [
      fn("clubsUpdate", [["ctx", "context.Context"], ["in", "struct { ID int64 `path:\"id\"` Body clubReadBody }"]], 5, 9, ["handler.DoUpdate", 8]),
      fn("clubsCreate", [["ctx", "context.Context"], ["in", "struct { Body models.Club }"]], 10, 12, ["handler.DoCreate", 11]),
      fn("clubsCount", [["ctx", "context.Context"], ["in", "struct { Body clubReadBody }"]], 13, 15, ["handler.DoCount", 14]),
    ]);
    expect(fns.map((f) => f.calls[0]!.args)).toEqual([
      ["", "&models.Club{…}", ""],
      ["", "&models.Club{…}", ""],
      undefined, // a field of another package's type is not followed
    ]);
  });
});
