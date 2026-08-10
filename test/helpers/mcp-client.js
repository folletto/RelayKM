/**
 * Test helper: drives mcp/server.js over its real stdio transport.
 *
 * Requests are matched to responses by id, so out-of-order replies are fine.
 * Messages that match no pending request (parse errors, which carry a null id)
 * land in a queue that `takeUnmatched` drains.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../mcp/server.js', import.meta.url));
const HOOK = fileURLToPath(new URL('../../hooks/session-start.js', import.meta.url));
const TIMEOUT_MS = 10_000;

/** A fresh temp directory, removed when the test context ends. */
export async function tempDir(t, prefix = 'relaykm-test-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return fsp.realpath(dir);
}

export function startServer(t, root, env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, RELAYKM_ROOT: root, ...env },
  });

  const pending = new Map();
  const unmatched = [];
  const waiters = [];
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  // 'close' rather than 'exit', so stderr is fully flushed when this settles.
  const exited = new Promise((resolve) => child.on('close', resolve));

  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    const resolve = message.id != null && pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
      return;
    }
    unmatched.push(message);
    waiters.shift()?.();
  });

  t.after(() => child.kill());

  let nextId = 0;
  const sendRaw = (text) => child.stdin.write(`${text}\n`);

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, resolve);
      sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timed out waiting for ${method}\nstderr: ${stderr}`));
      }, TIMEOUT_MS);
      timer.unref();
    });

  const notify = (method, params) => sendRaw(JSON.stringify({ jsonrpc: '2.0', method, params }));

  /** Resolves with the next message that matched no pending request. */
  const takeUnmatched = () =>
    unmatched.length
      ? Promise.resolve(unmatched.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timed out waiting for an unmatched message')), TIMEOUT_MS);
          timer.unref();
          waiters.push(() => {
            clearTimeout(timer);
            resolve(unmatched.shift());
          });
        });

  /** Calls a tool and returns its result envelope. */
  const callTool = async (name, args = {}) => {
    const { result, error } = await request('tools/call', { name, arguments: args });
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return result;
  };

  return {
    request,
    notify,
    sendRaw,
    takeUnmatched,
    callTool,
    exited,
    pendingCount: () => pending.size,
    unmatchedCount: () => unmatched.length,
    stderr: () => stderr,
    async initialize(protocolVersion = '2025-06-18') {
      const { result } = await request('initialize', { protocolVersion, capabilities: {} });
      notify('notifications/initialized');
      return result;
    },
  };
}

/** First text block of a tool result. */
export const textOf = (result) => result.content[0].text;

/** Runs the SessionStart hook once and returns its exit code and streams. */
export function runHook(payload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}
