import { describe, it, expect } from "vitest";
import { boundListeners } from "./bound-listeners.js";

const RAW = `<template>
  <ClubDialogContent v-bind="bindings" @cancel="onTouch">
    <slot />
  </ClubDialogContent>
  <input v-bind="inputAttrs" />
</template>
<script setup lang="ts">
const emit = defineEmits(['confirm', 'cancel', 'delete'])
const bindings = computed(() => ({
  title: props.title,
  onCancel: () => {
    emit('cancel')
  },
  onConfirm: () => emit('confirm'),
  onDelete: deleteEvent,
  onSubmit,
  label: 'x, y',
}))
const inputAttrs = { onFocus: () => {} }
</script>`;

describe("listeners handed over as one object", () => {
  it("are the bindings their keys name, unless the tag writes the event itself", () => {
    const template = RAW.slice(RAW.indexOf("<template>") + 10, RAW.indexOf("</template>"));
    const script = RAW.slice(RAW.indexOf("<script setup lang=\"ts\">") + 24, RAW.indexOf("</script>"));
    const found = boundListeners(template, RAW, script);
    expect(found.map((e) => `${e.component} ${e.event} ${e.handler!.replace(/\s+/g, " ")} @${e.line}`)).toEqual([
      "ClubDialogContent @confirm () => emit('confirm') @2",
      "ClubDialogContent @delete deleteEvent @2",
      "ClubDialogContent @submit onSubmit @2",
    ]);
  });
});
