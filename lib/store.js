/**
 * RelayKM store: locates the knowledge base root and resolves every path
 * against it, so nothing outside the root is ever reachable.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const AGENTS_FILE = 'AGENTS.md';
export const DEFAULT_MAX_READ_BYTES = 1024 * 1024;

const STARTER_AGENTS = `# RelayKM

This is the root of the RelayKM knowledge base. Everything the RelayKM plugin
can read or write lives under this folder.

This file is loaded into the context of every new Claude Code session, once per
session. Use it for the standing instructions and orientation an assistant needs
before it touches anything here: what lives where, naming conventions, and how
notes should be written.

## Layout

(Describe your folders here as you create them.)

## Conventions

(Describe how you want notes written, named, and linked.)
`;

export class PathError extends Error {}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** The platform's Documents folder. macOS and Windows both use ~/Documents. */
function documentsDir() {
  const home = os.homedir();
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    const xdg = process.env.XDG_DOCUMENTS_DIR;
    if (xdg && path.isAbsolute(expandHome(xdg))) return expandHome(xdg);
  }
  return path.join(home, 'Documents');
}

/** Configured root, defaulting to <Documents>/RelayKM. */
export function rootPath() {
  const override = process.env.RELAYKM_ROOT?.trim();
  if (override) return path.resolve(expandHome(override));
  return path.join(documentsDir(), 'RelayKM');
}

/**
 * Create the root (and a starter AGENTS.md) if missing, and return its real
 * path. Every other operation resolves against the *real* root so a symlinked
 * root still behaves correctly.
 */
export async function ensureRoot() {
  const root = rootPath();
  await fsp.mkdir(root, { recursive: true });
  try {
    await fsp.writeFile(path.join(root, AGENTS_FILE), STARTER_AGENTS, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return fsp.realpath(root);
}

function assertInside(realRoot, target, label) {
  const rel = path.relative(realRoot, target);
  if (rel === '') return;
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new PathError(`${label} resolves outside the RelayKM root and was refused`);
  }
}

/**
 * Resolve `target` after following symlinks. The path may not exist yet, so
 * walk up to the deepest ancestor that does, resolve that, and re-append the
 * missing segments.
 */
async function realpathDeepest(target) {
  const missing = [];
  let current = target;
  for (;;) {
    try {
      const real = await fsp.realpath(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Turn a caller-supplied path into an absolute path guaranteed to sit inside
 * the root. Relative paths are resolved against the root; absolute paths are
 * accepted only when they already point inside it. Checked twice: once
 * lexically, once after resolving symlinks.
 */
export async function resolveWithin(realRoot, input, label = 'path') {
  if (input === undefined || input === null || input === '') input = '.';
  if (typeof input !== 'string') throw new PathError(`${label} must be a string`);

  const target = path.resolve(realRoot, expandHome(input.trim()));
  assertInside(realRoot, target, label);
  assertInside(realRoot, await realpathDeepest(target), label);
  return target;
}

/** Path shown to the user and the model: root-relative, POSIX-style. */
export function displayPath(realRoot, absolute) {
  const rel = path.relative(realRoot, absolute);
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

/** Read the knowledge base's AGENTS.md, or null when it does not exist. */
export async function readAgentsFile(realRoot, maxBytes = DEFAULT_MAX_READ_BYTES) {
  try {
    const contents = await fsp.readFile(path.join(realRoot, AGENTS_FILE), 'utf8');
    return contents.length > maxBytes ? contents.slice(0, maxBytes) : contents;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
