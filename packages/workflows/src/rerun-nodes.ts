import type { ResolvedWorkflow } from './schemas/workflow';

/**
 * Node kinds `--rerun` can execute fresh. Other kinds keep state a fresh pass would not
 * replace: a `workflow:` node or fan-out finds its settled child runs again, a gate or wait
 * its answer, and a loop group's body may hold either.
 */
const RERUNNABLE_KINDS: ReadonlySet<string> = new Set(['agent', 'exec']);

/**
 * Refuse a `--rerun` node id before a run is claimed: one the workflow does not have, one
 * inside a loop group, or a node kind a fresh pass would not truly re-run.
 */
export function assertRerunNodeIds(
  workflow: Pick<ResolvedWorkflow, 'name' | 'nodes'>,
  rerunNodeIds: readonly string[] | undefined
): void {
  for (const id of rerunNodeIds ?? []) {
    const node = workflow.nodes.find(candidate => candidate.id === id);
    if (node === undefined) {
      throw new Error(
        `Cannot rerun '${id}': workflow '${workflow.name}' has no top-level node with that id.`
      );
    }
    if (!RERUNNABLE_KINDS.has(node.kind)) {
      throw new Error(
        `Cannot rerun '${id}': it is a ${node.kind} node. Only agent, bash and script nodes can be re-run.`
      );
    }
  }
}
