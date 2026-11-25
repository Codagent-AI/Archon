import type { DagNode } from './schemas';
import { isIncludeDirective } from './schemas/node-guards';
import type { ResolvedWorkflow } from './schemas/workflow';

/**
 * Node kinds `--rerun` can name. Other kinds keep state a fresh pass would not replace: a
 * `workflow:` node or fan-out finds its settled child runs again, a gate or wait its answer,
 * and a loop group's body may hold either.
 */
const RERUNNABLE_KINDS: ReadonlySet<string> = new Set(['agent', 'exec']);

/** Node kinds that hand back their finished child runs when they execute again. */
const CHILD_RUN_KINDS: ReadonlySet<string> = new Set(['workflow', 'compose_fan_out']);

/**
 * The nodes an operator's `--rerun` re-executes: the named ones and every node downstream of
 * them, transitively, through `depends_on`.
 */
export function withDownstreamNodes(
  nodes: readonly DagNode[],
  rerunNodeIds: ReadonlySet<string>
): ReadonlySet<string> {
  const rerun = new Set(rerunNodeIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (rerun.has(node.id) || !node.depends_on?.some(dep => rerun.has(dep))) continue;
      rerun.add(node.id);
      grew = true;
    }
  }
  return rerun;
}

function reusesChildRuns(node: DagNode): boolean {
  if (CHILD_RUN_KINDS.has(node.kind)) return true;
  return (
    node.kind === 'loop_group' &&
    node.loop_group.nodes.some(body => !isIncludeDirective(body) && reusesChildRuns(body))
  );
}

function assertRerunnableNode(
  workflow: Pick<ResolvedWorkflow, 'name' | 'nodes'>,
  id: string
): void {
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

/**
 * Refuse `--rerun` before a run is claimed: an id the workflow does not have, one inside a loop
 * group, a node kind a fresh pass would not truly re-run, or a downstream node that would hand
 * back its finished child runs instead of running them again.
 */
export function assertRerunNodeIds(
  workflow: Pick<ResolvedWorkflow, 'name' | 'nodes'>,
  rerunNodeIds: readonly string[] | undefined
): void {
  if (!rerunNodeIds?.length) return;
  for (const id of rerunNodeIds) assertRerunnableNode(workflow, id);
  const rerun = withDownstreamNodes(workflow.nodes, new Set(rerunNodeIds));
  const blocking = workflow.nodes.find(node => rerun.has(node.id) && reusesChildRuns(node));
  if (blocking !== undefined) {
    throw new Error(
      `Cannot rerun ${rerunNodeIds.map(id => `'${id}'`).join(', ')}: '${blocking.id}' runs after it and would hand back its finished child runs instead of running them again.`
    );
  }
}
