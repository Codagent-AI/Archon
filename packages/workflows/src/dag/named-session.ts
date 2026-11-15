/**
 * Named session lineage (`context: { resume }`): the point a node's conversation continues
 * from.
 *
 * A node that names X continues X's conversation together with the turns of every node that
 * continued X's conversation and that the node depends on, directly or through other nodes.
 * Inside a loop_group body, earlier iterations count as dependencies. When two of those nodes
 * are on different branches, the node continues from the last point they share, so two nodes
 * that can run at the same time never write one conversation together.
 *
 * Which nodes count is fixed by the graph and by which of the node's dependencies completed,
 * never by timing: a sibling that happens to finish first is not a dependency.
 */
import type { DagNode, NamedSessionCursor, NamedSessionPoint } from '../schemas';

/** A completed node's session as a later node continues it. */
export interface NamedSession {
  /** The node's path with its loop iterations, unique within the run. */
  key: string;
  sessionId: string;
  provider: string;
  /** The provider's marker for the node's last turn, when the provider reports one. */
  checkpoint?: string;
  /** The points this session continued, root first. */
  lineage: readonly NamedSessionPoint[];
}

/** A named session as one graph level holds it. */
export interface NamedSessionHandle extends NamedSession {
  /**
   * The node at this level whose completion produced it, or undefined for a session that an
   * enclosing level or an earlier iteration produced, which precedes every node at this level.
   */
  producer: string | undefined;
}

/**
 * How an attempt continues its starting point:
 * - `checkpoint`: in place when the point is still its session's latest turn and no other
 *   running attempt holds that session in place, otherwise forked through the point;
 * - `fork`: a fork of the point's session, for a provider that reports no checkpoints.
 */
export type NamedSessionMode = 'checkpoint' | 'fork';

/** Where a node's conversation continues from, and how. */
export interface NamedSessionStart {
  head: NamedSession;
  mode: NamedSessionMode;
}

export function pointOf(session: NamedSession): NamedSessionPoint {
  return {
    key: session.key,
    sessionId: session.sessionId,
    ...(session.checkpoint !== undefined ? { checkpoint: session.checkpoint } : {}),
  };
}

/** Every point the session holds, root first, ending with its own. */
export function pathOf(session: NamedSession): NamedSessionPoint[] {
  return [...session.lineage, pointOf(session)];
}

/**
 * Whether two points are the same point of one conversation. The key alone is not enough: a
 * resumed loop iteration runs its body again under the same keys.
 */
export function samePoint(a: NamedSessionPoint, b: NamedSessionPoint): boolean {
  return a.key === b.key && a.sessionId === b.sessionId && a.checkpoint === b.checkpoint;
}

function continues(session: NamedSession, point: NamedSessionPoint): boolean {
  return pathOf(session).some(p => samePoint(p, point));
}

/**
 * The point a node naming `source` continues from: the latest of `source` and the sessions in
 * `visible` that continued it. `visible` must hold only sessions of the node's dependencies.
 * When those sessions are on different branches, a loop_group body node with a session from
 * an earlier iteration (`own`) keeps to the branches that continued it; otherwise the point
 * is the last one they share.
 */
export function startingPoint(
  source: NamedSession,
  visible: Iterable<NamedSession>,
  own?: NamedSession
): NamedSession {
  const origin = pointOf(source);
  const candidates: NamedSession[] = [source];
  for (const session of visible) {
    if (!continues(session, origin)) continue;
    if (candidates.some(c => samePoint(pointOf(c), pointOf(session)))) continue;
    candidates.push(session);
  }
  // A candidate that another candidate continued is already part of that one's conversation.
  const latest = candidates.filter(
    candidate =>
      !candidates.some(
        other => other !== candidate && other.lineage.some(p => samePoint(p, pointOf(candidate)))
      )
  );
  const onOwnBranch =
    own === undefined ? [] : latest.filter(candidate => continues(candidate, pointOf(own)));
  const branches = onOwnBranch.length > 0 ? onOwnBranch : latest;
  if (branches.length === 1) return branches[0];
  const paths = branches.map(pathOf);
  let shared = 0;
  while (
    paths.every(path => path[shared] !== undefined && samePoint(path[shared], paths[0][shared]))
  )
    shared++;
  // Every path holds `source`, so they share at least the points up to it.
  const point = paths[0][shared - 1];
  return {
    key: point.key,
    sessionId: point.sessionId,
    provider: source.provider,
    ...(point.checkpoint !== undefined ? { checkpoint: point.checkpoint } : {}),
    lineage: paths[0].slice(0, shared - 1),
  };
}

