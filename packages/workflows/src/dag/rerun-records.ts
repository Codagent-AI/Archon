/**
 * Resume cache records: why a node's prior-pass result is not reused. Covers dependency
 * invalidation (#2402) and an operator's `workflow resume --rerun`.
 */
import { describeExecutionNode } from '../node-execution';
import { recordNodeState } from '../node-event-write';
import type { DagNode } from '../schemas';
import type { PersistedNodeOutput } from '../store';
import { getLog } from './log';
import { formatPersistedNodeOutput, persistedExecutionOutput } from './node-output';
import type { RunLayersContext } from './run-context';

/**
 * Record an operator's `--rerun` for each node it re-executes (`ctx.rerunNodeIds`: the named
 * nodes and everything downstream) before any node dispatches. The resume fold drops a node's
 * prior success or failure at this row, so the request still holds when the run pauses, fails
 * or stops before reaching the node and continues later without `--rerun`. `invalidating_deps`
 * lists the dependencies the rerun reaches a node through; it is empty for a named node. The
 * top-level DAG calls this before its startup budget check; loop bodies and fan-out instances
 * re-run in full.
 */
export async function recordOperatorReruns(ctx: RunLayersContext): Promise<void> {
  const rerun = ctx.rerunNodeIds;
  if (!rerun?.size || ctx.stepNamePrefix !== '') return;
  const prior = ctx.priorCompletedNodes ?? new Map<string, PersistedNodeOutput>();
  for (const node of ctx.layers.flat()) {
    if (!rerun.has(node.id)) continue;
    const via = (node.depends_on ?? []).filter(dep => rerun.has(dep));
    await recordPriorCacheInvalidated(ctx, node, prior, via, 'operator');
  }
}

export function formatPriorOutput(
  ctx: RunLayersContext,
  node: DagNode,
  priorCompletedNodes: ReadonlyMap<string, PersistedNodeOutput>
): ReturnType<typeof formatPersistedNodeOutput> {
  return formatPersistedNodeOutput(
    priorCompletedNodes.get(node.id)?.output ?? '',
    ctx.artifactsDir
  );
}

export async function recordPriorCacheInvalidated(
  ctx: RunLayersContext,
  node: DagNode,
  priorCompletedNodes: ReadonlyMap<string, PersistedNodeOutput>,
  staleDeps: string[],
  requestedBy?: 'operator'
): Promise<void> {
  // Same rationale as the always_run reset: prior.output can be the full
  // spilled text, so this audit row needs the same bounding (#2726).
  const priorOutput = formatPriorOutput(ctx, node, priorCompletedNodes);
  getLog().info(
    { nodeId: node.id, invalidatingDeps: staleDeps, requestedBy },
    'dag.node_prior_cache_invalidated'
  );
  await recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    {
      runId: ctx.workflowRun.id,
      path: ctx.stepNamePrefix + node.id,
      node: describeExecutionNode(node),
      cache: {
        action: 'invalidated',
        invalidatingDeps: staleDeps,
        ...(requestedBy === undefined ? {} : { requestedBy }),
        prior: {
          ...persistedExecutionOutput(priorOutput),
          structured: priorCompletedNodes.get(node.id)?.structuredOutput,
        },
      },
    }
  );
}
