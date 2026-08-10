/** Unit tests for root resolution and the path sandbox. */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  AGENTS_FILE,
  PathError,
  displayPath,
  ensureRoot,
  readAgentsFile,
  resolveWithin,
  rootPath,
} from '../lib/store.js';
import { tempDir } from './helpers/mcp-client.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

/** Creates the root and returns its real path. */
async function freshRoot(t) {
  const dir = await tempDir(t);
  process.env.RELAYKM_ROOT = dir;
  return ensureRoot();
}

describe('rootPath', () => {
  test('honours RELAYKM_ROOT', () => {
    process.env.RELAYKM_ROOT = '/somewhere/else';
    assert.equal(rootPath(), '/somewhere/else');
  });

  test('expands a leading ~', () => {
    process.env.RELAYKM_ROOT = '~/kb';
    assert.equal(rootPath(), path.join(os.homedir(), 'kb'));
  });

  test('ignores a blank override', () => {
    process.env.RELAYKM_ROOT = '   ';
    assert.equal(rootPath(), path.join(os.homedir(), 'Documents', 'RelayKM'));
  });

  test('defaults to Documents/RelayKM', () => {
    delete process.env.RELAYKM_ROOT;
    delete process.env.XDG_DOCUMENTS_DIR;
    assert.equal(rootPath(), path.join(os.homedir(), 'Documents', 'RelayKM'));
  });
});

describe('ensureRoot', () => {
  test('creates the root and seeds AGENTS.md', async (t) => {
    const root = await freshRoot(t);
    const seeded = await fsp.readFile(path.join(root, AGENTS_FILE), 'utf8');
    assert.match(seeded, /# RelayKM/);
  });

  test('creates missing parent directories', async (t) => {
    const base = await tempDir(t);
    process.env.RELAYKM_ROOT = path.join(base, 'deeply', 'nested', 'kb');
    const root = await ensureRoot();
    assert.ok((await fsp.stat(root)).isDirectory());
  });

  test('is idempotent and never overwrites an existing AGENTS.md', async (t) => {
    const root = await freshRoot(t);
    await fsp.writeFile(path.join(root, AGENTS_FILE), 'mine\n');
    await ensureRoot();
    assert.equal(await fsp.readFile(path.join(root, AGENTS_FILE), 'utf8'), 'mine\n');
  });

  test('resolves a symlinked root to its real path', async (t) => {
    const base = await tempDir(t);
    const real = path.join(base, 'real-kb');
    const link = path.join(base, 'link-kb');
    await fsp.mkdir(real);
    await fsp.symlink(real, link);

    process.env.RELAYKM_ROOT = link;
    assert.equal(await ensureRoot(), real);
  });
});

describe('resolveWithin', () => {
  test('resolves "." and "" to the root itself', async (t) => {
    const root = await freshRoot(t);
    assert.equal(await resolveWithin(root, '.'), root);
    assert.equal(await resolveWithin(root, ''), root);
    assert.equal(await resolveWithin(root, undefined), root);
  });

  test('resolves a relative path under the root', async (t) => {
    const root = await freshRoot(t);
    assert.equal(await resolveWithin(root, 'notes/a.md'), path.join(root, 'notes', 'a.md'));
  });

  test('accepts an absolute path that is already inside the root', async (t) => {
    const root = await freshRoot(t);
    const inside = path.join(root, 'notes', 'a.md');
    assert.equal(await resolveWithin(root, inside), inside);
  });

  test('normalises interior traversal that stays inside', async (t) => {
    const root = await freshRoot(t);
    assert.equal(await resolveWithin(root, 'notes/../inbox/a.md'), path.join(root, 'inbox', 'a.md'));
  });

  for (const escape of ['..', '../outside.md', '../../../../etc/hosts', 'notes/../../outside.md']) {
    test(`rejects traversal: ${escape}`, async (t) => {
      const root = await freshRoot(t);
      await assert.rejects(() => resolveWithin(root, escape), PathError);
    });
  }

  test('rejects an absolute path outside the root', async (t) => {
    const root = await freshRoot(t);
    await assert.rejects(() => resolveWithin(root, '/etc/hosts'), PathError);
  });

  test('rejects a home-relative path outside the root', async (t) => {
    const root = await freshRoot(t);
    await assert.rejects(() => resolveWithin(root, '~/escaped.md'), PathError);
  });

  test('rejects a path reached through a symlink that leaves the root', async (t) => {
    const root = await freshRoot(t);
    const outside = await tempDir(t, 'relaykm-outside-');
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fsp.symlink(outside, path.join(root, 'escape-link'));

    // Existing target, and a target that does not exist yet: both must fail,
    // since containment is checked after resolving symlinks either way.
    await assert.rejects(() => resolveWithin(root, 'escape-link/secret.txt'), PathError);
    await assert.rejects(() => resolveWithin(root, 'escape-link/new-file.md'), PathError);
  });

  test('allows a symlink that stays inside the root', async (t) => {
    const root = await freshRoot(t);
    await fsp.mkdir(path.join(root, 'real'));
    await fsp.symlink(path.join(root, 'real'), path.join(root, 'alias'));

    // The lexical path is returned, not the resolved one: symlinks inside the
    // root are followed by the filesystem, and callers keep the path they asked
    // for. Only the containment check runs against the resolved path.
    assert.equal(await resolveWithin(root, 'alias/note.md'), path.join(root, 'alias', 'note.md'));
  });

  test('rejects a non-string path', async (t) => {
    const root = await freshRoot(t);
    await assert.rejects(() => resolveWithin(root, 42), PathError);
  });
});

describe('displayPath', () => {
  test('renders the root as "." and nested paths POSIX-style', async (t) => {
    const root = await freshRoot(t);
    assert.equal(displayPath(root, root), '.');
    assert.equal(displayPath(root, path.join(root, 'notes', 'a.md')), 'notes/a.md');
  });
});

describe('readAgentsFile', () => {
  test('returns the file contents', async (t) => {
    const root = await freshRoot(t);
    await fsp.writeFile(path.join(root, AGENTS_FILE), 'hello\n');
    assert.equal(await readAgentsFile(root), 'hello\n');
  });

  test('truncates to the byte cap', async (t) => {
    const root = await freshRoot(t);
    await fsp.writeFile(path.join(root, AGENTS_FILE), 'x'.repeat(100));
    assert.equal((await readAgentsFile(root, 10)).length, 10);
  });

  test('returns null when the file is missing', async (t) => {
    const root = await freshRoot(t);
    await fsp.rm(path.join(root, AGENTS_FILE));
    assert.equal(await readAgentsFile(root), null);
  });
});
