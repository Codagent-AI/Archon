import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { resolveRunWorkflow } from '@archon/core/workflows/resolve-run-workflow';
import { assertRerunNodeIds } from '@archon/workflows/rerun-nodes';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { CLI_WORKFLOW_SURFACE } from '../utils/workflow-surface';
import { resolveDiscoveryCwdForCodebase } from './workflow-shared';

/**
 * Refuse a `--rerun` id the run's workflow does not have, before anything is claimed or
 * spawned. Resolves the workflow the way the resume itself will: the run's frozen source.
 */
async function assertRerunTargets(
  host: WorkflowHost,
  run: WorkflowRun,
  rerun: readonly string[]
): Promise<void> {
  if (rerun.length === 0) return;
  const discoveryCwd = run.codebase_id
    ? await resolveDiscoveryCwdForCodebase(host, run.id, run.codebase_id, 'resume')
    : run.working_path;
  if (!discoveryCwd) return;
  const resolved = await resolveRunWorkflow(host.deps, run, discoveryCwd, CLI_WORKFLOW_SURFACE);
  if (!resolved.ok) throw new Error(`Cannot check --rerun: ${resolved.message}`);
  assertRerunNodeIds(resolved.workflow, rerun);
}

/** Check the run is resumable and every `--rerun` id names a node of its workflow. */
export async function resumeChecked(
  host: WorkflowHost,
  runId: string,
  rerun: readonly string[]
): Promise<WorkflowRun> {
  const run = await host.operations.resumeWorkflow(runId, { kind: 'operator' });
  await assertRerunTargets(host, run, rerun);
  return run;
}
