/** HTML elements that never close: they open no scope the next closing tag would end. */
export const VOID_TAGS: ReadonlySet<string> = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
