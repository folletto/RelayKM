/**
 * Minimal MCP stdio transport: newline-delimited JSON-RPC 2.0 over
 * stdin/stdout. Keeping this dependency-free means the plugin works the moment
 * it is enabled, with no install step. Swap in @modelcontextprotocol/sdk here
 * if the server ever outgrows the handful of methods below.
 *
 * stdout carries protocol frames only. Diagnostics go to stderr.
 */

import { createInterface } from 'node:readline';

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export function log(...args) {
  console.error('[relaykm]', ...args);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * @param {Record<string, (params: object) => unknown>} methods
 *   Keyed by JSON-RPC method. Notifications (no `id`) are dispatched too; their
 *   return value is discarded.
 */
export function serve(methods) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;

    let request;
    try {
      request = JSON.parse(text);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: RPC.PARSE_ERROR, message: 'Invalid JSON' } });
      return;
    }

    // Responses to requests we never send, and batches, are not supported.
    if (Array.isArray(request) || typeof request !== 'object' || request === null) {
      write({ jsonrpc: '2.0', id: null, error: { code: RPC.INVALID_REQUEST, message: 'Invalid request' } });
      return;
    }

    const { id, method, params } = request;
    const isNotification = id === undefined || id === null;
    if (typeof method !== 'string') {
      if (!isNotification) {
        write({ jsonrpc: '2.0', id, error: { code: RPC.INVALID_REQUEST, message: 'Missing method' } });
      }
      return;
    }

    const handler = methods[method];
    if (!handler) {
      if (!isNotification) {
        write({ jsonrpc: '2.0', id, error: { code: RPC.METHOD_NOT_FOUND, message: `Unknown method: ${method}` } });
      }
      return;
    }

    try {
      const result = await handler(params ?? {});
      if (!isNotification) write({ jsonrpc: '2.0', id, result: result ?? {} });
    } catch (err) {
      if (isNotification) {
        log(`notification ${method} failed:`, err.message);
        return;
      }
      const code = err instanceof RpcError ? err.code : RPC.INTERNAL_ERROR;
      write({ jsonrpc: '2.0', id, error: { code, message: err.message, ...(err.data ? { data: err.data } : {}) } });
    }
  });

  rl.on('close', () => process.exit(0));
  process.stdin.on('error', (err) => {
    log('stdin error:', err.message);
    process.exit(0);
  });
}
