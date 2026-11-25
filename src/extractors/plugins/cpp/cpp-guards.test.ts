import { beforeAll, describe, expect, it } from "vitest";
import { readCpp, withoutCppGuards } from "./antlr.js";
import { ensureLanguagesLoaded } from "../../registry.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["c", "cpp"]);
});

describe("a header's C++ guards say nothing of the header", () => {
  const guarded =
    "#ifdef __cplusplus\nextern \"C\" {\nnamespace league { class Club { public: int n; }; }\n#endif\n" +
    "int open_gate(const char *restrict name, int class);\n" +
    "static inline int lift_gate(const char *restrict name, int class) { return open_gate(name, class); }\n" +
    "#if defined(__cplusplus)\n}\n#endif\n";

  it("leaves out the guarded branch only", () => {
    const text = withoutCppGuards("#if defined(__cplusplus)\nA::b\n#else\nplain::c\n#endif\nafter::d\n");
    expect(text).not.toContain("A::b");
    expect(text).toContain("plain::c");
    expect(text).toContain("after::d");
    expect(withoutCppGuards("#ifndef __cplusplus\nx::y\n#endif\n")).toContain("x::y");
  });

  it("offers a clean-C header to the C reader", () => {
    const parsed = readCpp(guarded);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => f.name)).toContain("lift_gate");
  });

  it("keeps a header with C++ outside the guard on C++", () => {
    const parsed = readCpp("#ifdef __cplusplus\n#endif\nnamespace league { class Club { public: int n; }; }\nint f(const char *restrict x);\n");
    expect(parsed.syntaxErrors).toBeGreaterThan(0);
  });
});
