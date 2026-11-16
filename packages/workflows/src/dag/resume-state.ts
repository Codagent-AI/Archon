/**
 * The run state a DAG pass starts from: outputs of nodes a prior pass completed, the
 * cross-run session persistence scope, and the provider sessions named resumes read.
 */
import type { WorkflowDeps } from '../deps';
import type {
  DagNode,
  NodeOutput,
  ResolvedWorkflow,
  WorkflowRun,
  WorkflowRunNodeSession,
} from '../schemas';
import {
  definedOutputPaths,
  isLoopGroupNode,
  isNodeContextResume,
  persistScopeKey,
  runMayPersistSessions,
} from '../schemas';
import { resolvedBodyNodes } from '../graph-plan';
import type { PersistedNodeOutput } from '../store';
import { getLog } from './log';
import type { PersistScope } from './run-context';
import { bodySessionIds, type NamedSessionHandle } from './named-session';

export interface RestoredRunState {
  nodeOutputs: Map<string, NodeOutput>;
  persistScope: PersistScope | undefined;
  namedSessionNodeIds: ReadonlySet<string>;
  nodeSessionHandles: Map<string, NamedSessionHandle>;
}

export function restoreRunState(
  store: WorkflowDeps['store'],
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  priorCompletedNodes: ReadonlyMap<string, PersistedNodeOutput> | undefined,
  priorNodeSessions: readonly WorkflowRunNodeSession[] | undefined
): RestoredRunState {
  const nodeOutputs = priorNodeOutputs(workflow, workflowRun, priorCompletedNodes);
  const namedSessionNodeIds = collectNamedSessionNodes(workflow.nodes);
  return {
    nodeOutputs,
    persistScope: openPersistScope(store, workflow, workflowRun),
    namedSessionNodeIds,
    nodeSessionHandles: restoreNamedSessions(
      workflow.nodes,
      nodeOutputs,
      namedSessionNodeIds,
      priorNodeSessions ?? []
    ),
  };
}

/**
 * The named sessions of the nodes a prior pass completed: each top-level node's own, and the
 * latest session of each body node of a completed loop_group, nested groups' included, which
 * steps after the group may continue. The completed-output snapshot is the authority for which nodes survived the
 * previous pass, so a handle is never resurrected without its completion. A body row an
 * older binary wrote has no lineage and was never continued after its group, so it stays out.
 */
function restoreNamedSessions(
  nodes: readonly DagNode[],
  nodeOutputs: ReadonlyMap<string, NodeOutput>,
  namedSessionNodeIds: ReadonlySet<string>,
  rows: readonly WorkflowRunNodeSession[]
): Map<string, NamedSessionHandle> {
  const rowsById = new Map(rows.map(row => [row.node_id, row]));
  const handles = new Map<string, NamedSessionHandle>();
  for (const node of nodes) {
    if (!nodeOutputs.has(node.id)) continue;
    const row = rowsById.get(node.id);
    if (row !== undefined && namedSessionNodeIds.has(node.id)) {
      handles.set(node.id, { ...restoredSession(row, node.id), producer: node.id });
    }
    if (!isLoopGroupNode(node)) continue;
    for (const bodyId of bodySessionIds(
      resolvedBodyNodes(node.loop_group),
      namedSessionNodeIds
    ).keys()) {
      const bodyRow = rowsById.get(`${node.id}.${bodyId}`);
      if (bodyRow?.session_path == null) continue;
      const session = restoredSession(bodyRow, bodyRow.node_id);
      handles.set(session.key, { ...session, producer: node.id });
    }
  }
  return handles;
}

/** A row as a session: its path's last point is the row's own, the points before it its lineage. */
function restoredSession(
  row: WorkflowRunNodeSession,
  legacyKey: string
): Omit<NamedSessionHandle, 'producer'> {
  const path = row.session_path ?? [];
  const own = path.at(-1);
  if (own !== undefined && own.sessionId !== row.provider_session_id) {
    throw new Error(
      `Node '${row.node_id}' has a recorded session lineage that does not end with its own session.`
    );
  }
  return {
    key: own?.key ?? legacyKey,
    sessionId: row.provider_session_id,
    provider: row.provider,
    ...(own?.checkpoint !== undefined ? { checkpoint: own.checkpoint } : {}),
    lineage: path.slice(0, -1),
  };
}

