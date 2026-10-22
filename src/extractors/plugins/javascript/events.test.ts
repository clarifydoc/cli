import { describe, it, expect } from "vitest";
import { extractEvents } from "./events.js";

describe("Vue component events", () => {
  it("read names with `:` and `-`, each placed where it is first emitted (real-repo FP)", () => {
    const src = `<script setup lang="ts">
const emit = defineEmits<{
  (e: 'update:fixture', fixture: Fixture): void
  (e: 'create-fixture', title: string): void
  (e: 'close'): void
}>()

async function saveFixture(f: Fixture) {
  emit('update:fixture', f)
}

function createFixture(title: string) {
  emit('create-fixture', title)
}
</script>`;
    expect(extractEvents(src, "typescript").map((e) => `${e.name} @${e.line}`)).toEqual([
      "update:fixture @9",
      "create-fixture @13",
      "close @5",
    ]);
  });
});
