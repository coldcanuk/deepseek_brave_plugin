// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@attvite.com>
/**
 * Optional secret-manager lookups, so a Brave key can live in an encrypted
 * store instead of a cleartext file.
 *
 * Two tools are supported, both optional:
 *
 * - **GNOME keyring** through `secret-tool lookup <attribute> <value> …`.
 * - **`pass`** through `pass show <entry>`.
 *
 * Every lookup is best-effort by contract: a tool that is absent, locked, slow,
 * or simply has no matching entry yields `undefined` plus a plain-language note
 * for the missing-credential diagnostic. Nothing here ever throws, and no tool
 * output is ever surfaced, logged, or embedded in an error — the value crosses
 * exactly one boundary, from the tool's stdout into the caller's header.
 *
 * The executable names are a closed set chosen here, never read from
 * configuration, and every call goes through `execFile` (no shell), so
 * configuration values can never select a program or reach a command line.
 *
 * @module dsh-web-search-brave/secrets
 */
import { execFile as nodeExecFile } from 'node:child_process';

/** Try the GNOME keyring, then `pass`. The default. */
export const SECRET_MANAGER_AUTO = 'auto';
/** Disable secret-manager lookups entirely. */
export const SECRET_MANAGER_NONE = 'none';
/** Read only from the GNOME keyring. */
export const SECRET_MANAGER_GNOME = 'gnome-keyring';
/** Read only from `pass`. */
export const SECRET_MANAGER_PASS = 'pass';
/** Every accepted `secretManager` value. */
export const SECRET_MANAGERS = Object.freeze([SECRET_MANAGER_AUTO, SECRET_MANAGER_NONE, SECRET_MANAGER_GNOME, SECRET_MANAGER_PASS]);

/**
 * Attributes this plugin stores and looks up its key under in the GNOME
 * keyring. One attribute is enough for a unique item and keeps the store
 * command short; `secret-tool lookup service dsh-web-search-brave` matches it.
 */
export const DEFAULT_GNOME_KEYRING_ATTRIBUTES = Object.freeze({ service: 'dsh-web-search-brave' });
/** Entry path this plugin looks its key up under in `pass`. */
export const DEFAULT_PASS_PATH = 'dsh/brave-search-api';

/** How long one lookup may take before the chain moves on. */
export const SECRET_LOOKUP_TIMEOUT_MS = 5000;
/** Longest tool output accepted, so a broken tool cannot exhaust memory. */
export const MAX_SECRET_OUTPUT_BYTES = 65536;
/** Most attribute pairs passed to one lookup. */
export const MAX_SECRET_ARGUMENTS = 16;

/** The GNOME keyring command. */
export const GNOME_SECRET_TOOL = 'secret-tool';
/** The standard Unix password manager command. */
export const PASS_TOOL = 'pass';

/**
 * The first non-blank line of a command's output, trimmed. A keyring note or a
 * `pass` entry may be multi-line; the secret is the first line.
 * @param text - the tool's stdout.
 * @returns the first non-blank line, or `undefined` when there is none.
 */
export function firstLine(text) {
  if (typeof text !== 'string') return undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
 * Sanitize configured keyring attributes into the `<name> <value>` argument
 * pairs `secret-tool` expects. Non-strings, blanks, and values that would read
 * as a flag are dropped; the list is bounded.
 * @param attributes - the configured attribute map.
 * @returns the accepted pairs, in configuration order.
 */
export function secretAttributes(attributes) {
  const pairs = [];
  if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) return pairs;
  for (const [name, value] of Object.entries(attributes)) {
    if (pairs.length >= MAX_SECRET_ARGUMENTS) break;
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    if (name.length === 0 || value.length === 0) continue;
    if (name.startsWith('-') || value.startsWith('-')) continue;
    pairs.push([name, value]);
  }
  return pairs;
}

/**
 * Run one command with no shell, a bounded runtime, and a bounded output size.
 * @param file - the executable; always one of this module's constants.
 * @param args - the argument vector.
 * @param options - optional `timeoutMs` and `signal`.
 * @returns the command's stdout and stderr.
 * @throws whatever the child process reports; callers treat that as "no value".
 */
