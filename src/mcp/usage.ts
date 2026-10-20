/**
 * What this session asked and got: every tool call in order, with the size of
 * its answer, how long it took, and whether it failed or came back empty (a
 * miss ends in `Next: …`). Only what was measured — no estimate of what reading
 * the files instead would have cost.
 */

import { byOrdinal } from "../core/ordinal.js";

export interface ToolCallRecord {
  tool: string;
  /** Characters of the answer, as the handler wrote it. */
  chars: number;
  ms: number;
  isError: boolean;
  /** A miss: the answer ends in a `Next:` line. */
  empty: boolean;
}

/** Rough characters per token, as the other budgets count. */
const CHARS_PER_TOKEN = 4;

const short = (tool: string) => tool.replace(/^clarifydoc_/, "");

const size = (chars: number) => (chars >= 10_000 ? `${(chars / 1000).toFixed(0)}k` : chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars));

/** Per tool: calls, characters, time, errors and misses, the most called first. */
function byTool(calls: ToolCallRecord[]): Array<{ tool: string; calls: number; chars: number; ms: number; errors: number; empty: number }> {
  const rows = new Map<string, { tool: string; calls: number; chars: number; ms: number; errors: number; empty: number }>();
  for (const c of calls) {
    const row = rows.get(c.tool) ?? { tool: c.tool, calls: 0, chars: 0, ms: 0, errors: 0, empty: 0 };
    row.calls++;
    row.chars += c.chars;
    row.ms += c.ms;
    if (c.isError) row.errors++;
    else if (c.empty) row.empty++;
    rows.set(c.tool, row);
  }
  return [...rows.values()].sort((a, b) => b.calls - a.calls || b.chars - a.chars || byOrdinal(a.tool, b.tool));
}

/** One line for a log: `12 calls (search ×4, trace ×3, …), 48k chars, 1 error, 2 empty`. */
export function usageLine(calls: ToolCallRecord[]): string {
  if (!calls.length) return "no tool calls";
  const tools = byTool(calls);
  const chars = calls.reduce((n, c) => n + c.chars, 0);
  const errors = calls.filter((c) => c.isError).length;
  const empty = calls.filter((c) => !c.isError && c.empty).length;
  return [
    `${calls.length} call${calls.length === 1 ? "" : "s"} (${tools.slice(0, 5).map((t) => `${short(t.tool)} ×${t.calls}`).join(", ")}${tools.length > 5 ? ", …" : ""})`,
    `${size(chars)} chars`,
    errors ? `${errors} error${errors === 1 ? "" : "s"}` : "",
    empty ? `${empty} empty` : "",
  ].filter(Boolean).join(", ");
}

/** The session as markdown: totals, per tool, then the calls in order (the last 50). */
export function renderUsage(calls: ToolCallRecord[]): string {
  if (!calls.length) return "# Session usage\n\nNo tool calls yet in this session.";
  const chars = calls.reduce((n, c) => n + c.chars, 0);
  const shown = calls.slice(-50);
  return [
    "# Session usage",
    "",
    `${usageLine(calls)} — about ${size(Math.round(chars / CHARS_PER_TOKEN))} tokens of answers.`,
    "",
    "## By tool",
    ...byTool(calls).map((t) =>
      `- ${t.tool} ×${t.calls} — ${size(t.chars)} chars, ${t.ms} ms${t.errors ? `, ${t.errors} failed` : ""}${t.empty ? `, ${t.empty} empty` : ""}`,
    ),
    "",
    `## In order${calls.length > shown.length ? ` (the last ${shown.length} of ${calls.length})` : ""}`,
    ...shown.map((c, i) =>
      `${calls.length - shown.length + i + 1}. ${short(c.tool)} — ${size(c.chars)} chars, ${c.ms} ms${c.isError ? " (failed)" : c.empty ? " (empty)" : ""}`,
    ),
  ].join("\n");
}
