import { expect, it, mock, type Mock } from 'bun:test';
import {
  createMockStore,
  mockClaudeCapabilities,
  mockGetAgentProviderDag,
  mockProviderRegistry,
  mockSendQueryDag,
  withProviderCapabilities,
} from '../../../test-utils';
import type { DagNode } from '../../../../schemas';
import type { setupAddressableTests } from './sessions-owner-branches';

export function registerNamedForkTests(fixture: ReturnType<typeof setupAddressableTests>) {
  it('forks interleaved writer and reviewer lineages from each named ancestor', async () => {
    const sessionsByPrompt: Record<string, string> = {
      writer1: 'session-writer-1',
      reviewer1: 'session-reviewer-1',
      writer2: 'session-writer-2',
      reviewer2: 'session-reviewer-2',
      writer3: 'session-writer-3',
    };
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, resumeSessionId) {
      yield { type: 'agent_message_chunk', text: `done ${prompt}` };
      yield {
        type: 'result',
        sessionId: sessionsByPrompt[prompt],
        ...(resumeSessionId !== undefined ? { resumed: true } : {}),
      };
    });

    const store = await fixture.runAddressableWorkflow([
      { id: 'writer1', kind: 'agent', source: { kind: 'inline', prompt: 'writer1' } },
      {
        id: 'reviewer1',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'reviewer1' },
        context: 'fresh',
        depends_on: ['writer1'],
      },
      {
        id: 'writer2',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'writer2' },
        context: { resume: 'writer1' },
        depends_on: ['reviewer1'],
      },
      {
        id: 'reviewer2',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'reviewer2' },
        context: { resume: 'reviewer1' },
        depends_on: ['writer2'],
      },
      {
        id: 'writer3',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'writer3' },
        context: { resume: 'writer2' },
        depends_on: ['reviewer2'],
      },
    ]);

    expect(mockSendQueryDag.mock.calls.map(call => call[2])).toEqual([
      undefined,
      undefined,
      'session-writer-1',
      'session-reviewer-1',
      'session-writer-2',
    ]);
    expect(mockSendQueryDag.mock.calls.slice(2).every(call => call[3]?.forkSession === true)).toBe(
      true
    );

    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      call => call[0] as { event_type: string; step_name?: string; data?: Record<string, unknown> }
    );
    const writer2Started = events.find(
      event => event.event_type === 'node_started' && event.step_name === 'writer2'
    );
    const writer2Completed = events.find(
      event => event.event_type === 'node_completed' && event.step_name === 'writer2'
    );
    expect(writer2Started?.data).toMatchObject({
      session_source_node_id: 'writer1',
      session_fork_requested: true,
    });
    expect(writer2Completed?.data).toMatchObject({
      session_source_node_id: 'writer1',
      session_forked: true,
    });
    // Each completed node names its own session in `session_id` and nowhere else.
    expect(
      events
        .filter(event => event.event_type === 'node_completed')
        .map(event => [event.step_name, event.data?.session_id])
    ).toEqual([
      ['writer1', 'session-writer-1'],
      ['reviewer1', 'session-reviewer-1'],
      ['writer2', 'session-writer-2'],
      ['reviewer2', 'session-reviewer-2'],
      ['writer3', 'session-writer-3'],
    ]);
    const serializedEvents = JSON.stringify(
      events.map(event => {
        const data = { ...event.data };
        delete data.session_id;
        return { ...event, data };
      })
    );
    for (const sessionId of Object.values(sessionsByPrompt)) {
      expect(serializedEvents).not.toContain(sessionId);
    }
  });

  it('forks parallel consumers from the same immutable source without replacing it', async () => {
    let sequence = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, resumeSessionId) {
      sequence++;
      yield { type: 'agent_message_chunk', text: prompt };
      yield {
        type: 'result',
        sessionId: prompt === 'source' ? 'source-session' : `branch-${String(sequence)}`,
        ...(resumeSessionId !== undefined ? { resumed: true } : {}),
      };
    });

    await fixture.runAddressableWorkflow([
      { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' } },
      {
        id: 'lens-a',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'lens-a' },
        context: { resume: 'source' },
        depends_on: ['source'],
      },
      {
        id: 'lens-b',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'lens-b' },
        context: { resume: 'source' },
        depends_on: ['source'],
      },
      {
        id: 'synthesis',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'synthesis' },
        context: { resume: 'source' },
        depends_on: ['lens-a', 'lens-b'],
      },
    ]);

    const namedCalls = mockSendQueryDag.mock.calls.filter(call => call[0] !== 'source');
    expect(namedCalls.map(call => call[2])).toEqual([
      'source-session',
      'source-session',
      'source-session',
    ]);
    expect(namedCalls.every(call => call[3]?.forkSession === true)).toBe(true);
  });

  /** A call's resumed session, whether it asks for a fork, and the checkpoint it continues from. */
  function continuations(prompt: string): unknown[][] {
    return mockSendQueryDag.mock.calls
      .filter(call => call[0] === prompt)
      .map(call => [call[2], call[3]?.forkSession, call[3]?.sessionCheckpoint]);
  }

  /**
   * A provider that reports checkpoints: a call without `forkSession` continues the thread it
   * resumes, a fork starts a new thread, and every turn reports its own checkpoint.
   */
  function checkpointResult(
    session: string | undefined,
    forkSession: boolean | undefined,
    counters: { threads: number; turns: number }
  ) {
    return {
      type: 'result' as const,
      sessionId: session === undefined || forkSession === true ? `T${++counters.threads}` : session,
      sessionCheckpoint: `turn${++counters.turns}`,
      ...(session !== undefined ? { resumed: true } : {}),
    };
  }

  it('continues a checkpointed chain in place from the latest node that continued the source', async () => {
    const counters = { threads: 0, turns: 0 };
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session, options) {
      yield { type: 'agent_message_chunk', text: prompt };
      yield checkpointResult(session, options?.forkSession, counters);
    });
    const store = await fixture.runAddressableWorkflow([
      {
        id: 'source',
        kind: 'agent',
        provider: 'codex',
        source: { kind: 'inline', prompt: 'source' },
      },
      {
        id: 'b',
        kind: 'agent',
        provider: 'codex',
        source: { kind: 'inline', prompt: 'b' },
        context: { resume: 'source' },
        depends_on: ['source'],
      },
      {
        id: 'c',
        kind: 'agent',
        provider: 'codex',
        source: { kind: 'inline', prompt: 'c' },
        context: { resume: 'source' },
        depends_on: ['b'],
      },
    ]);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(continuations('b')).toEqual([['T1', false, 'turn1']]);
    // `c` names the source but continues `b`, which continued it and which `c` depends on.
    expect(continuations('c')).toEqual([['T1', false, 'turn2']]);
    expect(store.upsertWorkflowRunNodeSession).toHaveBeenLastCalledWith({
      workflow_run_id: 'addressable-run',
      node_id: 'c',
      provider: 'codex',
      provider_session_id: 'T1',
      session_path: [
        { key: 'source', sessionId: 'T1', checkpoint: 'turn1' },
        { key: 'b', sessionId: 'T1', checkpoint: 'turn2' },
        { key: 'c', sessionId: 'T1', checkpoint: 'turn3' },
      ],
    });
  });

  it('continues a checkpointed head in place for only one of two running consumers', async () => {
    const counters = { threads: 0, turns: 0 };
    // Each lens call waits for the other to start, so both attempts run at once.
    let lensCalls = 0;
    let bothStarted: () => void = () => undefined;
    const started = new Promise<void>(resolve => {
      bothStarted = resolve;
    });
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session, options) {
      if (prompt.startsWith('lens')) {
        if (++lensCalls === 2) bothStarted();
        await Promise.race([started, new Promise(resolve => setTimeout(resolve, 2000))]);
      }
      yield { type: 'agent_message_chunk', text: prompt };
      yield checkpointResult(session, options?.forkSession, counters);
    });
    const lens = (id: string): DagNode => ({
      id,
      kind: 'agent',
      provider: 'codex',
      source: { kind: 'inline', prompt: id },
      context: { resume: 'source' },
      depends_on: ['source'],
    });
    const store = await fixture.runAddressableWorkflow([
      {
        id: 'source',
        kind: 'agent',
        provider: 'codex',
        source: { kind: 'inline', prompt: 'source' },
      },
      lens('lens-a'),
      lens('lens-b'),
      {
        id: 'synthesis',
        kind: 'agent',
        provider: 'codex',
        source: { kind: 'inline', prompt: 'synthesis' },
        context: { resume: 'source' },
        depends_on: ['lens-a', 'lens-b'],
      },
    ]);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    const lenses = [...continuations('lens-a'), ...continuations('lens-b')];
    expect(lenses.map(call => call[0])).toEqual(['T1', 'T1']);
    expect(lenses.map(call => call[2])).toEqual(['turn1', 'turn1']);
    expect(lenses.map(call => call[1]).sort()).toEqual([false, true]);
    // The lenses diverged, so the synthesis continues the last point they share.
    expect(continuations('synthesis')).toEqual([['T1', false, 'turn1']]);
  });

  it('retries a failed in-place attempt from the same checkpoint', async () => {
    const counters = { threads: 0, turns: 0 };
    let consumerCalls = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session, options) {
      if (prompt === 'consumer' && ++consumerCalls === 1) {
        yield {
          type: 'result',
          sessionId: session,
          isError: true,
          errors: ['upstream overloaded'],
          failure: { class: 'transient', evidence: 'upstream overloaded' },
        };
        return;
      }
      yield { type: 'agent_message_chunk', text: prompt };
      yield checkpointResult(session, options?.forkSession, counters);
    });
    const store = await fixture.runAddressableWorkflow([
      {
        id: 'source',
        kind: 'agent',
        provider: 'codex',
        source: { kind: 'inline', prompt: 'source' },
      },
      {
        id: 'consumer',
        kind: 'agent',
        provider: 'codex',
        source: { kind: 'inline', prompt: 'consumer' },
        context: { resume: 'source' },
        depends_on: ['source'],
        retry: { max_attempts: 1, delay_ms: 1 },
      },
    ]);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    // The failed attempt released the session, and the retry starts from the same point.
    expect(continuations('consumer')).toEqual([
      ['T1', false, 'turn1'],
      ['T1', false, 'turn1'],
    ]);
  });

  it('reasks every named structured-output pass from the declared source', async () => {
    let consumerAttempts = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, resumeSessionId) {
      if (prompt === 'source') {
        yield { type: 'agent_message_chunk', text: 'source output' };
        yield { type: 'result', sessionId: 'source-session' };
        return;
      }
      if (prompt === 'final') {
        yield { type: 'agent_message_chunk', text: 'final output' };
        yield { type: 'result', sessionId: 'final-branch', resumed: true };
        return;
      }
      consumerAttempts++;
      yield {
        type: 'result',
        sessionId: `consumer-branch-${String(consumerAttempts)}`,
        ...(resumeSessionId !== undefined ? { resumed: resumeSessionId === 'source-session' } : {}),
        structuredOutput: consumerAttempts === 1 ? { wrong: true } : { verdict: 'accepted branch' },
      };
    });

    await fixture.runAddressableWorkflow([
      { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' }, provider: 'pi' },
      {
        id: 'consumer',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'consumer' },
        provider: 'pi',
        context: { resume: 'source' },
        depends_on: ['source'],
        output_format: {
          type: 'object',
          properties: { verdict: { type: 'string' } },
          required: ['verdict'],
        },
      },
      {
        id: 'final',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'final' },
        provider: 'pi',
        context: { resume: 'consumer' },
        depends_on: ['consumer'],
      },
    ]);

    expect(mockSendQueryDag.mock.calls.map(call => call[2])).toEqual([
      undefined,
      'source-session',
      'source-session',
      'consumer-branch-2',
    ]);
  });

  it('checkpoints a plain loop source and forks it for a named consumer', async () => {
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, resumeSessionId) {
      if (resumeSessionId === undefined) {
        yield { type: 'agent_message_chunk', text: '<promise>DONE</promise>' };
        yield { type: 'result', sessionId: 'loop-session' };
        return;
      }
      yield { type: 'agent_message_chunk', text: String(prompt) };
      yield { type: 'result', sessionId: 'consumer-branch', resumed: true };
    });

    const store = await fixture.runAddressableWorkflow([
      {
        id: 'loop-source',
        kind: 'loop',
        loop: { prompt: 'iterate', until: 'DONE', max_iterations: 1, fresh_context: false },
      },
      {
        id: 'consumer',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'consumer' },
        context: { resume: 'loop-source' },
        depends_on: ['loop-source'],
      },
    ]);

    expect(store.upsertWorkflowRunNodeSession).toHaveBeenCalledWith(
      expect.objectContaining({ node_id: 'loop-source', provider_session_id: 'loop-session' })
    );
    expect(mockSendQueryDag.mock.calls[1]?.[2]).toBe('loop-session');
    expect(mockSendQueryDag.mock.calls[1]?.[3]?.forkSession).toBe(true);
  });

  it('hydrates a completed source handle and forks it after a cold resume', async () => {
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, resumeSessionId) {
      yield { type: 'agent_message_chunk', text: 'resumed synthesis' };
      yield { type: 'result', sessionId: 'cold-branch', resumed: resumeSessionId !== undefined };
    });

    await fixture.runAddressableWorkflow(
      [
        { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'must be skipped' } },
        {
          id: 'synthesis',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'synthesize' },
          context: { resume: 'source' },
          depends_on: ['source'],
        },
      ],
      createMockStore(),
      new Map([['source', { output: 'prior output' }]]),
      [
        {
          workflow_run_id: 'addressable-run',
          node_id: 'source',
          provider: 'claude',
          provider_session_id: 'cold-source',
          session_path: null,
          created_at: '2026-08-19T00:00:00Z',
          updated_at: '2026-08-19T00:00:00Z',
        },
      ]
    );

    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(mockSendQueryDag.mock.calls[0][2]).toBe('cold-source');
    expect(mockSendQueryDag.mock.calls[0][3]?.forkSession).toBe(true);
  });

  it('gives a named source precedence over the consumer persisted-session lookup', async () => {
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, resumeSessionId) {
      yield { type: 'agent_message_chunk', text: prompt };
      yield {
        type: 'result',
        sessionId: prompt === 'source' ? 'named-source' : 'named-branch',
        ...(resumeSessionId !== undefined ? { resumed: true } : {}),
      };
    });
    const store = createMockStore();
    store.listWorkflowNodeSessions.mockResolvedValue([
      {
        workflow_name: 'addressable',
        node_id: 'consumer',
        scope_key: 'conv-dag',
        provider: 'claude',
        provider_session_id: 'persisted-consumer-session',
        last_run_id: 'old-run',
        created_at: '2026-08-19T00:00:00Z',
        updated_at: '2026-08-19T00:00:00Z',
      },
    ]);

    await fixture.runAddressableWorkflow(
      [
        { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' } },
        {
          id: 'consumer',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'consumer' },
          context: { resume: 'source' },
          persist_session: true,
          depends_on: ['source'],
        },
      ],
      store
    );

    expect(mockSendQueryDag.mock.calls[1][2]).toBe('named-source');
    expect(store.upsertWorkflowNodeSession).toHaveBeenCalledWith(
      expect.objectContaining({ node_id: 'consumer', provider_session_id: 'named-branch' })
    );
  });

  it('fails before the consumer runs when the source completed without a session', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'source output' };
      yield { type: 'result' };
    });
    const store = await fixture.runAddressableWorkflow([
      { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' } },
      {
        id: 'consumer',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'consumer' },
        context: { resume: 'source' },
        depends_on: ['source'],
      },
    ]);

    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(store.failWorkflowRun).toHaveBeenCalled();
    const failedEvents = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls
      .map(
        call =>
          call[0] as { event_type: string; step_name?: string; data?: Record<string, unknown> }
      )
      .filter(event => event.event_type === 'node_failed' && event.step_name === 'consumer');
    expect(failedEvents[0]?.data).toMatchObject({ session_source_node_id: 'source' });
  });

  it('fails a named fork on cold fallback, a missing branch ID, or source ID reuse', async () => {
    const cases = [
      { name: 'cold fallback', sessionId: 'cold-branch', resumed: false },
      { name: 'missing branch', sessionId: undefined, resumed: true },
      { name: 'source reuse', sessionId: 'source-session', resumed: true },
    ];

    for (const failureCase of cases) {
      mockSendQueryDag.mockClear();
      mockSendQueryDag.mockImplementation(async function* (prompt) {
        yield { type: 'agent_message_chunk', text: prompt };
        if (prompt === 'source') {
          yield { type: 'result', sessionId: 'source-session' };
        } else {
          yield {
            type: 'result',
            sessionId: failureCase.sessionId,
            resumed: failureCase.resumed,
          };
        }
      });
      const store = await fixture.runAddressableWorkflow([
        { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' } },
        {
          id: 'consumer',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'consumer' },
          context: { resume: 'source' },
          depends_on: ['source'],
        },
      ]);

      const completedConsumer = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls
        .map(call => call[0] as { event_type: string; step_name?: string })
        .some(event => event.event_type === 'node_completed' && event.step_name === 'consumer');
      expect({
        case: failureCase.name,
        workflowFailed: store.failWorkflowRun.mock.calls.length > 0,
        completedConsumer,
        consumerResumeId: mockSendQueryDag.mock.calls[1]?.[2],
      }).toEqual({
        case: failureCase.name,
        workflowFailed: true,
        completedConsumer: false,
        consumerResumeId: 'source-session',
      });
    }
  });

  it('fails a named resume rejected as stale instead of retrying it fresh', async () => {
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, resumeSessionId) {
      if (resumeSessionId === undefined) {
        yield { type: 'agent_message_chunk', text: prompt };
        yield { type: 'result', sessionId: 'source-session' };
        return;
      }
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        failure: { class: 'unknown', evidence: 'error_during_execution: evidence' },
        sessionId: resumeSessionId,
        resumed: true,
        sessionNotFound: true,
      };
    });
    const store = await fixture.runAddressableWorkflow([
      { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' } },
      {
        id: 'consumer',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'consumer' },
        context: { resume: 'source' },
        depends_on: ['source'],
      },
    ]);

    // Only the source ran fresh; every consumer attempt resumed the named session.
    const resumeIds = mockSendQueryDag.mock.calls.map(call => call[2]);
    expect(resumeIds[0]).toBeUndefined();
    expect(resumeIds.slice(1).length).toBeGreaterThan(0);
    expect(resumeIds.slice(1).every(id => id === 'source-session')).toBe(true);
    expect(store.failWorkflowRun.mock.calls.length).toBeGreaterThan(0);
  });

  it('fails before provider execution on runtime mismatch or missing fork capability', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'must not run' };
      yield { type: 'result', sessionId: 'unexpected' };
    });
    const priorCompleted = new Map([['source', { output: 'prior output' }]]);
    const priorSession = {
      workflow_run_id: 'addressable-run',
      node_id: 'source',
      provider: 'pi',
      provider_session_id: 'pi-source',
      session_path: null,
      created_at: '2026-08-19T00:00:00Z',
      updated_at: '2026-08-19T00:00:00Z',
    };
    const nodes: DagNode[] = [
      { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'skipped' } },
      {
        id: 'consumer',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'consumer' },
        context: { resume: 'source' },
        depends_on: ['source'],
      },
    ];

    const mismatchStore = await fixture.runAddressableWorkflow(
      nodes,
      createMockStore(),
      priorCompleted,
      [priorSession]
    );
    expect(mockSendQueryDag).not.toHaveBeenCalled();
    expect(mismatchStore.failWorkflowRun).toHaveBeenCalled();

    expect(mockGetAgentProviderDag).not.toHaveBeenCalled();
    const capabilityStore = await fixture.runAddressableWorkflow(
      nodes,
      createMockStore(),
      priorCompleted,
      [{ ...priorSession, provider: 'claude' }],
      withProviderCapabilities(mockProviderRegistry, 'claude', {
        ...mockClaudeCapabilities(),
        sessionFork: false,
      })
    );
    expect(mockGetAgentProviderDag).not.toHaveBeenCalled();
    expect(mockSendQueryDag).not.toHaveBeenCalled();
    expect(capabilityStore.failWorkflowRun).toHaveBeenCalled();
  });

  it('fails a required source before completion when its session checkpoint cannot be saved', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'source' };
      yield { type: 'result', sessionId: 'source-session' };
    });
    const store = createMockStore();
    (
      store.upsertWorkflowRunNodeSession as Mock<typeof store.upsertWorkflowRunNodeSession>
    ).mockRejectedValue(new Error('checkpoint failed'));

    await fixture.runAddressableWorkflow(
      [
        { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' } },
        {
          id: 'consumer',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'consumer' },
          context: { resume: 'source' },
          depends_on: ['source'],
        },
      ],
      store
    );

    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(store.failWorkflowRun).toHaveBeenCalled();
    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      call => call[0] as { event_type: string; step_name?: string }
    );
    expect(
      events.some(event => event.event_type === 'node_completed' && event.step_name === 'source')
    ).toBe(false);
    expect(
      events.some(event => event.event_type === 'node_failed' && event.step_name === 'source')
    ).toBe(true);
  });
}

