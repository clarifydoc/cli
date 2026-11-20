/**
 * The loose English inflection the ORM conventions share (Rails, Granite,
 * Isar collections, Drift getters): good for `tactics` ↔ `Tactic`,
 * `categories` ↔ `Category`, `addresses` ↔ `Address`; not a dictionary.
 */
export function singularize(word: string): string {
  if (/ies$/.test(word)) return word.replace(/ies$/, "y");
  if (/(ss|x|z|ch|sh)es$/.test(word)) return word.replace(/es$/, "");
  return /[^s]s$/.test(word) ? word.slice(0, -1) : word;
}

export function pluralize(word: string): string {
  if (/[^aeiou]y$/.test(word)) return word.replace(/y$/, "ies");
  if (/(s|x|z|ch|sh)$/.test(word)) return word + "es";
  return word.endsWith("s") ? word : word + "s";
}

/**
 * System.Text.Json's CamelCase policy: lower-case the leading run of upper-case
 * letters, but leave the last of the run when it starts the next word —
 * `Name` → `name`, `ID` → `id`, `URLValue` → `urlValue`.
 */
export function camelCase(name: string): string {
  if (!name || name[0]! < "A" || name[0]! > "Z") return name;
  let run = 0;
  while (run < name.length && name[run]! >= "A" && name[run]! <= "Z") run++;
  if (run === name.length) return name.toLowerCase();
  if (run === 1) return name[0]!.toLowerCase() + name.slice(1);
  const next = name[run]!;
  const isLower = next >= "a" && next <= "z";
  const cut = isLower ? run - 1 : run;
  return name.slice(0, cut).toLowerCase() + name.slice(cut);
}

/** `ClubMember` → `club_member`, `HTTPServer` → `http_server` (a model name as its table or key column spells it). */
export function underscore(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase();
}
