/** Private provider session handles produced by nodes within one workflow run. */
import { z } from 'zod';
import { namedSessionPointSchema } from './run-wait';

export const workflowRunNodeSessionSchema = z.object({
  workflow_run_id: z.string(),
  node_id: z.string(),
  provider: z.string(),
  provider_session_id: z.string(),
  /** The named-session lineage ending with this row's own point; null for rows written before it existed. */
  session_path: z.array(namedSessionPointSchema).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type WorkflowRunNodeSession = z.infer<typeof workflowRunNodeSessionSchema>;