/** The session a node records when it completes, continuing `head` or starting fresh. */
export function completedNamedSession(
  key: string,
  provider: string,
  ended: { sessionId: string; checkpoint: string | undefined },
  head: NamedSession | undefined
): NamedSession {
  return {
    key,
    sessionId: ended.sessionId,
    provider,
    ...(ended.checkpoint !== undefined ? { checkpoint: ended.checkpoint } : {}),
    lineage: head === undefined ? [] : pathOf(head),
  };
}

/**
 * A node's record key: its id behind each enclosing loop_group and iteration, so the same
 * body node in two iterations has two keys. A top-level node's key is its id.
 */
export function namedSessionKey(
  loopGroupPath: readonly { groupId: string; iteration: number }[],
  nodeId: string
): string {
  return [...loopGroupPath.map(f => `${f.groupId}[${String(f.iteration)}]`), nodeId].join('.');
}

/**
 * A saved cursor as a session. A cursor saved before lineage existed has no key or lineage:
 * it gets `fallbackKey` and starts its own lineage.
 */
export function namedSessionOfCursor(
  cursor: NamedSessionCursor,
  fallbackKey: string
): NamedSession {
  return {
    key: cursor.key ?? fallbackKey,
    sessionId: cursor.sessionId,
    provider: cursor.provider,
    ...(cursor.checkpoint !== undefined ? { checkpoint: cursor.checkpoint } : {}),
    lineage: cursor.lineage ?? [],
  };
}

export function cursorOfNamedSession(session: NamedSession): NamedSessionCursor {
  return {
    sessionId: session.sessionId,
    provider: session.provider,
    key: session.key,
    ...(session.checkpoint !== undefined ? { checkpoint: session.checkpoint } : {}),
    lineage: [...session.lineage],
  };
}

const upstreamByLevel = new WeakMap<
  readonly (readonly DagNode[])[],
  ReadonlyMap<string, ReadonlySet<string>>
>();

/** Each node's dependencies at one graph level, direct and transitive. */
export function upstreamOf(
  layers: readonly (readonly DagNode[])[]
): ReadonlyMap<string, ReadonlySet<string>> {
  const cached = upstreamByLevel.get(layers);
  if (cached !== undefined) return cached;
  const nodes = new Map(layers.flat().map(node => [node.id, node]));
  const upstream = new Map<string, Set<string>>();
  const visit = (id: string): Set<string> => {
    const known = upstream.get(id);
    if (known !== undefined) return known;
    const deps = new Set<string>();
    upstream.set(id, deps);
    for (const dep of nodes.get(id)?.depends_on ?? []) {
      deps.add(dep);
      for (const transitive of visit(dep)) deps.add(transitive);
    }
    return deps;
  };
  for (const id of nodes.keys()) visit(id);
  upstreamByLevel.set(layers, upstream);
  return upstream;
}

/**
 * The named sessions a loop_group iteration's body starts with: those of the group's
 * dependencies, and each body node's latest session from earlier iterations. Both precede
 * every node of the iteration. Earlier iterations' sessions are keyed by record key, so a body
 * node's session in this iteration, keyed by its id, never replaces them, and which of them a
 * node sees does not depend on which siblings finished first.
 */
export function iterationNamedSessions(
  handles: ReadonlyMap<string, NamedSessionHandle> | undefined,
  upstreamOfGroup: ReadonlySet<string>,
  bodySessionCursors: ReadonlyMap<string, NamedSession> | undefined
): Map<string, NamedSessionHandle> | undefined {
  if (handles === undefined) return undefined;
  const inherited = new Map<string, NamedSessionHandle>();
  for (const [id, handle] of handles) {
    if (handle.producer === undefined || upstreamOfGroup.has(handle.producer)) {
      inherited.set(id, { ...handle, producer: undefined });
    }
  }
  for (const session of bodySessionCursors?.values() ?? []) {
    inherited.set(session.key, { ...session, producer: undefined });
  }
  return inherited;
}
