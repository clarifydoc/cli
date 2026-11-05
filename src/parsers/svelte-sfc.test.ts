import { describe, it, expect } from "vitest";
import { extractSvelteInteractiveElements } from "./svelte-sfc.js";

describe("Svelte markup handlers", () => {
  const events = (markup: string) => extractSvelteInteractiveElements(markup).map((e) => `${e.line} ${e.event} ${e.handler}${e.component ? ` <${e.component}>` : ""}`);

  it("reads a tag whose attributes hold braces of their own (real-repo FP: 72 handlers lost)", () => {
    expect(events(`<button
  class={styles({ disabled, color })}
  onclick={() => { for (const q of queues) { void handleCreateJob({ name: q }); } }}
>Run</button>
<button class={"dark {theme}"} onclick={toggleLights}>Lights</button>`)).toEqual([
      "1 onclick handleCreateJob",
      "5 onclick toggleLights",
    ]);
  });

  it("reads a component's camelCase callbacks and the {onclick} shorthand (real-repo FP: 100 + 25 sites)", () => {
    expect(events(`<ArchiveAction onClick={onArchive} onCheckedChange={(v) => setFavourite(v)} />
<button {onclick}>Select all</button>
<input bind:value={clubName} on:change={() => save()} />`)).toEqual([
      "1 onClick onArchive <ArchiveAction>",
      "1 onCheckedChange setFavourite <ArchiveAction>",
      "2 onclick onclick",
      "3 bind:value null",
      "3 on:change save",
    ]);
  });
});

describe("SvelteKit form posts", () => {
  const requests = (markup: string) => extractSvelteInteractiveElements(markup, "/clubs/:id").flatMap((e) => (e.request ? [`${e.element} ${e.request.method} ${e.request.target}`] : []));

  it("a POST form without an action posts to the page, `?/name` to the page's named action, `/x?/name` as written", () => {
    expect(requests(`<form method="POST" action="?/rename"></form>\n<form method="post" use:enhance></form>\n<form method="POST" action="/players?/sign"></form>`)).toEqual([
      "form POST /clubs/:id?/rename",
      "form POST /clubs/:id",
      "form POST /players?/sign",
    ]);
  });

  it("leaves GET forms, computed actions and other components' markup alone", () => {
    expect(requests(`<form action="/search"></form><form method="POST" action={target}></form><form method="POST" action="https://pay.example.com/x"></form>`)).toEqual([]);
    expect(extractSvelteInteractiveElements(`<form method="POST"></form>`).some((e) => e.request)).toBe(false);
  });
});
