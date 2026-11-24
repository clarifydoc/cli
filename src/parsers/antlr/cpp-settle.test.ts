import { describe, expect, it } from "vitest";
import { CPP14Lexer } from "./cpp/CPP14Lexer.js";
import { CPP14Parser } from "./cpp/CPP14Parser.js";
import { parseSll } from "./run.js";

const SNIPPETS = [
  "struct Club; struct Club { int goals; };",
  "class Match : public Club { public: virtual ~Match(); };",
  "enum class Result : int { Won, Lost }; enum Kind { A, B };",
  "typedef struct Garage { int cars; } Garage_t;",
  "static const unsigned long kMax = 3;",
  "extern inline Club* find(const Club& c, struct Club* other, std::string key, Result r);",
  "constexpr int total(int a, int b) { return a + b; }",
  "void play(Club c, std::string name, const std::string& id, Garage_t* g, struct Club d) { std::string first, second; const Club* const best = nullptr; struct Club local; static thread_local int calls = 0; unsigned short n = 1, m = 2; std::shared_ptr<Club> squad; Club::Id id2 = name.size(); long long big = n * m; }",
  "struct Pair { struct Club left; struct Club* right; };",
  "void callback(Club, std::string, int (*kick)(int), Club (&refs)[3]);",
  "template <typename T> typename T::value_type first(const T& list) { return list[0]; }",
  "[[nodiscard]] static inline const Club& pick(const Club& a);",
];

describe("C++ declaration specifier decisions settled from tokens", () => {
  it("reads the same tree as prediction", () => {
    const read = (source: string, settle: boolean) => {
      let parser!: CPP14Parser;
      const parsed = parseSll(
        source,
        (input) => new CPP14Lexer(input),
        (tokens) => {
          parser = new CPP14Parser(tokens);
          parser.prepare(tokens);
          // Without the override on the simulator every decision is predicted.
          if (!settle) delete (parser.interpreter as unknown as { adaptivePredict?: unknown }).adaptivePredict;
          return parser;
        },
        (p) => p.translationUnit(),
      );
      return parsed ? parsed.tree.toStringTree(parser) : null;
    };
    for (const source of SNIPPETS) {
      const settled = read(source, true);
      expect(settled, source).not.toBeNull();
      expect(settled, source).toEqual(read(source, false));
    }
  });
});
