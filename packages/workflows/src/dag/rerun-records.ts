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
import { getStaleCachedDependencies } from './stale-dependencies';

/**
 * Record an operator's `--rerun` for each named node before any node dispatches. The resume
 * fold drops a node's prior success or failure at this row, so the request still holds when
 * the run pauses or fails before the node's layer and continues later without `--rerun`. Every
 * named node gets the row: a failed node's failure is not in this segment's context on a retry,
 * yet a later continuation after a pause would replay it. The top-level DAG calls it before
 * its startup budget check; loop bodies and fan-out instances re-run in full.
 */
export async function recordOperatorReruns(ctx: RunLayersContext): Promise<void> {
  if (!ctx.rerunNodeIds?.size || ctx.stepNamePrefix !== '') return;
  const prior = ctx.priorCompletedNodes ?? new Map<string, PersistedNodeOutput>();
  for (const node of ctx.layers.flat()) {
    if (!ctx.rerunNodeIds.has(node.id)) continue;
    await recordPriorCacheInvalidated(ctx, node, prior, [], 'operator');
  }
}

/**
 * Once a `--rerun` node in this layer settles with output that differs from its prior
 * snapshot, record the invalidation of each dependent with a prior success right away. That
 * snapshot is held only in memory: after a pause, the next pass would compare the dependent
 * against the node's new persisted output, find no change, and replay a result computed from
 * the replaced one. Dependents of an unchanged node still replay.
 */
export async function recordRerunDependents(
  ctx: RunLayersContext,
  layer: readonly DagNode[]
): Promise<void> {
  const prior = ctx.priorCompletedNodes;
  if (!ctx.rerunNodeIds?.size || prior === undefined) return;
  for (const rerun of layer.filter(node => ctx.rerunNodeIds?.has(node.id))) {
    for (const node of ctx.layers.flat()) {
      if (!replaysOnRerunOutput(ctx, node, rerun.id, prior)) continue;
      const stale = getStaleCachedDependencies(node, ctx.nodeOutputs, prior, ctx.replayedFailures);
      if (!stale.includes(rerun.id)) continue;
      await recordPriorCacheInvalidated(ctx, node, prior, stale);
      (ctx.rerunInvalidated ??= new Set()).add(node.id);
    }
  }
}

/** Whether `node` depends on `rerunId` and would still replay a prior success computed from it. */
function replaysOnRerunOutput(
  ctx: RunLayersContext,
  node: DagNode,
  rerunId: string,
  prior: ReadonlyMap<string, PersistedNodeOutput>
): boolean {
  return (
    (node.depends_on?.includes(rerunId) ?? false) &&
    prior.has(node.id) &&
    !ctx.rerunNodeIds?.has(node.id) &&
    !ctx.rerunInvalidated?.has(node.id)
  );
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
