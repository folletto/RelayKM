/** Integration tests: drives mcp/server.js over its real stdio transport. */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import { startServer, tempDir, textOf } from './helpers/mcp-client.js';

const TOOL_NAMES = ['list_folder', 'create_folder', 'delete_folder', 'read_file', 'write_file', 'delete_file'];

/** A started, initialized server over a fresh empty root. */
async function connect(t) {
  const root = await tempDir(t);
  const client = startServer(t, root);
  await client.initialize();
  return { root, client };
}

const ok = (result) => {
  assert.ok(!result.isError, `expected success, got: ${textOf(result)}`);
  return textOf(result);
};

const failed = (result) => {
  assert.ok(result.isError, `expected a tool error, got: ${textOf(result)}`);
  return textOf(result);
};

describe('protocol', () => {
  test('initialize advertises tools and the knowledge base root', async (t) => {
    const { root, client } = await connect(t);
    const result = await client.request('initialize', { protocolVersion: '2025-06-18' });

    assert.equal(result.result.serverInfo.name, 'relaykm-fs');
    assert.deepEqual(result.result.capabilities.tools, { listChanged: false });
    assert.match(result.result.instructions, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('echoes a supported protocol version', async (t) => {
    const { client } = await connect(t);
    const { result } = await client.request('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(result.protocolVersion, '2024-11-05');
  });

  test('falls back to its preferred version for an unknown one', async (t) => {
    const { client } = await connect(t);
    const { result } = await client.request('initialize', { protocolVersion: '1999-01-01' });
    assert.equal(result.protocolVersion, '2025-06-18');
  });

  test('tools/list returns every tool with an input schema', async (t) => {
    const { client } = await connect(t);
    const { result } = await client.request('tools/list');

    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} has no object schema`);
      assert.ok(tool.description.length > 0, `${tool.name} has no description`);
    }
  });

  test('ping responds', async (t) => {
    const { client } = await connect(t);
    const { result } = await client.request('ping');
    assert.deepEqual(result, {});
  });

  test('unknown method is a method-not-found error', async (t) => {
    const { client } = await connect(t);
    const { error } = await client.request('does/not/exist');
    assert.equal(error.code, -32601);
  });

  test('unknown tool is an invalid-params error', async (t) => {
    const { client } = await connect(t);
    const { error } = await client.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(error.code, -32602);
  });

  test('malformed JSON is a parse error with a null id', async (t) => {
    const { client } = await connect(t);
    client.sendRaw('this is not json');

    const message = await client.takeUnmatched();
    assert.equal(message.id, null);
    assert.equal(message.error.code, -32700);
  });

  test('a notification draws no response', async (t) => {
    const { client } = await connect(t);
    client.notify('notifications/initialized');
    client.notify('ping');

    // A round trip after the notifications: if either had produced a response,
    // it would be sitting in the unmatched queue by now.
    await client.request('ping');
    assert.equal(client.unmatchedCount(), 0);
  });

  test('blank lines are ignored', async (t) => {
    const { client } = await connect(t);
    client.sendRaw('');
    client.sendRaw('   ');
    const { result } = await client.request('ping');
    assert.deepEqual(result, {});
  });
});

describe('folders', () => {
  test('creates nested folders and lists them', async (t) => {
    const { client } = await connect(t);
    ok(await client.callTool('create_folder', { path: 'notes/2026' }));

    const listing = ok(await client.callTool('list_folder', { path: '.', recursive: true }));
    assert.match(listing, /dir\s+notes\//);
    assert.match(listing, /dir\s+notes\/2026\//);
  });

  test('create_folder on an existing folder succeeds without changes', async (t) => {
    const { client } = await connect(t);
    ok(await client.callTool('create_folder', { path: 'notes' }));
    assert.match(ok(await client.callTool('create_folder', { path: 'notes' })), /already exists/);
  });

  test('create_folder refuses a path occupied by a file', async (t) => {
    const { client } = await connect(t);
    ok(await client.callTool('write_file', { path: 'a.md', content: 'x' }));
    assert.match(failed(await client.callTool('create_folder', { path: 'a.md' })), /not a folder/);
  });

  test('list_folder defaults to the root', async (t) => {
    const { client } = await connect(t);
    assert.match(ok(await client.callTool('list_folder', {})), /AGENTS\.md/);
  });

  test('list_folder is shallow unless recursive', async (t) => {
    const { client } = await connect(t);
    ok(await client.callTool('write_file', { path: 'notes/deep/a.md', content: 'x' }));

    const shallow = ok(await client.callTool('list_folder', { path: '.' }));
    assert.doesNotMatch(shallow, /a\.md/);
    assert.match(ok(await client.callTool('list_folder', { path: '.', recursive: true })), /notes\/deep\/a\.md/);
  });

  test('list_folder reports an empty folder', async (t) => {
    const { client } = await connect(t);
    ok(await client.callTool('create_folder', { path: 'empty' }));
    assert.match(ok(await client.callTool('list_folder', { path: 'empty' })), /\(empty\)/);
  });

  test('list_folder truncates at max_entries', async (t) => {
    const { client } = await connect(t);
    for (let i = 0; i < 5; i += 1) {
      ok(await client.callTool('write_file', { path: `n${i}.md`, content: 'x' }));
    }
    assert.match(ok(await client.callTool('list_folder', { path: '.', max_entries: 2 })), /truncated at 2/);
  });

  test('list_folder refuses a file', async (t) => {
    const { client } = await connect(t);
    assert.match(failed(await client.callTool('list_folder', { path: 'AGENTS.md' })), /is a file, not a folder/);
  });

  test('delete_folder refuses a non-empty folder without recursive', async (t) => {
    const { client } = await connect(t);
    ok(await client.callTool('write_file', { path: 'notes/a.md', content: 'x' }));
    assert.match(failed(await client.callTool('delete_folder', { path: 'notes' })), /not empty/);
  });

  test('delete_folder removes a tree when recursive', async (t) => {
    const { root, client } = await connect(t);
    ok(await client.callTool('write_file', { path: 'notes/deep/a.md', content: 'x' }));
    ok(await client.callTool('delete_folder', { path: 'notes', recursive: true }));

    await assert.rejects(() => fsp.stat(path.join(root, 'notes')));
  });

  test('delete_folder refuses the root itself', async (t) => {
    const { client } = await connect(t);
    for (const target of ['.', '']) {
      assert.match(failed(await client.callTool('delete_folder', { path: target })), /required|cannot be deleted/);
    }
  });

  test('delete_folder refuses a file', async (t) => {
    const { client } = await connect(t);
    assert.match(failed(await client.callTool('delete_folder', { path: 'AGENTS.md' })), /use delete_file/);
  });

  test('delete_folder reports a missing folder', async (t) => {
    const { client } = await connect(t);
    assert.match(failed(await client.callTool('delete_folder', { path: 'ghost' })), /not found/);
  });
});

describe('files', () => {
  test('writes, appends, and reads back', async (t) => {
    const { client } = await connect(t);
    assert.match(ok(await client.callTool('write_file', { path: 'a.md', content: '# Hello\n' })), /Created/);
    assert.match(ok(await client.callTool('write_file', { path: 'a.md', content: 'more\n', mode: 'append' })), /Appended/);
    assert.equal(ok(await client.callTool('read_file', { path: 'a.md' })), '# Hello\nmore\n');
  });

  test('overwrite replaces the whole file and reports an update', async (t) => {
    const { client } = await connect(t);
    ok(await client.callTool('write_file', { path: 'a.md', content: 'first\n' }));
    assert.match(ok(await client.callTool('write_file', { path: 'a.md', content: 'second\n' })), /Updated/);
    assert.equal(ok(await client.callTool('read_file', { path: 'a.md' })), 'second\n');
  });

  test('write_file creates missing parent folders', async (t) => {
    const { client } = await connect(t);
    ok(await client.callTool('write_file', { path: 'a/b/c/deep.md', content: 'x' }));
    assert.equal(ok(await client.callTool('read_file', { path: 'a/b/c/deep.md' })), 'x');
  });

  test('write_file rejects a non-string body and an unknown mode', async (t) => {
    const { client } = await connect(t);
    assert.match(failed(await client.callTool('write_file', { path: 'a.md', content: 42 })), /content must be a string/);
    assert.match(failed(await client.callTool('write_file', { path: 'a.md', content: 'x', mode: 'sideways' })), /mode must be/);
  });

  test('write_file refuses a folder path', async (t) => {
    const { client } = await connect(t);
    ok(await client.callTool('create_folder', { path: 'notes' }));
    assert.match(failed(await client.callTool('write_file', { path: 'notes', content: 'x' })), /is a folder/);
  });

  test('read_file truncates at max_bytes', async (t) => {
    const { client } = await connect(t);
    ok(await client.callTool('write_file', { path: 'big.md', content: 'x'.repeat(500) }));

    const body = ok(await client.callTool('read_file', { path: 'big.md', max_bytes: 10 }));
    assert.match(body, /\[truncated at 10 of 500 bytes\]/);
  });

  test('read_file refuses a binary file', async (t) => {
    const { root, client } = await connect(t);
    await fsp.writeFile(path.join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
    assert.match(failed(await client.callTool('read_file', { path: 'blob.bin' })), /binary/);
  });

  test('read_file refuses a folder and reports a missing file', async (t) => {
    const { client } = await connect(t);
    ok(await client.callTool('create_folder', { path: 'notes' }));
    assert.match(failed(await client.callTool('read_file', { path: 'notes' })), /use list_folder/);
    assert.match(failed(await client.callTool('read_file', { path: 'ghost.md' })), /not found/);
  });

  test('read_file requires a path', async (t) => {
    const { client } = await connect(t);
    assert.match(failed(await client.callTool('read_file', {})), /path is required/);
  });

  test('delete_file removes a file and refuses a folder', async (t) => {
    const { root, client } = await connect(t);
    ok(await client.callTool('write_file', { path: 'a.md', content: 'x' }));
    ok(await client.callTool('delete_file', { path: 'a.md' }));
    await assert.rejects(() => fsp.stat(path.join(root, 'a.md')));

    ok(await client.callTool('create_folder', { path: 'notes' }));
    assert.match(failed(await client.callTool('delete_file', { path: 'notes' })), /use delete_folder/);
  });
});

describe('sandbox', () => {
  const escapes = [
    ['parent traversal', '../outside.md'],
    ['deep traversal', '../../../../etc/hosts'],
    ['absolute path', '/etc/hosts'],
    ['home-relative path', '~/escaped.md'],
    ['interior traversal', 'notes/../../outside.md'],
  ];

  for (const [label, target] of escapes) {
    test(`read_file refuses ${label}`, async (t) => {
      const { client } = await connect(t);
      assert.match(failed(await client.callTool('read_file', { path: target })), /outside the RelayKM root/);
    });

    test(`write_file refuses ${label}`, async (t) => {
      const { client } = await connect(t);
      assert.match(failed(await client.callTool('write_file', { path: target, content: 'pwned' })), /outside the RelayKM root/);
    });
  }

  test('refuses paths reached through a symlink that leaves the root', async (t) => {
    const { root, client } = await connect(t);
    const outside = await tempDir(t, 'relaykm-outside-');
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fsp.symlink(outside, path.join(root, 'escape-link'));

    assert.match(failed(await client.callTool('read_file', { path: 'escape-link/secret.txt' })), /outside the RelayKM root/);
    assert.match(failed(await client.callTool('write_file', { path: 'escape-link/new.md', content: 'x' })), /outside the RelayKM root/);
    assert.match(failed(await client.callTool('delete_file', { path: 'escape-link/secret.txt' })), /outside the RelayKM root/);
    assert.match(failed(await client.callTool('list_folder', { path: 'escape-link' })), /outside the RelayKM root/);

    // The file outside the root is untouched.
    assert.equal(await fsp.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'secret');
  });

  test('a write that escapes leaves nothing behind', async (t) => {
    // The root is nested inside the fixture, so the directory the escape aims
    // at is owned by this test rather than the shared temp directory.
    const base = await tempDir(t);
    const client = startServer(t, path.join(base, 'kb'));
    await client.initialize();

    failed(await client.callTool('write_file', { path: '../escaped.md', content: 'pwned' }));
    await assert.rejects(() => fsp.stat(path.join(base, 'escaped.md')));
  });
});

describe('startup', () => {
  test('creates the root and seeds AGENTS.md on first connection', async (t) => {
    const base = await tempDir(t);
    const root = path.join(base, 'not-yet-there');
    const client = startServer(t, root);
    await client.initialize();

    assert.match(ok(await client.callTool('read_file', { path: 'AGENTS.md' })), /# RelayKM/);
  });

  test('exits non-zero when the root cannot be created', async (t) => {
    const base = await tempDir(t);
    await fsp.writeFile(path.join(base, 'a-file'), 'not a directory');

    const client = startServer(t, path.join(base, 'a-file', 'kb'));
    assert.equal(await client.exited, 1);
    assert.match(client.stderr(), /could not open the RelayKM root/);
  });
});