export function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    nodeExecFile(
      file,
      [...args],
      {
        encoding: 'utf8',
        timeout: options.timeoutMs ?? SECRET_LOOKUP_TIMEOUT_MS,
        maxBuffer: MAX_SECRET_OUTPUT_BYTES,
        windowsHide: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }
        resolve({ stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '' });
      },
    );
  });
}

/** A plain-language reason a lookup produced nothing. Never includes tool output. */
function failureNote(tool, error) {
  if (error?.code === 'ENOENT') return `${tool} is not installed`;
  if (error?.killed === true) return `${tool} did not answer within ${SECRET_LOOKUP_TIMEOUT_MS} ms`;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return `${tool} was cancelled`;
  return `${tool} has no matching entry`;
}

/** A short, secret-free description of one lookup for the diagnostic. */
function describe(labels, note) {
  return `${labels}: ${note}`;
}

/**
 * Read the key from the GNOME keyring.
 * @param attributes - the attribute map identifying the item.
 * @param options - optional `execFile`, `timeoutMs`, and `signal`.
 * @returns the value with its source, or a note explaining what was tried. The
 *   hit carries an empty `attempted`, so a caller never has to distinguish
 *   "nothing was tried before this" from "the field is missing".
 */
export async function lookupGnomeKeyring(attributes, options = {}) {
  const pairs = secretAttributes(attributes);
  if (pairs.length === 0) return { attempted: [describe(SECRET_MANAGER_GNOME, 'no lookup attributes are configured')] };
  const labels = `${SECRET_MANAGER_GNOME} (attributes: ${pairs.map(([name]) => name).join(', ')})`;
  const execFile = options.execFile ?? execFileAsync;
  try {
    const { stdout } = await execFile(GNOME_SECRET_TOOL, ['lookup', ...pairs.flat()], {
      timeoutMs: options.timeoutMs ?? SECRET_LOOKUP_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const value = firstLine(stdout);
    if (value === undefined) return { attempted: [describe(labels, 'the matching entry is empty')] };
    return { value, source: SECRET_MANAGER_GNOME, attempted: [] };
  } catch (error) {
    return { attempted: [describe(labels, failureNote(GNOME_SECRET_TOOL, error))] };
  }
}

/**
 * Read the key from `pass`.
 * @param path - the entry path inside the password store.
 * @param options - optional `execFile`, `timeoutMs`, and `signal`.
 * @returns the value with its source, or a note explaining what was tried. The
 *   hit carries an empty `attempted`, matching {@link lookupGnomeKeyring}.
 */
export async function lookupPass(path, options = {}) {
  const entry = typeof path === 'string' ? path.trim() : '';
  if (entry.length === 0 || entry.startsWith('-')) return { attempted: [describe(SECRET_MANAGER_PASS, 'no entry path is configured')] };
  const labels = `${SECRET_MANAGER_PASS} (${entry})`;
  const execFile = options.execFile ?? execFileAsync;
  try {
    const { stdout } = await execFile(PASS_TOOL, ['show', entry], {
      timeoutMs: options.timeoutMs ?? SECRET_LOOKUP_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const value = firstLine(stdout);
    if (value === undefined) return { attempted: [describe(labels, 'the entry is empty')] };
    return { value, source: SECRET_MANAGER_PASS, attempted: [] };
  } catch (error) {
    return { attempted: [describe(labels, failureNote(PASS_TOOL, error))] };
  }
}

/**
 * Work through the configured secret managers in order.
 * @param options - `manager`, `gnomeKeyringAttributes`, `passPath`, and the
 *   optional `execFile` / `timeoutMs` / `signal` seams.
 * @returns the first value found with its source, or the notes for every attempt.
 */
export async function resolveSecret(options = {}) {
  const manager = SECRET_MANAGERS.includes(options.manager) ? options.manager : SECRET_MANAGER_AUTO;
  if (manager === SECRET_MANAGER_NONE) return { attempted: [] };
  const order = manager === SECRET_MANAGER_AUTO ? [SECRET_MANAGER_GNOME, SECRET_MANAGER_PASS] : [manager];
  const attempted = [];
  for (const candidate of order) {
    const result =
      candidate === SECRET_MANAGER_GNOME
        ? await lookupGnomeKeyring(options.gnomeKeyringAttributes, options)
        : await lookupPass(options.passPath, options);
    if (result.value !== undefined) return { value: result.value, source: result.source, attempted };
    attempted.push(...result.attempted);
  }
  return { attempted };
}
