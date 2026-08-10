#!/usr/bin/env node
/**
 * RelayKM filesystem MCP server.
 *
 * Exposes the RelayKM knowledge base (default: <Documents>/RelayKM) as a small
 * set of filesystem tools. Every path is resolved inside the root; nothing
 * outside it is reachable.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { RPC, RpcError, log, serve } from '../lib/rpc.js';
import {
  AGENTS_FILE,
  DEFAULT_MAX_READ_BYTES,
  PathError,
  displayPath,
  ensureRoot,
  resolveWithin,
  rootPath,
} from '../lib/store.js';

const SERVER_INFO = { name: 'relaykm-fs', version: '0.1.0' };
const PREFERRED_PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set([PREFERRED_PROTOCOL, '2025-03-26', '2024-11-05']);

const MAX_LIST_ENTRIES = 2000;
const DEFAULT_LIST_ENTRIES = 500;

/** Resolved once at startup; the root is created if it does not exist yet. */
let ROOT = null;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const stringProp = (description) => ({ type: 'string', description });

const TOOLS = [
  {
    name: 'list_folder',
    title: 'List folder',
    description:
      'List the contents of a folder in the RelayKM knowledge base. Use "." for the root. ' +
      'Returns each entry with its type and, for files, its size in bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: stringProp('Folder path relative to the RelayKM root. Defaults to the root.'),
        recursive: { type: 'boolean', description: 'Walk subfolders as well. Defaults to false.' },
        max_entries: {
          type: 'number',
          description: `Cap on entries returned (default ${DEFAULT_LIST_ENTRIES}, max ${MAX_LIST_ENTRIES}).`,
        },
      },
      additionalProperties: false,
    },
    handler: listFolder,
  },
  {
    name: 'create_folder',
    title: 'Create folder',
    description:
      'Create a folder in the RelayKM knowledge base, including any missing parent folders. ' +
      'Succeeds without changes if the folder already exists.',
    inputSchema: {
      type: 'object',
      properties: { path: stringProp('Folder path relative to the RelayKM root.') },
      required: ['path'],
      additionalProperties: false,
    },
    handler: createFolder,
  },
  {
    name: 'delete_folder',
    title: 'Delete folder',
    description:
      'Delete a folder from the RelayKM knowledge base. Refuses a non-empty folder unless ' +
      'recursive is true, and never deletes the root itself.',
    inputSchema: {
      type: 'object',
      properties: {
        path: stringProp('Folder path relative to the RelayKM root.'),
        recursive: {
          type: 'boolean',
          description: 'Delete the folder and everything inside it. Defaults to false.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: deleteFolder,
  },
  {
    name: 'read_file',
    title: 'Read file',
    description: 'Read a UTF-8 text file from the RelayKM knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        path: stringProp('File path relative to the RelayKM root.'),
        max_bytes: {
          type: 'number',
          description: `Truncate after this many bytes (default ${DEFAULT_MAX_READ_BYTES}).`,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: readFile,
  },
  {
    name: 'write_file',
    title: 'Write file',
    description:
      'Create or edit a UTF-8 text file in the RelayKM knowledge base. Writes the full contents ' +
      'in overwrite mode (the default), so pass the complete file when editing. Missing parent ' +
      'folders are created.',
    inputSchema: {
      type: 'object',
      properties: {
        path: stringProp('File path relative to the RelayKM root.'),
        content: stringProp('The text to write.'),
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: 'overwrite replaces the file; append adds to the end. Defaults to overwrite.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    handler: writeFile,
  },
  {
    name: 'delete_file',
    title: 'Delete file',
    description: 'Delete a file from the RelayKM knowledge base.',
    inputSchema: {
      type: 'object',
      properties: { path: stringProp('File path relative to the RelayKM root.') },
      required: ['path'],
      additionalProperties: false,
    },
    handler: deleteFile,
  },
];

async function listFolder({ path: input, recursive = false, max_entries: maxEntries }) {
  const target = await resolveWithin(ROOT, input ?? '.');
  const limit = clampLimit(maxEntries);

  const stats = await statOrFail(target, 'Folder');
  if (!stats.isDirectory()) {
    throw new ToolError(`${displayPath(ROOT, target)} is a file, not a folder`);
  }

  const rows = [];
  let truncated = false;

  const walk = async (dir) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (rows.length >= limit) {
        truncated = true;
        return;
      }
      const absolute = path.join(dir, entry.name);
      const label = displayPath(ROOT, absolute);
      if (entry.isDirectory()) {
        rows.push(`dir   ${label}/`);
        if (recursive) await walk(absolute);
      } else if (entry.isFile()) {
        const size = await fsp.stat(absolute).then((s) => s.size, () => 0);
        rows.push(`file  ${label}  (${size} bytes)`);
      } else {
        // Symlinks and special files: listed, but not followed.
        rows.push(`other ${label}`);
      }
    }
  };

  await walk(target);

  const header = `${displayPath(ROOT, target)} — ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}${
    truncated ? ` (truncated at ${limit})` : ''
  }`;
  return text(rows.length ? `${header}\n\n${rows.join('\n')}` : `${header}\n\n(empty)`);
}

async function createFolder({ path: input }) {
  const target = await resolveWithin(ROOT, requireString(input, 'path'));
  const existing = await statOrNull(target);
  if (existing && !existing.isDirectory()) {
    throw new ToolError(`${displayPath(ROOT, target)} already exists and is not a folder`);
  }
  await fsp.mkdir(target, { recursive: true });
  return text(
    existing ? `Folder already exists: ${displayPath(ROOT, target)}` : `Created folder: ${displayPath(ROOT, target)}`,
  );
}

async function deleteFolder({ path: input, recursive = false }) {
  const target = await resolveWithin(ROOT, requireString(input, 'path'));
  if (path.relative(ROOT, target) === '') {
    throw new ToolError('The RelayKM root itself cannot be deleted');
  }

  const stats = await statOrFail(target, 'Folder');
  if (!stats.isDirectory()) {
    throw new ToolError(`${displayPath(ROOT, target)} is a file — use delete_file`);
  }

  if (recursive) {
    await fsp.rm(target, { recursive: true, force: true });
    return text(`Deleted folder and its contents: ${displayPath(ROOT, target)}`);
  }

  try {
    await fsp.rmdir(target);
  } catch (err) {
    if (err.code === 'ENOTEMPTY') {
      throw new ToolError(
        `${displayPath(ROOT, target)} is not empty. Pass recursive: true to delete it and its contents.`,
      );
    }
    throw err;
  }
  return text(`Deleted folder: ${displayPath(ROOT, target)}`);
}

async function readFile({ path: input, max_bytes: maxBytes }) {
  const target = await resolveWithin(ROOT, requireString(input, 'path'));
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_READ_BYTES;

  const stats = await statOrFail(target, 'File');
  if (stats.isDirectory()) {
    throw new ToolError(`${displayPath(ROOT, target)} is a folder — use list_folder`);
  }

  const buffer = await fsp.readFile(target);
  if (buffer.includes(0)) {
    throw new ToolError(`${displayPath(ROOT, target)} looks like a binary file and cannot be read as text`);
  }

  const truncated = buffer.length > limit;
  const body = buffer.subarray(0, limit).toString('utf8');
  return text(truncated ? `${body}\n\n[truncated at ${limit} of ${buffer.length} bytes]` : body);
}

async function writeFile({ path: input, content, mode = 'overwrite' }) {
  const target = await resolveWithin(ROOT, requireString(input, 'path'));
  if (typeof content !== 'string') throw new ToolError('content must be a string');
  if (mode !== 'overwrite' && mode !== 'append') {
    throw new ToolError('mode must be "overwrite" or "append"');
  }

  const existing = await statOrNull(target);
  if (existing?.isDirectory()) {
    throw new ToolError(`${displayPath(ROOT, target)} is a folder`);
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, { encoding: 'utf8', flag: mode === 'append' ? 'a' : 'w' });

  const verb = mode === 'append' ? 'Appended to' : existing ? 'Updated' : 'Created';
  return text(`${verb} ${displayPath(ROOT, target)} (${Buffer.byteLength(content, 'utf8')} bytes written)`);
}

async function deleteFile({ path: input }) {
  const target = await resolveWithin(ROOT, requireString(input, 'path'));
  const stats = await statOrFail(target, 'File');
  if (stats.isDirectory()) {
    throw new ToolError(`${displayPath(ROOT, target)} is a folder — use delete_folder`);
  }
  await fsp.unlink(target);
  return text(`Deleted file: ${displayPath(ROOT, target)}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A failure the model should see and can act on, rather than a protocol error. */
class ToolError extends Error {}

function text(body) {
  return { content: [{ type: 'text', text: body }] };
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(`${field} is required and must be a non-empty string`);
  }
  return value;
}

function clampLimit(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIST_ENTRIES;
  return Math.min(Math.floor(value), MAX_LIST_ENTRIES);
}

async function statOrNull(target) {
  try {
    return await fsp.stat(target);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

async function statOrFail(target, kind) {
  const stats = await statOrNull(target);
  if (!stats) throw new ToolError(`${kind} not found: ${displayPath(ROOT, target)}`);
  return stats;
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

const instructions =
  `Tools for the RelayKM knowledge base at ${rootPath()}. ` +
  `All paths are relative to that root ("." is the root itself) and paths outside it are refused. ` +
  `${AGENTS_FILE} at the root holds the standing conventions for this knowledge base.`;

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

const methods = {
  initialize({ protocolVersion }) {
    return {
      protocolVersion: SUPPORTED_PROTOCOLS.has(protocolVersion) ? protocolVersion : PREFERRED_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions,
    };
  },

  'notifications/initialized'() {},

  ping() {
    return {};
  },

  'tools/list'() {
    return {
      tools: TOOLS.map(({ name, title, description, inputSchema }) => ({
        name,
        title,
        description,
        inputSchema,
      })),
    };
  },

  async 'tools/call'({ name, arguments: args }) {
    const tool = byName.get(name);
    if (!tool) throw new RpcError(RPC.INVALID_PARAMS, `Unknown tool: ${name}`);

    try {
      return await tool.handler(args ?? {});
    } catch (err) {
      // Tool-level failures come back as results so the model can recover;
      // only transport-level problems become JSON-RPC errors.
      if (err instanceof ToolError || err instanceof PathError) {
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
      log(`${name} failed:`, err.stack ?? err.message);
      return { content: [{ type: 'text', text: `${name} failed: ${err.message}` }], isError: true };
    }
  },
};

try {
  ROOT = await ensureRoot();
} catch (err) {
  log(`could not open the RelayKM root at ${rootPath()}: ${err.message}`);
  process.exit(1);
}

log(`serving ${ROOT}`);
serve(methods);
