/**
 * How a declared C++ parameter or variable type folds to the key the overload chooser compares an argument kind with
 * (`calls.overloadTypeKey`; the arguments' own kinds are read by `antlr.ts`): qualifiers, references and pointers
 * left off, the arithmetic types and their fixed-width spellings folded to `int`, `long`, `float`, …, a C string
 * (`const char*`) to `string` — what a string literal is — and the string classes (`std::string`, `string_view`,
 * `QString`) to `basic_string`, which a literal reaches only by a conversion, any other type to its simple name.
 */

const KEYS: Readonly<Record<string, string>> = {
  int32_t: "int", uint32_t: "int", wchar_t: "int", char16_t: "int", char32_t: "int",
  int16_t: "short", uint16_t: "short",
  int64_t: "long", uint64_t: "long", size_t: "long", ssize_t: "long", ptrdiff_t: "long", intptr_t: "long", uintptr_t: "long",
  int8_t: "char", uint8_t: "char",
  bool: "boolean", boolean: "boolean",
  string: "basic_string", wstring: "basic_string", string_view: "basic_string", u8string: "basic_string", QString: "basic_string",
  cstring: "string",
  void: "object", object: "object",
};

/** The key of a spelling made only of arithmetic keywords in any order (`long unsigned int`, `long long`), else null. */
function arithmeticKey(words: readonly string[]): string | null {
  if (words.length === 0 || !words.every((w) => /^(?:int|signed|unsigned|short|long|char|float|double)$/.test(w))) return null;
  if (words.includes("double")) return "double";
  if (words.includes("float")) return "float";
  if (words.includes("char")) return "char";
  if (words.includes("short")) return "short";
  return words.includes("long") ? "long" : "int";
}

/** `const std::string&` → `basic_string`, `unsigned long long` → `long`, `const Club *` → `Club`, `const char *` → `string`, `std::vector<Club>` → `vector<Club>`, `long unsigned int` → `long`. */
export function cppOverloadTypeKey(type: string): string {
  if (type === "?" || type.startsWith("->")) return type;
  let t = type.replace(/\b(?:const|volatile|constexpr|static|register|mutable|struct|class|enum|union|typename)\b/g, " ");
  // Template arguments stay, so `Box<int>` and `Box<float>` are two types.
  // From the first `<` to the last `>`, sliced rather than replaced: one cut, nothing left to re-scan.
  const lt = t.indexOf("<");
  const gt = t.lastIndexOf(">");
  const hasArgs = lt >= 0 && gt > lt;
  const args = hasArgs ? t.slice(lt, gt + 1).replace(/\s+/g, "") : "";
  const bare = hasArgs ? t.slice(0, lt) + t.slice(gt + 1) : t;
  const pointer = /\*/.test(bare);
  t = bare.replace(/[&*]+/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^(?:::)?(?:std::)/, "").replace(/^.*::/, "");
  if (args) return `${t}${args}`;
  const key = arithmeticKey(t.split(" ")) ?? KEYS[t];
  // A pointer to a character is a C string; a pointer to `void` takes any pointer.
  if (pointer && key === "char") return "string";
  return key ?? t;
}
