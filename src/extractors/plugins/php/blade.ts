import type { InteractiveElementInfo, ScreenInfo } from "../../../types/analysis.js";
import { extractHtmlInteractiveElements } from "../html/index.js";

/**
 * Laravel Blade templates (`resources/views/**.blade.php`) as UI screens —
 * the JSP treatment applied to Laravel's view tier. Blade files reach the PHP
 * plugin (they ARE .php), but before this they contributed nothing to the
 * Screens & UI pane, so a Laravel app's routes had no pages to anchor to.
 *
 * Screens: one `blade-view` per .blade.php file; caption from `<title>` or
 * `@section('title', '…')`.
 *
 * Interactive elements: the html plugin's extractors run on the markup —
 * Blade's `{{ … }}` echoes and `@directives` don't interfere with tag-level
 * scanning. Gated on Blade directives in the source (the hook has no file
 * path), so plain PHP class files never grow phantom buttons.
 */

const BLADE_FILE_RE = /\.blade\.php$/i;
/** Blade-authored content: a directive or an echo — present in practice in every template. */
const BLADE_MARKER_RE =
  /@(extends|section|yield|include|includeIf|csrf|method|foreach|endforeach|if|endif|auth|guest|push|stack)\b|\{\{\s*[$\w]/;

/** `@section('title', 'Product Catalog')` → "Product Catalog". */
const SECTION_TITLE_RE = /@section\s*\(\s*['"]title['"]\s*,\s*['"]([^'"]+)['"]/;
const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

export function extractBladeScreens(sourceText: string, filePath: string): ScreenInfo[] {
  if (!BLADE_FILE_RE.test(filePath)) return [];

  const base = filePath
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(BLADE_FILE_RE, "");

  const caption =
    sourceText.match(SECTION_TITLE_RE)?.[1] ??
    sourceText.match(TITLE_TAG_RE)?.[1]?.trim().replace(/\s+/g, " ") ??
    null;

  return [
    {
      name: base,
      formType: "blade-view",
      caption: caption || null,
      dimensions: null,
      components: [],
      filePath,
      routePath: null,
      navigatesTo: [],
    },
  ];
}

export function extractBladeInteractiveElements(sourceText: string): InteractiveElementInfo[] {
  if (!BLADE_MARKER_RE.test(sourceText)) return [];
  // Blank `{{ … }}` / `{!! … !!}` echo bodies first: they are runtime values,
  // and a `$product->id` inside one carries a `>` that would terminate the
  // html extractor's tag-attribute scan mid-attribute.
  const lines = sourceText
    .split(/\r?\n/)
    .map((l) => l.replace(/\{\{.*?\}\}|\{!!.*?!!\}/g, ""));
  return extractHtmlInteractiveElements(lines);
}
