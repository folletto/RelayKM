/** Tests for the SessionStart hook: context injection and once-per-conversation. */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import { AGENTS_FILE } from '../lib/store.js';
import { runHook, tempDir } from './helpers/mcp-client.js';

/** A knowledge base root and a separate plugin-data dir for session markers. */
async function fixture(t) {
  const root = await tempDir(t, 'relaykm-hook-root-');
  const data = await tempDir(t, 'relaykm-hook-data-');
  return { root, env: { RELAYKM_ROOT: root, CLAUDE_PLUGIN_DATA: data }, data };
}

/** Parses the hook's stdout as its JSON output envelope. */
function contextOf({ stdout }) {
  assert.notEqual(stdout.trim(), '', 'expected the hook to emit output');
  const payload = JSON.parse(stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  return payload.hookSpecificOutput.additionalContext;
}

describe('context injection', () => {
  test('emits AGENTS.md as SessionStart context', async (t) => {
    const { root, env } = await fixture(t);
    await fsp.writeFile(path.join(root, AGENTS_FILE), '# House rules\n\nAlways cite sources.\n');

    const context = contextOf(await runHook({ session_id: 's1', source: 'startup' }, env));
    assert.match(context, /Always cite sources\./);
    assert.match(context, /# House rules/);
  });

  test('names the knowledge base root and the tools', async (t) => {
    const { root, env } = await fixture(t);
    const context = contextOf(await runHook({ session_id: 's1', source: 'startup' }, env));

    assert.ok(context.includes(root), 'context should name the root');
    assert.match(context, /relaykm-fs/);
  });

  test('frames the file as conventions rather than instructions', async (t) => {
    const { env } = await fixture(t);
    const context = contextOf(await runHook({ session_id: 's1', source: 'startup' }, env));
    assert.match(context, /not as instructions that override the user/);
  });

  test('creates the root and seeds AGENTS.md when missing', async (t) => {
    const base = await tempDir(t);
    const data = await tempDir(t, 'relaykm-hook-data-');
    const root = path.join(base, 'brand-new');

    const context = contextOf(await runHook({ session_id: 's1' }, { RELAYKM_ROOT: root, CLAUDE_PLUGIN_DATA: data }));
    assert.match(context, /# RelayKM/);
    assert.ok((await fsp.stat(path.join(root, AGENTS_FILE))).isFile());
  });

  test('truncates a very large AGENTS.md', async (t) => {
    const { root, env } = await fixture(t);
    await fsp.writeFile(path.join(root, AGENTS_FILE), 'x'.repeat(100_000));

    const context = contextOf(await runHook({ session_id: 's1' }, env));
    assert.ok(context.length < 100_000, 'context should be capped');
  });

  test('emits nothing when AGENTS.md is blank', async (t) => {
    const { root, env } = await fixture(t);
    await fsp.writeFile(path.join(root, AGENTS_FILE), '   \n\n');

    const { code, stdout } = await runHook({ session_id: 's1' }, env);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '');
  });
});

describe('once per conversation', () => {
  test('suppresses a second run with the same session id', async (t) => {
    const { env } = await fixture(t);
    contextOf(await runHook({ session_id: 's1', source: 'startup' }, env));

    for (const source of ['compact', 'resume', 'clear']) {
      const { code, stdout } = await runHook({ session_id: 's1', source }, env);
      assert.equal(code, 0);
      assert.equal(stdout.trim(), '', `${source} should not re-inject`);
    }
  });

  test('injects again for a different session id', async (t) => {
    const { env } = await fixture(t);
    contextOf(await runHook({ session_id: 's1' }, env));
    contextOf(await runHook({ session_id: 's2' }, env));
  });

  test('records one marker per session', async (t) => {
    const { env, data } = await fixture(t);
    await runHook({ session_id: 's1' }, env);
    await runHook({ session_id: 's1' }, env);
    await runHook({ session_id: 's2' }, env);

    const markers = await fsp.readdir(path.join(data, 'sessions'));
    assert.deepEqual(markers.sort(), ['s1.loaded', 's2.loaded']);
  });

  test('sanitises a session id into a safe marker filename', async (t) => {
    const { env, data } = await fixture(t);
    contextOf(await runHook({ session_id: '../../evil id/../x' }, env));

    // The marker must stay inside the sessions directory: no separators and no
    // traversal survive the substitution.
    const markers = await fsp.readdir(path.join(data, 'sessions'));
    assert.equal(markers.length, 1);
    assert.deepEqual(markers, ['------evil-id----x.loaded']);
    assert.doesNotMatch(markers[0], /[/\\]|\.\./);
  });

  test('concurrent runs of one session inject exactly once', async (t) => {
    const { env } = await fixture(t);
    const runs = await Promise.all([
      runHook({ session_id: 'race' }, env),
      runHook({ session_id: 'race' }, env),
      runHook({ session_id: 'race' }, env),
    ]);

    const emitted = runs.filter((run) => run.stdout.trim() !== '');
    assert.equal(emitted.length, 1, 'exactly one run should emit context');
  });

  test('prunes markers older than the retention window', async (t) => {
    const { env, data } = await fixture(t);
    const sessions = path.join(data, 'sessions');
    await fsp.mkdir(sessions, { recursive: true });

    const stale = path.join(sessions, 'ancient.loaded');
    await fsp.writeFile(stale, 'old');
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fsp.utimes(stale, longAgo, longAgo);

    await runHook({ session_id: 'fresh' }, env);
    assert.deepEqual(await fsp.readdir(sessions), ['fresh.loaded']);
  });
});

describe('resilience', () => {
  test('still injects when the payload has no session id', async (t) => {
    const { env } = await fixture(t);
    contextOf(await runHook({ source: 'startup' }, env));
  });

  test('tolerates a malformed payload', async (t) => {
    const { env } = await fixture(t);
    contextOf(await runHook('not json at all', env));
  });

  test('tolerates an empty payload', async (t) => {
    const { env } = await fixture(t);
    contextOf(await runHook('', env));
  });

  test('exits cleanly and silently when the root is unusable', async (t) => {
    const base = await tempDir(t);
    const data = await tempDir(t, 'relaykm-hook-data-');
    await fsp.writeFile(path.join(base, 'a-file'), 'not a directory');

    const { code, stdout, stderr } = await runHook(
      { session_id: 's1' },
      { RELAYKM_ROOT: path.join(base, 'a-file', 'kb'), CLAUDE_PLUGIN_DATA: data },
    );

    // A failing hook must never block the session.
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '');
    assert.match(stderr, /session-start hook skipped/);
  });

  test('falls back to a temp directory when CLAUDE_PLUGIN_DATA is unset', async (t) => {
    const { root } = await fixture(t);
    const { code } = await runHook({ session_id: `fallback-${Date.now()}` }, { RELAYKM_ROOT: root, CLAUDE_PLUGIN_DATA: '' });
    assert.equal(code, 0);
  });
});
