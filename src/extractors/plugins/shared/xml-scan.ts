/**
 * Tolerant, dependency-free XML tag scanner shared by regex-path plugins that
 * read XML dialects (WSDL/XSD, …). Tags may span lines; a `>` inside a quoted
 * attribute value must not close the tag. Comments are blanked first so
 * commented-out markup never parses. Namespace prefixes are preserved on
 * `name` (`xsd:element`) — callers strip them with {@link localName}.
 */

const XML_TAG_RE = /<(\/?)([a-zA-Z][\w.:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

export interface XmlTag {
  close: boolean;
  name: string;
  attrs: string;
  selfClose: boolean;
  line: number;
}

/** Local name of a possibly-prefixed tag/attribute (`xsd:element` → `element`). */
export function localName(name: string): string {
  const i = name.indexOf(":");
  return i >= 0 ? name.slice(i + 1) : name;
}

/** Read a named attribute's value (double- or single-quoted); null if absent. */
export function attrOf(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"|(?:^|\\s)${name}\\s*=\\s*'([^']*)'`));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** Scan all tags in an XML source, tracking 1-based line numbers. */
export function scanTags(source: string): XmlTag[] {
  const masked = source.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
  const out: XmlTag[] = [];
  let lastIndex = 0;
  let line = 1;
  for (const m of masked.matchAll(XML_TAG_RE)) {
    if (m[2]!.startsWith("!") || m[2]!.startsWith("?")) continue;
    for (let i = lastIndex; i < m.index!; i++) {
      if (masked.charCodeAt(i) === 10) line++;
    }
    lastIndex = m.index!;
    out.push({ close: m[1] === "/", name: m[2]!, attrs: m[3] ?? "", selfClose: m[4] === "/", line });
  }
  return out;
}
