#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Fail if any commit-eligible file carries something that looks like a
 * credential.
 *
 * "Commit-eligible" is `git ls-files --cached --others --exclude-standard`:
 * every tracked file plus every untracked file `.gitignore` does not exclude —
 * exactly the set `git add -A` would publish, and nothing more.
 *
 * A finding prints the path, the line, and which pattern matched, but never the
 * matched text: a scanner that echoes a secret writes it into the terminal, the
 * CI log, and the scrollback it was supposed to protect.
 * @module dsh-web-search-brave/scripts/check-secrets
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Directory names never worth reading, whatever git reports. */
const SKIP_SEGMENTS = new Set(['.git', 'node_modules']);

/** Ordered so a finding names the most specific thing first. */
export const PATTERNS = [
  { name: 'Brave subscription token', pattern: /bsa[a-z0-9_-]{20,}/iu },
  { name: 'x-subscription-token assignment', pattern: /x-subscription-token\s*['"]?\s*[:=]\s*['"][A-Za-z0-9_-]{8,}['"]/iu },
  { name: 'quoted api-key assignment', pattern: /api[_-]?key\s*['"]?\s*[:=]\s*['"][^'"\s]{16,}['"]/iu },
  { name: 'AWS access key id', pattern: /AKIA[0-9A-Z]{16}/u },
  { name: 'GitHub token', pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/u },
  { name: 'OpenAI-style key', pattern: /sk-[A-Za-z0-9]{20,}/u },
  { name: 'PEM private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
];

/**
 * Repository root, derived from this script's location rather than the working
 * directory. Without it the scan would follow the caller's cwd: run from another
 * repository it would report a confident "clean" about the wrong tree, and run
 * outside one it would die inside `execFileSync` instead of saying what was wrong.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every file this repository would publish on `git add -A`.
 * @returns the repository-relative paths, or throws when this is not a git work tree.
 */
function commitEligibleFiles() {
  const output = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split('\u0000')
    .filter((path) => path.length > 0 && !path.split('/').some((segment) => SKIP_SEGMENTS.has(segment)));
}

/**
 * Scan one file's text, appending any findings.
 * @param text - the file's decoded contents.
 * @param file - the path to record on a finding.
 * @param findings - the accumulator every finding is pushed onto.
 */
export function scanText(text, file, findings) {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    for (const { name, pattern } of PATTERNS) {
      if (pattern.test(lines[index])) findings.push({ file, line: index + 1, name });
    }
  }
}

/**
 * Scan one file, appending any findings. Binary files are skipped.
 * @param file - the repository-relative path reported by git.
 * @param findings - the accumulator every finding is pushed onto.
 * @returns 1 when the file was read and scanned, 0 when it was skipped.
 */
function scanFile(file, findings) {
  let text;
  try {
    // Resolved against ROOT, not the cwd, so the scan reads the tree it reported on.
    text = readFileSync(resolve(ROOT, file), 'utf8');
  } catch {
    return 0;
  }
  if (text.includes('\u0000')) return 0;
  scanText(text, file, findings);
  return 1;
}

// Importing this module (as the test suite does) must not run the scan; only a
// direct invocation is the CLI.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = [];
  let scanned = 0;
  let eligible;
  try {
    eligible = commitEligibleFiles();
  } catch (error) {
    process.stderr.write(`check-secrets: could not list this repository's files with git: ${error?.message ?? error}\n`);
    process.exit(2);
  }
  for (const file of eligible) scanned += scanFile(file, findings);

  if (findings.length > 0) {
    process.stderr.write(`check-secrets: ${findings.length} finding(s); matched text is deliberately not printed\n`);
    for (const finding of findings) process.stderr.write(`  ${finding.file}:${finding.line}  ${finding.name}\n`);
    process.exit(1);
  }
  process.stdout.write(`check-secrets: clean — ${scanned} commit-eligible file(s), ${PATTERNS.length} patterns\n`);
}
