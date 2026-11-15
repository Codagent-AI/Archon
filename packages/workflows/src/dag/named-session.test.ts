import { describe, expect, it } from 'bun:test';
import { dagNodeSchema } from '../schemas';
import {
  completedNamedSession,
  cursorOfNamedSession,
  iterationNamedSessions,
  namedSessionKey,
  namedSessionOfCursor,
  startingPoint,
  upstreamOf,
  type NamedSession,
  type NamedSessionHandle,
} from './named-session';

const source: NamedSession = {
  key: 'S',
  sessionId: 'thread',
  provider: 'codex',
  checkpoint: 's1',
  lineage: [],
};

/** A session `key` ended on after continuing `head`. */
function continued(
  key: string,
  head: NamedSession,
  sessionId = head.sessionId,
  checkpoint = `${key}1`
): NamedSession {
  return completedNamedSession(key, head.provider, { sessionId, checkpoint }, head);
}

describe('startingPoint', () => {
  it('continues the source when no dependency continued it', () => {
    const unrelated: NamedSession = { ...source, key: 'X', sessionId: 'other', lineage: [] };
    expect(startingPoint(source, [unrelated])).toBe(source);
  });

  it('continues the latest session of a chain', () => {
    const b = continued('B', source);
    const c = continued('C', b);
    expect(startingPoint(source, [b, c])).toBe(c);
    expect(c.lineage.map(point => point.key)).toEqual(['S', 'B']);
  });

  it('continues the last shared point when the continuers diverge', () => {
    const b = continued('B', source);
    const c = continued('C', b, 'fork-c');
    const d = continued('D', b, 'fork-d');
    expect(startingPoint(source, [c, d])).toEqual({
      key: 'B',
      sessionId: 'thread',
      provider: 'codex',
      checkpoint: 'B1',
      lineage: [{ key: 'S', sessionId: 'thread', checkpoint: 's1' }],
    });
  });

  it('keeps a body node on its own branch when the continuers diverge', () => {
    const a = continued('G[1].a', source, 'thread-a');
    const b = continued('G[1].b', source, 'thread-b');
    expect(startingPoint(source, [a, b], a)).toBe(a);
    expect(startingPoint(source, [a, b], b)).toBe(b);
    expect(startingPoint(source, [a, b])).toEqual({ ...source });
  });

  it('follows a sibling that continued the node’s own session', () => {
    const a = continued('G[1].a', source, 'thread-a');
    const c = continued('G[1].c', a);
    const b = continued('G[1].b', source, 'thread-b');
    expect(startingPoint(source, [a, b, c], a)).toBe(c);
  });

  it('tells apart two runs of one body node under the same key', () => {
    const first = continued('G[1].a', source, 'thread', 'a1');
    const rerun = continued('G[1].a', first, 'thread', 'a2');
    expect(startingPoint(source, [first, rerun])).toBe(rerun);
  });
});

describe('named session records', () => {
  it('keys a node by its enclosing iterations', () => {
    expect(namedSessionKey([], 'node')).toBe('node');
    expect(
      namedSessionKey(
        [
          { groupId: 'outer', iteration: 2 },
          { groupId: 'inner', iteration: 1 },
        ],
        'node'
      )
    ).toBe('outer[2].inner[1].node');
  });

  it('round-trips a session through a pause cursor', () => {
    const b = continued('G[1].b', source);
    expect(namedSessionOfCursor(cursorOfNamedSession(b), 'unused')).toEqual(b);
  });

  it('gives a cursor saved without lineage the fallback key and an empty lineage', () => {
    expect(namedSessionOfCursor({ sessionId: 'O', provider: 'claude' }, 'G[0].owner')).toEqual({
      key: 'G[0].owner',
      sessionId: 'O',
      provider: 'claude',
      lineage: [],
    });
  });

  it('starts a loop_group iteration with its dependencies’ and earlier iterations’ sessions', () => {
    const handle = (key: string, producer: string | undefined): NamedSessionHandle => ({
      ...source,
      key,
      producer,
    });
    const earlier = continued('G[1].body', source);
    const inherited = iterationNamedSessions(
      new Map([
        ['dep', handle('dep', 'dep')],
        ['sibling', handle('sibling', 'sibling')],
        ['outer', handle('outer', undefined)],
      ]),
      new Set(['dep']),
      new Map([['body', earlier]])
    );
    expect([...(inherited?.entries() ?? [])].map(([id, h]) => [id, h.producer])).toEqual([
      ['dep', undefined],
      ['outer', undefined],
      ['G[1].body', undefined],
    ]);
    expect(inherited?.get('G[1].body')?.lineage).toEqual(earlier.lineage);
    expect(iterationNamedSessions(undefined, new Set(), undefined)).toBeUndefined();
  });

  it('lists each node’s direct and transitive dependencies', () => {
    const node = (id: string, depends_on?: string[]) => {
      const parsed = dagNodeSchema.parse({
        id,
        bash: 'true',
        ...(depends_on ? { depends_on } : {}),
      });
      if (parsed.kind === 'include') throw new Error('expected an executable node');
      return parsed;
    };
    const upstream = upstreamOf([[node('a')], [node('b', ['a'])], [node('c', ['b'])]]);
    expect([...(upstream.get('c') ?? [])].sort()).toEqual(['a', 'b']);
    expect([...(upstream.get('a') ?? [])]).toEqual([]);
  });
});
