import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of the ERB plugin (see meta.ts). A leaf: types only.
 *
 * `.erb` is Rails' view format (`app/views/users/index.html.erb`) and its
 * partials (`_form.html.erb`). Family `ruby`, so `render 'form'` — an import
 * of `./_form.html` — resolves to `_form.html.erb` through the family's
 * extensions like any relative import written without one.
 */
export const erbManifest: LanguagePluginManifest = {
  language: "erb",
  parsing: "regex",
  extensions: [".erb"],
  family: "ruby",
  importTarget: true,
};
