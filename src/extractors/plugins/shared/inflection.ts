/**
 * The loose English inflection the ORM conventions share (Rails, Granite,
 * Isar collections, Drift getters): good for `recipes` ↔ `Recipe`,
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
