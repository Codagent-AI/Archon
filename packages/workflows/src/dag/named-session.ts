/**
 * Named session lineage (`context: { resume }`): the point a node's conversation continues
 * from.
 *
 * A node that names X continues X's conversation together with the turns of every node that
 * continued X's conversation and that the node depends on, directly or through other nodes.
 * Inside a loop_group body, earlier iterations count as dependencies. When two of those nodes
 * are on different branches, the node continues from the last point they share, so two nodes
 * that can run at the same time never write one conversation together. That point records
 * the branches it resolved, so a node that depends on the resolving node continues the
 * resolving node's conversation rather than going back to the shared point.
 *
 * Which nodes count is fixed by the graph and by which of the node's dependencies completed,
 * never by timing: a sibling that happens to finish first is not a dependency.
 */
import type {
  DagNode,
  NamedSessionBranch,
  NamedSessionCursor,
  NamedSessionPoint,
} from '../schemas';
import { isLoopGroupNode } from '../schemas';
import { resolvedBodyNodes } from '../graph-plan';

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
  /**
   * For a starting point that is the last point several branches share, the points of those
   * branches and what they resolved: the node that continues from it resolves them.
   */
  merged?: readonly NamedSessionBranch[];
}

/** A named session as one graph level holds it. */
export interface NamedSessionHandle extends NamedSession {
  /**
   * The node at this level whose completion produced it, or undefined for a session that an
   * enclosing level or an earlier iteration produced, which precedes every node at this level.
   */
  producer: string | undefined;
}

/** A starting point a provider can continue in place: one that reports its last turn. */
export type CheckpointedSession = NamedSession & { checkpoint: string };

export function pointOf(session: NamedSession): NamedSessionPoint {
  return {
    key: session.key,
    sessionId: session.sessionId,
    ...(session.checkpoint !== undefined ? { checkpoint: session.checkpoint } : {}),
    ...(session.merged !== undefined ? { merged: [...session.merged] } : {}),
  };
}

function branchOf(point: NamedSessionBranch): NamedSessionBranch {
  return {
    key: point.key,
    sessionId: point.sessionId,
    ...(point.checkpoint !== undefined ? { checkpoint: point.checkpoint } : {}),
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
export function samePoint(a: NamedSessionBranch, b: NamedSessionBranch): boolean {
  return a.key === b.key && a.sessionId === b.sessionId && a.checkpoint === b.checkpoint;
}

function continues(session: NamedSession, point: NamedSessionPoint): boolean {
  return pathOf(session).some(p => samePoint(p, point));
}

/**
 * Whether `point` is part of `session`'s conversation: `session` continued it, or continued
 * a point that resolved its branch.
 */
function holds(session: NamedSession, point: NamedSessionPoint): boolean {
  return pathOf(session).some(
    p => samePoint(p, point) || p.merged?.some(branch => samePoint(branch, point)) === true
  );
}

/**
 * The point a node naming `source` continues from: the latest of `source` and the sessions in
 * `visible` that continued it. `visible` must hold only sessions of the node's dependencies.
 * When those sessions are on different branches, a loop_group body node with a session from
 * an earlier iteration (`own`) keeps to the branches that hold it; otherwise the point is the
 * last one they share, and it records those branches as resolved.
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
  // A candidate that another candidate holds is already part of that one's conversation.
  // Candidates are distinct points, so a candidate never holds another through its own point.
  const latest = candidates.filter(
    candidate => !candidates.some(other => other !== candidate && holds(other, pointOf(candidate)))
  );
  const onOwnBranch =
    own === undefined ? [] : latest.filter(candidate => holds(candidate, pointOf(own)));
  const branches = onOwnBranch.length > 0 ? onOwnBranch : latest;
  if (branches.length === 1) return branches[0];
  const paths = branches.map(pathOf);
  let shared = 0;
  while (
    paths.every(path => path[shared] !== undefined && samePoint(path[shared], paths[0][shared]))
  )
    shared++;
  // Every path holds `source`, so they share at least the points up to it. Each path's copy of
  // a shared point may record different resolved branches; the shared path keeps them all.
  const sharedPath = paths[0].slice(0, shared).map((point, i) =>
    withMerged(
      point,
      paths.flatMap(path => path[i].merged ?? [])
    )
  );
  const point = sharedPath[shared - 1];
  // The node resolves every point past the shared one, and what those points resolved.
  const resolved = paths
    .flatMap(path => path.slice(shared))
    .flatMap(p => [branchOf(p), ...(p.merged ?? [])]);
  return {
    key: point.key,
    sessionId: point.sessionId,
    provider: source.provider,
    ...(point.checkpoint !== undefined ? { checkpoint: point.checkpoint } : {}),
    lineage: sharedPath.slice(0, -1),
    merged: distinctBranches([...(point.merged ?? []), ...resolved]),
  };
}

function distinctBranches(branches: readonly NamedSessionBranch[]): NamedSessionBranch[] {
  return branches.filter((branch, i) => branches.findIndex(b => samePoint(b, branch)) === i);
}

function withMerged(
  point: NamedSessionPoint,
  merged: readonly NamedSessionBranch[]
): NamedSessionPoint {
  const { merged: _, ...plain } = point;
  return merged.length > 0 ? { ...plain, merged: distinctBranches(merged) } : plain;
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
 * The ids under which a loop_group keeps its body's named sessions, each with its node: every
 * body node on a session lineage, and every such node of a nested loop_group behind the
 * nested group's id (`inner.owner`). A completed nested group's sessions are the enclosing
 * group's too, so its later iterations and the nodes after it continue them.
 */
export function bodySessionIds(
  bodyNodes: readonly DagNode[],
  namedSessionNodeIds: ReadonlySet<string>
): Map<string, DagNode> {
  const ids = new Map<string, DagNode>();
  for (const node of bodyNodes) {
    if (namedSessionNodeIds.has(node.id)) ids.set(node.id, node);
    if (!isLoopGroupNode(node)) continue;
    for (const [id, nested] of bodySessionIds(
      resolvedBodyNodes(node.loop_group),
      namedSessionNodeIds
    )) {
      ids.set(`${node.id}.${id}`, nested);
    }
  }
  return ids;
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
