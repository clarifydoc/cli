/**
 * A fact map's value at a key the analyzed source chose (a field, constant or
 * module name), read as an OWN property only: a plain object answers
 * `constructor`, `toString` or `__proto__` with what it inherits, and a
 * class whose URL reads `this.constructor.BASE` must find nothing there,
 * not `Object`.
 */
export function ownValue<T>(map: Readonly<Record<string, T>> | undefined | null, key: string): T | undefined {
  return map != null && Object.hasOwn(map, key) ? map[key] : undefined;
}