/**
 * Pre-populate nodeOutputs from prior run so already-completed nodes are
 * treated as done for trigger-rule and $nodeId.output substitution purposes.
 * Nodes flagged `always_run: true` are excluded — they re-execute on resume
 * and downstream consumers must see the fresh output, not the cached one.
 */
function priorNodeOutputs(
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  priorCompletedNodes: ReadonlyMap<string, PersistedNodeOutput> | undefined
): Map<string, NodeOutput> {
  const nodeOutputs = new Map<string, NodeOutput>();
  if (!priorCompletedNodes || priorCompletedNodes.size === 0) return nodeOutputs;
  const nodesById = new Map(workflow.nodes.map(n => [n.id, n]));
  let prepopulatedCount = 0;
  for (const [nodeId, prior] of priorCompletedNodes) {
    const node = nodesById.get(nodeId);
    if (node?.always_run) continue;
    // A local producer's loaded definition owns its contract, so its strict
    // `$node.output.<path>` contract survives resume (#2091) and matches the load-time
    // check, even when the row was written by an older binary that recorded only
    // top-level fields. The persisted contract serves producers whose definition states
    // none: a `workflow:` node's is the CHILD's (#2453), and a wait node's is fixed by
    // the engine. A loop_group gets none: its output_format is ignored, but its
    // persisted terminal payload (below) still rehydrates, matching fresh completion
    // since #2637.
    const declaredOutputPaths =
      (node !== undefined ? definedOutputPaths(node) : undefined) ?? prior.declaredOutputPaths;
    nodeOutputs.set(nodeId, {
      state: 'completed',
      output: prior.output,
      // The persisted logical value (#2637): downstream whole-value and `.field`
      // consumers observe exactly what fresh execution exposed. Absent for rows
      // persisted before the key existed — those keep the text-parse fallback.
      ...(prior.structuredOutput !== undefined ? { structuredOutput: prior.structuredOutput } : {}),
      ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
      ...(prior.execution !== undefined ? { execution: prior.execution } : {}),
    });
    prepopulatedCount++;
  }
  getLog().info(
    {
      workflowRunId: workflowRun.id,
      priorCompletedCount: priorCompletedNodes.size,
      prepopulatedCount,
      alwaysRunResumedCount: priorCompletedNodes.size - prepopulatedCount,
    },
    'dag.workflow_resume_prepopulated'
  );
  return nodeOutputs;
}

/**
 * Per-node session persistence across workflow re-runs, keyed by the thread that
 * launched the run (see `persistScopeKey`). An empty key would scope every invocation
 * to the same blank scope, so persistence is skipped in that case.
 */
function openPersistScope(
  store: WorkflowDeps['store'],
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun
): PersistScope | undefined {
  const key = persistScopeKey(workflowRun);
  if (!key || !runMayPersistSessions(workflow)) return undefined;
  const sessionsAtStart = store.listWorkflowNodeSessions({
    workflow_name: workflow.name,
    scope_key: key,
  });
  // A persisted node that never dispatches (skipped by `when:`, or after a failure)
  // never awaits this; a failed read must not become an unhandled rejection there.
  // Nodes that await it still see the rejection.
  sessionsAtStart.catch(() => undefined);
  return { key, sessionsAtStart };
}

/**
 * Nodes on a named session's lineage, loop_group bodies included: each node that names a
 * source in `context: { resume }`, and each source. A later node may continue any of them.
 */
function collectNamedSessionNodes(nodes: readonly DagNode[]): Set<string> {
  const ids = new Set<string>();
  const collect = (level: readonly DagNode[]): void => {
    for (const node of level) {
      if (isNodeContextResume(node.context)) {
        ids.add(node.context.resume);
        ids.add(node.id);
      }
      if (isLoopGroupNode(node)) collect(resolvedBodyNodes(node.loop_group));
    }
  };
  collect(nodes);
  return ids;
}
