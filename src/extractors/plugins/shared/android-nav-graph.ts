import type { RouteFact } from "../../../types/analysis.js";

/**
 * An Android Navigation graph (`res/navigation/*.xml`): the destinations a
 * user can reach and the actions between them. `.xml` belongs to the
 * springxml plugin, which reads the graph with this and states it as one
 * `routeFact`; the Java/Kotlin plugin's resolver
 * (`java-kotlin/routes/android-nav-graph.ts`) joins it to the fragment
 * classes and to the code that navigates by id.
 *
 *   <navigation app:startDestination="@id/home">
 *     <fragment android:id="@+id/home" android:name="com.acme.HomeFragment">
 *       <action android:id="@+id/action_home_to_detail" app:destination="@id/detail"/>
 *     </fragment>
 *     <fragment android:id="@+id/detail" android:name="com.acme.DetailFragment"/>
 *     <action android:id="@+id/action_global_settings" app:destination="@id/settings"/>
 *   </navigation>
 */

export const ANDROID_NAV_GRAPH = "android-nav-graph";

/**
 * A navigation row naming a graph id rather than a class, until the resolver
 * reads the graph: `@id/<id>` for `navigate(R.id.<id>)`, `@action/<name>` for
 * Safe Args' `navigate(HomeFragmentDirections.<name>())`.
 */
export const NAV_BY_ID = "@id/";
export const NAV_BY_ACTION = "@action/";

export interface NavGraphFact {
  /** Each destination: its id, the class it names (`android:name`, simple), and the actions declared on it. */
  destinations: Array<{ id: string; cls: string | null; line: number; actions: Array<{ id: string; to: string }> }>;
  /** Actions declared on a graph rather than a destination (global actions). */
  actions: Array<{ id: string; to: string }>;
  /** A nested graph's id and its start destination, so navigating to the graph reaches that. */
  graphs: Array<{ id: string; start: string | null }>;
}

const TAG_RE = /<(\/?)([a-zA-Z][\w.:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
const DESTINATIONS = new Set(["fragment", "activity", "dialog", "composable"]);

/** True for a navigation graph: a `<navigation>` root in the Android namespace. */
export function isAndroidNavGraph(raw: string): boolean {
  return /<navigation[\s>]/.test(raw) && raw.includes("schemas.android.com/apk/res");
}

/** `@+id/home` / `@id/home` → `home`. */
const idOf = (ref: string | undefined): string | null => (ref ? (/^@\+?id\/(.+)$/.exec(ref.trim())?.[1] ?? null) : null);

export function androidNavGraphFacts(lines: string[], facts: RouteFact[]): void {
  const text = lines.join("\n");
  if (!isAndroidNavGraph(text)) return;
  const fact: NavGraphFact = { destinations: [], actions: [], graphs: [] };
  // What each open tag is, so an <action> lands on the destination or graph around it.
  const stack: Array<{ tag: string; dest?: NavGraphFact["destinations"][number] }> = [];
  let line = 1;
  let last = 0;
  for (const m of text.matchAll(TAG_RE)) {
    for (let i = last; i < m.index!; i++) if (text[i] === "\n") line++;
    last = m.index!;
    const [, closing, rawTag, rawAttrs, selfClosing] = m;
    const tag = rawTag!.split(":").pop()!;
    if (closing) {
      while (stack.length && stack.pop()!.tag !== tag);
      continue;
    }
    const attrs = new Map([...rawAttrs!.matchAll(ATTR_RE)].map((a) => [a[1]!.split(":").pop()!, a[2]!]));
    let entry: (typeof stack)[number] = { tag };
    if (DESTINATIONS.has(tag)) {
      const id = idOf(attrs.get("id"));
      if (id) {
        const name = attrs.get("name");
        entry = { tag, dest: { id, cls: name ? name.split(".").pop()! : null, line, actions: [] } };
        fact.destinations.push(entry.dest!);
      }
    } else if (tag === "navigation") {
      const id = idOf(attrs.get("id"));
      if (id) fact.graphs.push({ id, start: idOf(attrs.get("startDestination")) });
    } else if (tag === "action") {
      const id = idOf(attrs.get("id"));
      const to = idOf(attrs.get("destination"));
      if (id && to) {
        const holder = stack[stack.length - 1];
        (holder?.dest ? holder.dest.actions : fact.actions).push({ id, to });
      }
    }
    if (!selfClosing) stack.push(entry);
  }
  if (fact.destinations.length) facts.push({ kind: ANDROID_NAV_GRAPH, line: 1, data: fact });
}
