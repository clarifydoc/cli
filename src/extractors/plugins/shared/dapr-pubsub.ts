import type { DataSourceInfo } from "../../../types/analysis.js";

/**
 * Dapr pub/sub through an SDK, as every language states it: a publish and a
 * subscription each name a pub/sub component and a topic. The topic is the
 * channel (the component only picks the broker), so a publisher in one
 * language meets a subscriber in another at the same queue node — the shape the
 * C# reading and the `kind: Subscription` descriptor already give.
 */

/** The row for one Dapr publish (`queue-publish`) or subscription (`queue-consume`) on `topic`. */
export function daprRow(publish: boolean, method: string, topic: string, line: number): DataSourceInfo {
  return { kind: publish ? "queue-publish" : "queue-consume", name: `Dapr: ${method}`, target: topic, entity: topic, calls: [], line };
}

/** A topic name as a bare literal: what a broker accepts, never an expression. */
export const DAPR_TOPIC_RE = /^[\w$.:/-]+$/;
