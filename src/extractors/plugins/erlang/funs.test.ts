import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import "../../registry.js";
import { erlangFunReferences } from "./funs.js";

describe("Erlang funs named as values", () => {
  it("records `fun kick/1` and `fun club:kick/1` as arguments the function hands on, never calls", () => {
    const src = `-module(club).
-export([run/0]).

run() ->
    lists:foreach(fun kick/1, [1, 2]),
    spawn(fun squad:other/0),
    % fun ghost/0 is a comment
    ok.

kick(X) -> X.
`;
    const a = extractWithRegex(src, "club.erl", "erlang");
    erlangFunReferences(a, src);
    const run = [...a.functions, ...a.classes.flatMap((c) => c.methods)].find((f) => f.name === "run")!;
    expect(run.calls.filter((c) => c.passed).map((c) => [c.name, c.passed])).toEqual([["kick", "argument"], ["squad:other", "argument"]]);
    expect(run.calls.some((c) => c.name === "ghost")).toBe(false);
  });
});
