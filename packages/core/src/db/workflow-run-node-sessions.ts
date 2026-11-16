/** Private provider session handles scoped to a single workflow run. */
import { createLogger } from '@archon/paths';
import { namedSessionPointSchema } from '@archon/workflows/schemas/run-wait';
import { z } from 'zod';
import type { WorkflowRunNodeSession } from '@archon/workflows/schemas/workflow-run-node-session';
import type { IWorkflowRunNodeSessionStore } from '@archon/workflows/store';
import { getDialect, pool } from './connection';

import { toHydratedTimestamp } from './timestamps';

type SessionRow = Omit<WorkflowRunNodeSession, 'created_at' | 'updated_at' | 'session_path'> & {
  session_path: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflow-run-node-sessions');
  return cachedLog;
}

const sessionPathSchema = z.array(namedSessionPointSchema);

// The text is written only by upsert below; anything else is corruption the engine
// must not resume from, so name the row instead of dropping the lineage.
function parseSessionPath(row: SessionRow): WorkflowRunNodeSession['session_path'] {
  if (row.session_path === null) return null;
  const where = `run ${row.workflow_run_id}, node ${row.node_id}`;
  let json: unknown;
  try {
    json = JSON.parse(row.session_path);
  } catch {
    throw new Error(`Stored session_path is not valid JSON (${where})`);
  }
  const parsed = sessionPathSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(`Stored session_path is not a valid session path (${where})`);
  return parsed.data;
}

export async function listWorkflowRunNodeSessions(
  workflowRunId: string
): Promise<readonly WorkflowRunNodeSession[]> {
  const result = await pool.query<SessionRow>(
    `SELECT * FROM remote_agent_workflow_run_node_sessions
     WHERE workflow_run_id = $1
     ORDER BY node_id ASC`,
    [workflowRunId]
  );
  return result.rows.map(row => ({
    ...row,
    session_path: parseSessionPath(row),
    created_at: toHydratedTimestamp(row.created_at).toISOString(),
    updated_at: toHydratedTimestamp(row.updated_at).toISOString(),
  }));
}

export const upsertWorkflowRunNodeSession: IWorkflowRunNodeSessionStore['upsertWorkflowRunNodeSession'] =
  async params => {
    const now = getDialect().now();
    try {
      await pool.query(
        `INSERT INTO remote_agent_workflow_run_node_sessions
           (workflow_run_id, node_id, provider, provider_session_id, session_path, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, ${now}, ${now})
         ON CONFLICT (workflow_run_id, node_id)
         DO UPDATE SET provider = EXCLUDED.provider,
                       provider_session_id = EXCLUDED.provider_session_id,
                       session_path = EXCLUDED.session_path,
                       updated_at = ${now}`,
        [
          params.workflow_run_id,
          params.node_id,
          params.provider,
          params.provider_session_id,
          params.session_path ? JSON.stringify(params.session_path) : null,
        ]
      );
      getLog().debug(
        {
          workflowRunId: params.workflow_run_id,
          nodeId: params.node_id,
          provider: params.provider,
        },
        'db.workflow_run_node_session_upsert_completed'
      );
    } catch (error) {
      getLog().error(
        {
          err: error as Error,
          workflowRunId: params.workflow_run_id,
          nodeId: params.node_id,
          provider: params.provider,
        },
        'db.workflow_run_node_session_upsert_failed'
      );
      throw error;
    }
  };
