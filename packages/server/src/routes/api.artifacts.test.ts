import {
  mockGetWorkflowRun,
  mockArchonHome,
  setMockArchonHome,
  wsRoot,
  mockGetCodebase,
  MOCK_RUNNING_RUN,
  makeApp,
} from '../test/api-workflow-runs-harness';
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { getLog } from './api-route-kit';
import { removeTempTree } from '@archon/paths/test-utils';
import { mkdir, mkdtemp, symlink, writeFile, realpath, utimes } from 'fs/promises';
import * as fsPromises from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Tests: GET /api/runs/:runId/artifacts — the new artifact-listing endpoint
// ---------------------------------------------------------------------------

describe('GET /api/runs/:runId/artifacts', () => {
  // These cases write real files under the resolved artifact dir, so point the
  // fake ARCHON_HOME at an OS temp dir — a hard-coded '/tmp/...' is not an
  // absolute path on Windows. Torn down per case, so no cross-test leakage.
  const originalMockHome = mockArchonHome;
  beforeEach(async () => {
    setMockArchonHome(await mkdtemp(join(tmpdir(), 'archon-artifacts-home-')));
    mockGetWorkflowRun.mockReset();
    mockGetCodebase.mockReset();
  });

  afterEach(async () => {
    const used = mockArchonHome;
    setMockArchonHome(originalMockHome);
    await removeTempTree(used);
  });

  test.each([
    ['ENOENT', 200],
    ['EACCES', 200],
    ['EIO', 500],
  ] as const)('handles file metadata failure %s with status %d', async (code, status) => {
    const runId = 'run-stat-error';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    const target = join(dir, 'report.md');
    await writeFile(target, '# report');
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-local',
    });
    mockGetCodebase.mockResolvedValueOnce({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    });
    const { app } = makeApp();
    const metadata = spyOn(fsPromises, 'stat').mockRejectedValueOnce(
      Object.assign(new Error('artifact stat failed'), { code })
    );
    try {
      const response = await app.request(`/api/runs/${runId}/artifacts`);
      expect(metadata).toHaveBeenCalledWith(target);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(
        status === 200 ? { files: [] } : { error: 'Failed to list artifacts' }
      );
    } finally {
      metadata.mockRestore();
    }
  });

  test('returns 400 for invalid run ids (regex guard)', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/runs/has..slash/artifacts');
    expect(response.status).toBe(400);
  });

  test('returns 404 when the run does not exist', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => null);
    const { app } = makeApp();
    const response = await app.request('/api/runs/run-missing/artifacts');
    expect(response.status).toBe(404);
  });

  // #2200: an unresolvable output location is an explicit 404. An empty 200 was
  // indistinguishable from "the run produced nothing".
  test('returns 404 when run has no codebase_id and no output_root', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: 'run-orphan',
      codebase_id: null,
    }));
    const { app } = makeApp();
    const response = await app.request('/api/runs/run-orphan/artifacts');
    expect(response.status).toBe(404);
    expect(mockGetCodebase).not.toHaveBeenCalled();
  });

  test('resolves a bare-basename (_local) codebase instead of failing the parse', async () => {
    const runId = 'run-local-listing';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    const target = join(dir, 'plan.md');
    await writeFile(target, '# plan café');
    const modifiedAt = '2026-09-22T10:00:25.000Z';
    await utimes(target, new Date(modifiedAt), new Date(modifiedAt));
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-1',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/runs/${runId}/artifacts`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      files: [{ path: 'plan.md', size: 12, modifiedAt }],
    });
  });

  test('resolves a folder project to _folder/<slug> storage', async () => {
    const runId = 'run-folder-listing';
    const dir = join(wsRoot(), '_folder', 'my-ops-folder', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'report.md'), '# report');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-folder',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'My Ops Folder',
      kind: 'folder',
      default_cwd: '/srv/ops',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/runs/${runId}/artifacts`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: { path: string }[] };
    expect(body.files.map(f => f.path)).toEqual(['report.md']);
  });

  // Same rule as `archon workflow get`: only the engine's own root child is
  // left out, so the console and the CLI list the same files.
  test("hides only the engine's own store and lists a workflow's dotfiles", async () => {
    const runId = 'run-dotfiles-listing';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(join(dir, '.archon', 'typed-artifacts'), { recursive: true });
    await mkdir(join(dir, 'review', '.archon'), { recursive: true });
    await writeFile(join(dir, '.archon', 'typed-artifacts', 'listing.json'), '{}');
    await writeFile(join(dir, '.pr-number'), '42');
    await writeFile(join(dir, 'review', '.archon', 'notes.md'), 'notes');
    await writeFile(join(dir, 'plan.md'), '# plan');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-1',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/runs/${runId}/artifacts`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: { path: string }[] };
    expect(body.files.map(f => f.path).sort()).toEqual([
      '.pr-number',
      'plan.md',
      'review/.archon/notes.md',
    ]);
  });

  test('a persisted output_root wins over a codebase renamed since the run', async () => {
    const runId = 'run-persisted-root';
    const root = join(wsRoot(), 'acme', 'original');
    const dir = join(root, 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'out.md'), 'x');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-renamed',
      output_root: root,
      checkout_baseline: null,
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'acme/renamed-since',
      kind: 'repo',
      default_cwd: '/repos/renamed',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/runs/${runId}/artifacts`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: { path: string }[] };
    expect(body.files.map(f => f.path)).toEqual(['out.md']);
  });

  test.each(['page.html', 'page.HTM'])('serves %s as a sandboxed HTML page', async name => {
    const runId = 'run-serve-html';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), '<p>hi</p>');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-local',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    const response = await app.request(`http://localhost:3090/api/artifacts/${runId}/${name}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox allow-scripts allow-popups');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toContain('allow-forms');
    // No connect-src, so default-src 'none' keeps the page off Archon's API.
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('connect-src');
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain(`img-src data: http://localhost:3090/api/artifacts/${runId}/`);
    expect(await response.text()).toBe('<p>hi</p>');
  });

  describe("an HTML page named by the run's attention wait", () => {
    const runId = 'run-answer-page';
    const connectSrc =
      `connect-src http://localhost:3090/api/runs/${runId}/attention ` +
      `http://localhost:3090/api/workflows/runs/${runId}/answer`;
    const waitingRun = (
      wait: Record<string, unknown> | undefined,
      status: 'paused' | 'running' | 'cancelled' | 'completed' = 'paused'
    ) => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-local',
      status,
      metadata: (wait === undefined ? {} : { wait }) as Record<string, unknown>,
    });
    const attention = (extra: Record<string, unknown> = {}) => ({
      owner: 'node',
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: '2026-11-24T10:00:00.000Z',
      message: 'Review',
      pauseId: 'p-1',
      pages: ['review/page.html'],
      ...extra,
    });
    const answered = { answer: { text: 'ok' }, answeredVia: 'api' };

    async function csp(
      run: ReturnType<typeof waitingRun>,
      path: string,
      id = runId
    ): Promise<string> {
      const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', id);
      await mkdir(join(dir, 'review'), { recursive: true });
      await writeFile(join(dir, 'review', 'page.html'), '<p>q</p>');
      await writeFile(join(dir, 'other.html'), '<p>o</p>');
      mockGetWorkflowRun.mockImplementationOnce(async () => ({ ...run, id }));
      mockGetCodebase.mockImplementationOnce(async () => ({
        name: 'workspace',
        kind: 'repo',
        default_cwd: '/home/u/workspace',
      }));
      const { app } = makeApp();
      const response = await app.request(`http://localhost:3090/api/artifacts/${id}/${path}`);
      expect(response.status).toBe(200);
      return response.headers.get('content-security-policy') ?? '';
    }

    test('adds exactly the two addresses to the named page and leaves the rest of the policy', async () => {
      const named = await csp(waitingRun(attention()), 'review/page.html');
      const ordinary = await csp(waitingRun(undefined, 'running'), 'review/page.html');
      expect(named).toBe(`${ordinary}; ${connectSrc}`);
    });

    test.each([
      ['an unnamed page of the same run', waitingRun(attention()), 'other.html'],
      ['the named page once answered', waitingRun(attention(answered)), 'review/page.html'],
      ['the named page after the wait is gone', waitingRun(undefined), 'review/page.html'],
      [
        'the named page at a later wait that does not name it',
        waitingRun(attention({ pages: ['other.html'], pauseId: 'p-2' })),
        'review/page.html',
      ],
      ['the named page of a running run', waitingRun(attention(), 'running'), 'review/page.html'],
      [
        'the named page of a cancelled run',
        waitingRun(attention(), 'cancelled'),
        'review/page.html',
      ],
      [
        'the named page of a finished run',
        waitingRun(attention(), 'completed'),
        'review/page.html',
      ],
      [
        'a time wait',
        waitingRun({
          owner: 'node',
          nodeId: 'w',
          kind: 'time',
          waitingSince: '2026-11-24T10:00:00.000Z',
          resumeAt: '2026-11-25T10:00:00.000Z',
        }),
        'review/page.html',
      ],
    ])('gives %s no connect-src', async (_name, run, path) => {
      expect(await csp(run, path)).not.toContain('connect-src');
    });

    test('a page of another run gets none', async () => {
      // The page is named by run-answer-page's wait; this run has no wait.
      const other = await csp(waitingRun(undefined, 'running'), 'review/page.html', 'run-other');
      expect(other).not.toContain('connect-src');
    });

    test.each([
      ['./review/page.html'],
      ['review//page.html'],
      ['review/./page.html'],
      ['review%2Fpage.html'],
      ['%72eview/page.html'],
    ])('matches the named page when requested as %s', async path => {
      expect(await csp(waitingRun(attention()), path)).toContain(connectSrc);
    });

    test('encodes a run id in the addresses', async () => {
      const id = 'run with space';
      const policy = await csp(waitingRun(attention()), 'review/page.html', id);
      expect(policy).toContain(
        'connect-src http://localhost:3090/api/runs/run%20with%20space/attention ' +
          'http://localhost:3090/api/workflows/runs/run%20with%20space/answer'
      );
    });

    test('warns when a restricted CORS origin will refuse the named page', async () => {
      const warning = 'artifacts.answer_page_blocked_by_api_settings';
      const warn = spyOn(getLog(), 'warn');
      const original = process.env.WEB_UI_ORIGIN;
      try {
        delete process.env.WEB_UI_ORIGIN;
        await csp(waitingRun(attention()), 'review/page.html');
        process.env.WEB_UI_ORIGIN = 'http://ui.example';
        await csp(waitingRun(attention()), 'other.html');
        expect(warn).not.toHaveBeenCalledWith(expect.anything(), warning);
        await csp(waitingRun(attention()), 'review/page.html');
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ runId, filename: 'review/page.html' }),
          warning
        );
      } finally {
        if (original === undefined) delete process.env.WEB_UI_ORIGIN;
        else process.env.WEB_UI_ORIGIN = original;
        warn.mockRestore();
      }
    });

    // A sandboxed page has an opaque origin: its requests carry `Origin: null`, and its
    // JSON POST is preflighted.
    test.each([
      [`/api/runs/${runId}/attention`, 'GET'],
      [`/api/workflows/runs/${runId}/answer`, 'POST'],
    ])('answers the preflight for %s from an opaque origin', async (path, method) => {
      const { app } = makeApp();
      const response = await app.request(`http://localhost:3090${path}`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'null',
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-methods')).toContain(method);
      expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
        'content-type'
      );
    });

    test('lets an opaque-origin page read the attention response', async () => {
      mockGetWorkflowRun.mockImplementationOnce(async () => null);
      const { app } = makeApp();
      const response = await app.request(`http://localhost:3090/api/runs/${runId}/attention`, {
        headers: { Origin: 'null' },
      });
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    });
  });

  async function requestPage(base: string, headers: Record<string, string>): Promise<Response> {
    const runId = 'run-serve-page';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'page.html'), '<p>hi</p>');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-local',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    return app.request(`${base}/api/artifacts/${runId}/page.html`, { headers });
  }

  test.each([
    ['the request', 'http://127.0.0.1:4000', {}, 'http://127.0.0.1:4000'],
    [
      'the Vite dev proxy',
      'http://localhost:3090',
      { 'X-Forwarded-Host': 'localhost:5173', 'X-Forwarded-Proto': 'http' },
      'http://localhost:5173',
    ],
    [
      'an HTTPS proxy chain',
      'http://10.0.0.5:3090',
      { 'X-Forwarded-Host': 'archon.example, 10.0.0.2', 'X-Forwarded-Proto': 'https, http' },
      'https://archon.example',
    ],
  ])('takes the page origin from %s', async (_source, base, headers, origin) => {
    const response = await requestPage(base, headers);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain(
      `img-src data: ${origin}/api/artifacts/run-serve-page/`
    );
  });

  test('refuses an HTML page whose host cannot go in a policy', async () => {
    const response = await requestPage('http://localhost:3090', { 'X-Forwarded-Host': 'a;b' });
    expect(response.status).toBe(400);
  });

  test.each([
    ['shots/step-01.png', 'image/png'],
    ['photo.JPG', 'image/jpeg'],
  ])('serves %s byte for byte as %s', async (name, type) => {
    const runId = 'run-serve-image';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(join(dir, 'shots'), { recursive: true });
    // Not valid UTF-8, so a text read would corrupt it.
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xc3,
    ]);
    await writeFile(join(dir, name), bytes);
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-local',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    const response = await app.request(`http://localhost:3090/api/artifacts/${runId}/${name}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(type);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test.each([
    ['a.md', 'text/markdown; charset=utf-8'],
    // SVG can carry script, so it stays text.
    ['logo.svg', 'text/plain; charset=utf-8'],
  ])('serves %s as %s with no CSP', async (name, type) => {
    const runId = 'run-serve-nocsp';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), '<svg><script>alert(1)</script></svg>');
    mockGetWorkflowRun.mockImplementation(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-local',
    }));
    mockGetCodebase.mockImplementation(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/artifacts/${runId}/${name}`);
    expect(response.headers.get('content-type')).toBe(type);
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  test('an out-of-tree output_root falls through to re-derivation, keeping the tree relocatable', async () => {
    // Durability, not just correctness: move ARCHON_HOME (machine migration,
    // restored backup, the ARCHON_DATA split) and EVERY stamped root is
    // out-of-tree. Hard-failing here would permanently un-browse every
    // historical run whose artifacts are sitting right there under the new
    // home — and output_root is write-once via COALESCE, so the app could never
    // clear the column to recover.
    const runId = 'run-stale-root';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plan.md'), '# still here');

    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-1',
      // A root from the OLD home — the shape every run has after a relocation.
      output_root: '/previous/archon/home/workspaces/_local/workspace',
      checkout_baseline: null,
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));

    const { app } = makeApp();
    const response = await app.request(`/api/runs/${runId}/artifacts`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: { path: string }[] };
    expect(body.files.map(f => f.path)).toEqual(['plan.md']);
  });

  test('the containment guard still rejects a DERIVED path that escapes the tree', async () => {
    // The guard's live purpose after the fix: nothing re-derivable, and a
    // persisted root that cannot be trusted, must not serve a path outside
    // ARCHON_HOME.
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: 'run-escape-root',
      codebase_id: null,
      output_root: '/etc',
      checkout_baseline: null,
    }));
    const { app } = makeApp();
    const response = await app.request('/api/runs/run-escape-root/artifacts');
    // No codebase to re-derive from, and the persisted root is untrusted, so the
    // location is genuinely unresolvable.
    expect(response.status).toBe(404);
  });

  test('returns 500 + logs when the codebase lookup throws', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: 'run-db-err',
      codebase_id: 'cb-broken',
    }));
    mockGetCodebase.mockImplementationOnce(async () => {
      throw new Error('DB connection lost');
    });
    const { app } = makeApp();
    const response = await app.request('/api/runs/run-db-err/artifacts');
    expect(response.status).toBe(500);
  });

  // Traversal-shaped codebase names never produce a traversal path: they fail
  // parseOwnerRepo and fall through to `_local/<basename(default_cwd)>`, which
  // is a single sanitised segment. The result is a real (empty) project dir,
  // NOT an escape — and the ARCHON_HOME containment check is the second layer.
  test('a traversal-shaped codebase name resolves inside ARCHON_HOME, never outside it', async () => {
    for (const name of ['../../etc/passwd', 'a/b/c', '../repo', 'owner/..', 'ow ner/repo']) {
      mockGetWorkflowRun.mockImplementationOnce(async () => ({
        ...MOCK_RUNNING_RUN,
        id: 'run-bad-name',
        codebase_id: 'cb-bad',
      }));
      mockGetCodebase.mockImplementationOnce(async () => ({
        name,
        kind: 'repo',
        default_cwd: '/home/u/checkout',
      }));
      const { app } = makeApp();
      const response = await app.request('/api/runs/run-bad-name/artifacts');
      // Resolved to _local/checkout (which does not exist) → empty list, not an escape.
      expect(response.status).toBe(200);
      const body = (await response.json()) as { files: unknown[] };
      expect(body.files).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/artifacts/:runId/* — the artifact file-serving endpoint
// (owner/repo derivation only; content serving hits the real filesystem)
// ---------------------------------------------------------------------------

describe('GET /api/artifacts/:runId/* storage-key resolution', () => {
  // These cases write real files under the resolved artifact dir, so point the
  // fake ARCHON_HOME at an OS temp dir — a hard-coded '/tmp/...' is not an
  // absolute path on Windows. Torn down per case, so no cross-test leakage.
  const originalMockHome = mockArchonHome;
  beforeEach(async () => {
    setMockArchonHome(await mkdtemp(join(tmpdir(), 'archon-artifacts-home-')));
    mockGetWorkflowRun.mockReset();
    mockGetCodebase.mockReset();
  });

  afterEach(async () => {
    const used = mockArchonHome;
    setMockArchonHome(originalMockHome);
    await removeTempTree(used);
  });

  test.each([
    ['ENOENT', 404],
    ['EACCES', 500],
  ] as const)('maps a post-resolution read failure %s to %d', async (code, status) => {
    const runId = 'run-read-error';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    const target = join(dir, 'report.md');
    await mkdir(dir, { recursive: true });
    await writeFile(target, '# report');
    const resolvedTarget = await realpath(target);
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-local',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    const read = spyOn(fsPromises, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('artifact read failed'), { code })
    );
    try {
      const response = await app.request(`/api/artifacts/${runId}/report.md`);
      expect(read).toHaveBeenCalledWith(resolvedTarget);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: code === 'ENOENT' ? 'Artifact file not found' : 'Failed to read artifact file',
      });
    } finally {
      read.mockRestore();
    }
  });

  test('publishes the encoded filename contract without replacing wildcard serving', async () => {
    const { app } = makeApp();
    const document = app.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'Artifacts', version: '1' },
    });
    const operation = document.paths?.['/api/artifacts/{runId}/{filename}']?.get;
    expect(operation).toBeDefined();
    expect(operation?.parameters).toEqual([
      expect.objectContaining({ in: 'path', name: 'runId', required: true }),
      expect.objectContaining({ in: 'path', name: 'filename', required: true }),
    ]);
    expect(operation?.responses['200']).toEqual({
      description: 'Artifact file contents',
      content: {
        'text/plain': { schema: { type: 'string' } },
        'text/markdown': { schema: { type: 'string' } },
        'text/html': { schema: { type: 'string' } },
        'image/png': { schema: { type: 'string', format: 'binary' } },
        'image/jpeg': { schema: { type: 'string', format: 'binary' } },
        'image/gif': { schema: { type: 'string', format: 'binary' } },
        'image/webp': { schema: { type: 'string', format: 'binary' } },
      },
    });
    for (const status of ['400', '404', '500']) {
      expect(operation?.responses[status]).toEqual(
        expect.objectContaining({
          content: expect.objectContaining({ 'application/json': expect.anything() }),
        })
      );
    }
  });

  test.each(['review/a report 100%.md', 'review/nested/result.txt'])(
    'serves a complete encoded relative filename: %s',
    async filename => {
      const runId = 'run-encoded-content';
      const root = join(wsRoot(), '_local', 'workspace');
      const dir = join(root, 'artifacts', 'runs', runId);
      const target = join(dir, filename);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'encoded content café');
      mockGetWorkflowRun.mockResolvedValueOnce({
        ...MOCK_RUNNING_RUN,
        id: runId,
        codebase_id: null,
        output_root: root,
      });
      const { app } = makeApp();
      const response = await app.request(`/api/artifacts/${runId}/${encodeURIComponent(filename)}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('encoded content café');
    }
  );

  test('returns 404 when there is no codebase and no output_root to resolve from', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: 'run-serve-orphan',
      codebase_id: null,
    }));
    const { app } = makeApp();
    const response = await app.request('/api/artifacts/run-serve-orphan/plan.md');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('could not resolve');
  });

  test('serves a folder project’s artifact (404 before #2200)', async () => {
    const runId = 'run-serve-folder';
    const dir = join(wsRoot(), '_folder', 'my-ops-folder', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plan.md'), '# folder plan');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-folder',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'My Ops Folder',
      kind: 'folder',
      default_cwd: '/srv/ops',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/artifacts/${runId}/plan.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await response.text()).toBe('# folder plan');
  });

  test('serves a no-remote local repo’s artifact (404 before #2200)', async () => {
    const runId = 'run-serve-local';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plan.txt'), 'local plan');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-local',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/artifacts/${runId}/plan.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('local plan');
  });

  test('an out-of-tree output_root falls through to re-derivation and still serves', async () => {
    // Same relocation case as the list route: a stamped root from a previous
    // ARCHON_HOME must not permanently un-serve a run whose file is present.
    const runId = 'run-serve-stale-root';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plan.md'), '# still here');

    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-1',
      output_root: '/previous/archon/home/workspaces/_local/workspace',
      checkout_baseline: null,
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));

    const { app } = makeApp();
    const response = await app.request(`/api/artifacts/${runId}/plan.md`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# still here');
  });

  test('an untrusted output_root with nothing to re-derive from is unresolvable', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: 'run-serve-escape-root',
      codebase_id: null,
      output_root: '/etc',
      checkout_baseline: null,
    }));
    const { app } = makeApp();
    const response = await app.request('/api/artifacts/run-serve-escape-root/passwd');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('could not resolve');
  });

  test('a valid owner/repo name resolves and proceeds to the file read', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: 'run-serve-ok',
      codebase_id: 'cb-ok',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'acme/widgets',
      kind: 'repo',
      default_cwd: '/repos/widgets',
    }));
    const { app } = makeApp();
    const response = await app.request('/api/artifacts/run-serve-ok/plan.md');
    // Artifact dir does not exist on disk → ENOENT, distinct from the
    // unresolvable-location rejection above.
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Artifact file not found');
  });

  test('a backslash climb out of the artifacts directory is refused', async () => {
    // The route's `..` segment check splits on `/` only. On Windows `\` is a
    // separator too, so `..\` could leave the run's directory for a sibling run
    // whose name shares this one's prefix. The route refuses any `\`.
    const runId = 'run-serve-backslash';
    const runsDir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs');
    await mkdir(join(runsDir, runId), { recursive: true });
    await mkdir(join(runsDir, `${runId}-old`), { recursive: true });
    await writeFile(join(runsDir, `${runId}-old`, 'plan.md'), '# another run');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-local',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    const escape = encodeURIComponent(`..\\${runId}-old\\plan.md`);
    const response = await app.request(`/api/artifacts/${runId}/${escape}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid filename' });
  });

  test('an artifact pointer from a run result addresses this route with no extra machinery', async () => {
    // #2453 — a workflow result may carry { type, run_id, path }, validated by the
    // producing node (packages/workflows/src/artifact-pointer.ts) against its own run's
    // artifacts root. Those two fields ARE this route's parameters: the pointer needs no
    // resolution surface of its own. The read side owns reachability and real-path checks
    // by design; this route checks lexical and real-path containment at read time
    // for stable artifact paths (#3160).
    const runId = 'run-serve-pointer';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(join(dir, 'review'), { recursive: true });
    await writeFile(join(dir, 'review', 'report.md'), '# the full report');

    const pointer = { type: 'archon_artifact', run_id: runId, path: 'review/report.md' };

    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-local',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/artifacts/${pointer.run_id}/${pointer.path}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# the full report');
  });

  // Git-Bash cannot reliably create the symlinks these cases exercise.
  const isWin = process.platform === 'win32';

  test.skipIf(isWin)(
    'an escape symlink is refused with 404 and never leaks its target (#3160)',
    async () => {
      const runId = 'run-serve-symlink-escape';
      const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
      await mkdir(dir, { recursive: true });
      const sentinel = 'TOP_SECRET_SENTINEL_VALUE_DO_NOT_LEAK';
      await writeFile(join(mockArchonHome, 'secret.txt'), sentinel);
      await symlink(`../../../../../../secret.txt`, join(dir, 'escape.txt'));

      mockGetWorkflowRun.mockImplementationOnce(async () => ({
        ...MOCK_RUNNING_RUN,
        id: runId,
        codebase_id: 'cb-local',
      }));
      mockGetCodebase.mockImplementationOnce(async () => ({
        name: 'workspace',
        kind: 'repo',
        default_cwd: '/home/u/workspace',
      }));

      const { app } = makeApp();
      const response = await app.request(`/api/artifacts/${runId}/escape.txt`);

      expect(response.status).toBe(404);
      const bodyText = await response.text();
      expect(bodyText).not.toContain(sentinel);
      const body = JSON.parse(bodyText) as { error: string };
      expect(body.error).toBe('Artifact file not found');
    }
  );

  test.skipIf(isWin)(
    'a sibling symlink inside the artifacts directory is still served (#3160)',
    async () => {
      const runId = 'run-serve-symlink-sibling';
      const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'target.md'), '# sibling target');
      await symlink('target.md', join(dir, 'link.md'));

      mockGetWorkflowRun.mockImplementationOnce(async () => ({
        ...MOCK_RUNNING_RUN,
        id: runId,
        codebase_id: 'cb-local',
      }));
      mockGetCodebase.mockImplementationOnce(async () => ({
        name: 'workspace',
        kind: 'repo',
        default_cwd: '/home/u/workspace',
      }));

      const { app } = makeApp();
      const response = await app.request(`/api/artifacts/${runId}/link.md`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('# sibling target');
    }
  );

  test.skipIf(isWin)(
    'still serves when the workspace itself is a symlinked ancestor (#3160)',
    async () => {
      const runId = 'run-serve-symlinked-workspace';
      const realWs = join(mockArchonHome, 'real-ws');
      await mkdir(realWs, { recursive: true });
      await symlink(realWs, wsRoot());
      const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'plan.md'), '# under a symlinked workspace');

      mockGetWorkflowRun.mockImplementationOnce(async () => ({
        ...MOCK_RUNNING_RUN,
        id: runId,
        codebase_id: 'cb-local',
      }));
      mockGetCodebase.mockImplementationOnce(async () => ({
        name: 'workspace',
        kind: 'repo',
        default_cwd: '/home/u/workspace',
      }));

      const { app } = makeApp();
      const response = await app.request(`/api/artifacts/${runId}/plan.md`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('# under a symlinked workspace');
    }
  );
});
