// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * `execFile` stand-ins for the secret-manager lookups. Tests inject these so
 * the suite never spawns a real `secret-tool` or `pass`, never touches the
 * developer's keyring or password store, and never depends on what happens to
 * be installed.
 *
 * @module dsh-web-search-brave/test/helpers/fake-secret-tools
 */

/**
 * A runner for "the tool is not installed": every call rejects with ENOENT.
 * @returns the runner, with its recorded `calls`.
 */
export function missingToolExecFile() {
  const calls = [];
  const execFile = async (file, args) => {
    calls.push({ file, args });
    const error = new Error(`spawn ${file} ENOENT`);
    error.code = 'ENOENT';
    throw error;
  };
  execFile.calls = calls;
  return execFile;
}

/**
 * A runner that answers by command line. Keys are `"<file> <args joined>"`; a
 * value is either a stdout string, or `{ stdout }`, `{ error }`, or
 * `{ exit }` to script a failure. An unscripted command rejects with ENOENT.
 * @param script - the command-line keyed script.
 * @returns the runner, with its recorded `calls`.
 */
export function scriptedExecFile(script) {
  const calls = [];
  const execFile = async (file, args) => {
    calls.push({ file, args });
    const key = `${file} ${args.join(' ')}`;
    const step = script[key];
    if (step === undefined) {
      const error = new Error(`no scripted response for ${key}`);
      error.code = 'ENOENT';
      throw error;
    }
    if (typeof step === 'string') return { stdout: step, stderr: '' };
    if (step.error !== undefined) throw step.error;
    if (step.exit !== undefined) {
      const error = new Error('command failed');
      error.code = step.exit;
      throw error;
    }
    return { stdout: step.stdout ?? '', stderr: step.stderr ?? '' };
  };
  execFile.calls = calls;
  return execFile;
}