export function registerSessionCheckpointTests(fixture: ReturnType<typeof setupAddressableTests>) {
  it('fails a required loop source before completion when its session checkpoint cannot be saved', async () => {
    mockSendQueryDag.mockImplementation(async function* (): ReturnType<typeof mockSendQueryDag> {
      yield { type: 'agent_message_chunk', text: '<promise>DONE</promise>' };
      yield { type: 'result', sessionId: 'loop-session' };
    });
    const store = createMockStore();
    (
      store.upsertWorkflowRunNodeSession as Mock<typeof store.upsertWorkflowRunNodeSession>
    ).mockRejectedValue(new Error('checkpoint failed'));

    await fixture.runAddressableWorkflow(
      [
        {
          id: 'loop-source',
          kind: 'loop',
          loop: { prompt: 'iterate', until: 'DONE', max_iterations: 1, fresh_context: false },
        },
        {
          id: 'consumer',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'consumer' },
          context: { resume: 'loop-source' },
          depends_on: ['loop-source'],
        },
      ],
      store
    );

    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(store.failWorkflowRun).toHaveBeenCalled();
    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      call => call[0] as { event_type: string; step_name?: string }
    );
    expect(
      events.some(
        event => event.event_type === 'node_completed' && event.step_name === 'loop-source'
      )
    ).toBe(false);
    expect(
      events.some(event => event.event_type === 'node_failed' && event.step_name === 'loop-source')
    ).toBe(true);
  });

  it('does not checkpoint sessions when the workflow has no named consumer', async () => {
    const store = createMockStore();
    (
      store.upsertWorkflowRunNodeSession as Mock<typeof store.upsertWorkflowRunNodeSession>
    ).mockRejectedValue(new Error('checkpoint must not run'));

    await fixture.runAddressableWorkflow(
      [
        { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' } },
        {
          id: 'later',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'later' },
          depends_on: ['source'],
        },
      ],
      store
    );

    expect(store.upsertWorkflowRunNodeSession).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });
}
