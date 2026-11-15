/**
 * The thread a Codex turn runs on: initialize the connection, log in, and start, resume or
 * fork the thread with the request's config and node scope.
 */
import { BUNDLED_VERSION, createLogger } from '@archon/paths';
import { sessionPreview } from '@archon/provider-contract';
import type { AppServerConnection } from './app-server';
import { withDeliveredCredentialConfig, type ThreadParams } from './login';
import { applyNodeScope, checkThreadMcpScope, readCodexInventory } from './scope';
import type { TurnRequest } from './stream';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.codex');
  return cachedLog;
}

/** A string at `value[key]`, or undefined: responses are read narrowly, not trusted whole. */
export function idAt(value: unknown, key: 'thread' | 'turn'): string | undefined {
  const nested =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  const id =
    typeof nested === 'object' && nested !== null ? (nested as { id?: unknown }).id : undefined;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** The Codex home the app-server reports in its `initialize` response, for error messages. */
function codexHomeOf(initializeResponse: unknown): string {
  const home =
    typeof initializeResponse === 'object' && initializeResponse !== null
      ? (initializeResponse as { codexHome?: unknown }).codexHome
      : undefined;
  return typeof home === 'string' && home.length > 0 ? home : 'the Codex home';
}

/**
 * Initialize the connection, log in, and start, continue or fork the thread with the
 * request's config, scoped to the node's plugins and MCP servers when it declares them.
 */
export async function openThread(request: TurnRequest): Promise<string> {
  const { connection, nodePlugins, login, tools } = request;
  const initialized = await connection.request('initialize', {
    clientInfo: { name: 'archon', title: 'Archon', version: BUNDLED_VERSION },
    // Host tools and external ChatGPT tokens both require Codex's experimental API.
    capabilities:
      tools.specs.length || login?.type === 'chatgptAuthTokens'
        ? { experimentalApi: true, requestAttestation: false }
        : null,
  });
  connection.notify('initialized');
  if (login) {
    // The credential stays in this process's memory: the app-server was started with the
    // ephemeral credential store, so nothing reaches the user's CODEX_HOME.
    await connection.request('account/login/start', login);
  }

  let { threadParams } = request;
  if (request.authoritativeCredential) {
    threadParams = await withDeliveredCredentialConfig(connection, request.cwd, threadParams);
  }
  let declared: string[] | undefined;
  if (nodePlugins) {
    const inventory = await readCodexInventory(connection, {
      cwd: request.cwd,
      plugins: nodePlugins,
      codexHome: codexHomeOf(initialized),
    });
    const scope = applyNodeScope(threadParams.config ?? {}, inventory, nodePlugins);
    threadParams = { ...threadParams, config: scope.config };
    declared = scope.declared;
  }
  const opened = request.resumeSessionId
    ? await continueThread(connection, request, request.resumeSessionId, threadParams)
    : {
        response: await connection.request('thread/start', {
          cwd: request.cwd,
          ...threadParams,
          ...(tools.specs.length ? { dynamicTools: tools.specs } : {}),
        }),
        forked: false,
      };
  const threadId = idAt(opened.response, 'thread');
  if (!threadId) throw new Error('Codex app-server returned a thread without an id');
  request.onThread(threadId);
  if (declared) await checkThreadMcpScope(connection, threadId, declared);
  getLog().debug(
    {
      sessionIdPreview: sessionPreview(threadId),
      resumed: !!request.resumeSessionId,
      forked: opened.forked,
      fromCheckpoint: request.sessionCheckpoint !== undefined,
    },
    'codex.thread_ready'
  );
  return threadId;
}

/**
 * Resume `threadId` in place, or fork it. With a checkpoint, the thread continues in place
 * only while the checkpoint is still its latest turn: a retry then never sees the turns a
 * failed attempt added, and its fork holds the thread through the checkpoint and no further.
 */
async function continueThread(
  connection: AppServerConnection,
  request: TurnRequest,
  threadId: string,
  threadParams: ThreadParams
): Promise<{ response: unknown; forked: boolean }> {
  const checkpoint = request.sessionCheckpoint;
  const forked =
    request.forkSession ||
    (checkpoint !== undefined && (await latestTurnId(connection, threadId)) !== checkpoint);
  // A resumed or forked thread needs the same config: Codex does not store it with the
  // thread, and a fork without it loads the user's MCP servers and plugins again.
  const params = { threadId, cwd: request.cwd, ...threadParams, excludeTurns: true };
  const response = forked
    ? await connection.request('thread/fork', {
        ...params,
        ...(checkpoint !== undefined ? { lastTurnId: checkpoint } : {}),
      })
    : await connection.request('thread/resume', params);
  return { response, forked };
}

/** The id of the thread's latest turn, or undefined for a thread without turns. */
async function latestTurnId(
  connection: AppServerConnection,
  threadId: string
): Promise<string | undefined> {
  const page = await connection.request('thread/turns/list', {
    threadId,
    limit: 1,
    sortDirection: 'desc',
    itemsView: 'notLoaded',
  });
  const turns =
    typeof page === 'object' && page !== null ? (page as { data?: unknown }).data : undefined;
  if (!Array.isArray(turns)) throw new Error('Codex app-server returned a turn list without data');
  const latest: unknown = turns[0];
  const id =
    typeof latest === 'object' && latest !== null ? (latest as { id?: unknown }).id : undefined;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
