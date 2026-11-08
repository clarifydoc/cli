import type { DeploymentModel, FileAnalysis } from "../types/analysis.js";

/**
 * A queue named by the environment variable that holds its URL. A function that publishes to
 * `process.env.JOBS_URL` names no queue, only the variable; the deployment states which queue the
 * variable is — a Terraform function's `environment { JOBS_URL = aws_sqs_queue.jobs.url }` is a bus
 * edge from the function to the queue it names (`DeployedService.destination`: ONE named queue or
 * topic, not a broker). A publish or consume row of the function's own project whose target is that
 * variable is retargeted to the queue, so it meets the queue's other users at one node.
 *
 * Refused: a project whose services give the variable to different queues (or one service naming
 * the variable towards two), a service no project runs (nothing says whose code reads the
 * variable), and a broker — its name is not a destination. In memory only; per-file JSON is
 * untouched. Returns the rows retargeted.
 */
export function resolveQueueEnvTargets(analyses: readonly FileAnalysis[], deployment: DeploymentModel | undefined): number {
  if (!deployment) return 0;
  const byName = new Map(deployment.services.map((s) => [s.name, s]));
  // project → variable → the one queue, or null when the services disagree.
  const queueOf = new Map<string, Map<string, string | null>>();
  for (const e of deployment.edges) {
    if (e.kind !== "bus" || !e.via) continue;
    const from = byName.get(e.from);
    const to = byName.get(e.to);
    if (!from?.project || !to?.destination) continue;
    const vars = queueOf.get(from.project) ?? queueOf.set(from.project, new Map()).get(from.project)!;
    const seen = vars.get(e.via);
    vars.set(e.via, seen === undefined || seen === to.name ? to.name : null);
  }
  if (queueOf.size === 0) return 0;
  let changed = 0;
  for (const a of analyses) {
    const vars = a.projectId ? queueOf.get(a.projectId) : undefined;
    if (!vars) continue;
    for (const row of a.dataSources ?? []) {
      if ((row.kind !== "queue-publish" && row.kind !== "queue-consume") || !row.target) continue;
      const queue = vars.get(row.target);
      if (!queue) continue;
      row.target = queue;
      changed++;
    }
  }
  return changed;
}
