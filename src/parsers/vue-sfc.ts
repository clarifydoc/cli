/**
 * Vue Single File Component (SFC) parser.
 * Extracts <script>, <template>, and <style> blocks from .vue files
 * without needing a tree-sitter-vue grammar.
 */

export interface VueSfcBlocks {
  /** The script content (from <script> or <script setup>) */
  script: string | null;
  /** Whether the script uses <script setup> */
  isSetup: boolean;
  /** The script language (ts, js, or null) */
  scriptLang: "typescript" | "javascript";
  /** The template content */
  template: string | null;
  /** Component names used in the template (uppercase tags) */
  templateComponents: TemplateComponent[];
}

export interface TemplateComponent {
  name: string;
  props: string[];
  line: number;
}

/**
 * Parse a .vue SFC file and extract its blocks.
 */
export function parseVueSfc(source: string): VueSfcBlocks {
  const script = extractBlock(source, "script");
  const template = extractBlock(source, "template");

  // Determine if it's <script setup>
  const scriptTagMatch = source.match(/<script\b([^>]*)>/i);
  const isSetup = scriptTagMatch
    ? /\bsetup\b/.test(scriptTagMatch[1])
    : false;

  // Determine script language
  const langMatch = scriptTagMatch?.[1]?.match(/\blang\s*=\s*["'](\w+)["']/);
  const lang = langMatch?.[1];
  const scriptLang: "typescript" | "javascript" =
    lang === "ts" || lang === "typescript" ? "typescript" : "javascript";

  // Extract component usage from template
  const templateComponents: TemplateComponent[] = [];
  if (template) {
    extractTemplateComponents(template, source, templateComponents);
  }

  return {
    script: script,
    isSetup,
    scriptLang,
    template,
    templateComponents,
  };
}

/**
 * Extract the content of a block (<script>, <template>, <style>) from a .vue file.
 */
function extractBlock(source: string, tag: string): string | null {
  // Match opening tag (may have attributes) and closing tag
  const regex = new RegExp(
    `<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`,
    "i",
  );
  const match = source.match(regex);
  return match ? match[1] : null;
}

/**
 * Extract component usage from Vue template HTML.
 * Components are PascalCase or kebab-case tags that aren't standard HTML.
 */
function extractTemplateComponents(
  template: string,
  fullSource: string,
  components: TemplateComponent[],
) {
  const seen = new Set<string>();

  // Match opening tags: <ComponentName or <component-name
  const tagRegex = /<([A-Z][a-zA-Z0-9]*|[a-z]+-[a-z-]+)(\s[^>]*)?\/?>/g;
  let match: RegExpExecArray | null;

  // Standard HTML tags to ignore
  const htmlTags = new Set([
    "div", "span", "p", "a", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "table", "tr", "td", "th", "thead", "tbody",
    "form", "input", "button", "select", "option", "textarea", "label",
    "img", "video", "audio", "source", "canvas", "svg", "path",
    "section", "article", "nav", "header", "footer", "main", "aside",
    "pre", "code", "blockquote", "br", "hr", "strong", "em", "b", "i",
    "template", "slot", "component", "transition", "keep-alive",
    "teleport", "suspense",
  ]);

  while ((match = tagRegex.exec(template)) !== null) {
    const tagName = match[1];
    // Skip standard HTML tags
    if (htmlTags.has(tagName.toLowerCase())) continue;
    // Skip if already seen
    const normalizedName = toPascalCase(tagName);
    if (seen.has(normalizedName)) continue;
    seen.add(normalizedName);

    // Extract props from the tag attributes
    const attrs = match[2] ?? "";
    const props = extractVueProps(attrs);

    // Calculate line number in the full source
    const templateStart = fullSource.indexOf(template);
    const beforeMatch = fullSource.slice(0, templateStart + (match.index ?? 0));
    const line = (beforeMatch.match(/\n/g)?.length ?? 0) + 1;

    components.push({ name: normalizedName, props, line });
  }
}

/** Extract prop names from Vue template attributes */
function extractVueProps(attrs: string): string[] {
  const props: string[] = [];
  // Match: prop-name, :prop-name, v-bind:prop-name, @event-name, v-model
  const propRegex = /(?::|v-bind:)?([a-zA-Z][a-zA-Z0-9-]*)\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = propRegex.exec(attrs)) !== null) {
    const name = m[1];
    if (!name.startsWith("v-") && name !== "class" && name !== "style") {
      props.push(name);
    }
  }
  // v-model
  if (attrs.includes("v-model")) props.push("v-model");
  return props;
}

/** Convert kebab-case to PascalCase */
function toPascalCase(name: string): string {
  if (!name.includes("-")) return name;
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
