// @archon-test-isolated
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import {
  listWorkflowRunNodeSessions,
  upsertWorkflowRunNodeSession,
} from './workflow-run-node-sessions';

const RUN = 'run-1';
const base = { workflow_run_id: RUN, node_id: 'scope', provider: 'claude' };
const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-run-node-sessions-'));
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  resetDatabase();
  const db = getDatabase();
  await db.query(
    "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ('conv-1', 'test', 'c')",
    []
  );
  await db.query(
    'INSERT INTO remote_agent_workflow_runs (id, workflow_name, conversation_id, user_message) VALUES (?, ?, ?, ?)',
    [RUN, 'test', 'conv-1', '']
  );
});

afterAll(async () => {
  await closeDatabase();
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await removeTempTree(root);
});

test('a session path round-trips and an upsert without one stores null', async () => {
  const path = [
    { key: 'root', sessionId: 's0' },
    { key: 'scope', sessionId: 's1', checkpoint: 'cp' },
  ];
  await upsertWorkflowRunNodeSession({ ...base, provider_session_id: 's1', session_path: path });
  expect((await listWorkflowRunNodeSessions(RUN))[0]?.session_path).toEqual(path);

  await upsertWorkflowRunNodeSession({ ...base, provider_session_id: 's2' });
  const [row] = await listWorkflowRunNodeSessions(RUN);
  expect(row?.provider_session_id).toBe('s2');
  expect(row?.session_path).toBeNull();
});

test('stored text that is not a valid path fails naming the run and node', async () => {
  await upsertWorkflowRunNodeSession({ ...base, provider_session_id: 's1' });
  for (const text of ['not json', '{"key":"a"}', '[{"key":"a"}]']) {
    await getDatabase().query(
      'UPDATE remote_agent_workflow_run_node_sessions SET session_path = ? WHERE workflow_run_id = ?',
      [text, RUN]
    );
    await expect(listWorkflowRunNodeSessions(RUN)).rejects.toThrow(`run ${RUN}, node scope`);
  }
});
