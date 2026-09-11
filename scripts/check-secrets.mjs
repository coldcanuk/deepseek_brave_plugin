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

/** Directory names never worth reading, whatever git reports. */
const SKIP_SEGMENTS = new Set(['.git', 'node_modules']);

/** Ordered so a finding names the most specific thing first. */
const PATTERNS = [
  { name: 'Brave subscription token', pattern: /bsa[a-z0-9_-]{20,}/iu },
  { name: 'x-subscription-token assignment', pattern: /x-subscription-tokens*[:=]s*[A-Za-z0-9]/iu },
  { name: 'quoted api-key assignment', pattern: /api[_-]?keys*[:=]s*["'][^"'s]{16,}/iu },
  { name: 'AWS access key id', pattern: /AKIA[0-9A-Z]{16}/u },
  { name: 'GitHub token', pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/u },
  { name: 'OpenAI-style key', pattern: /sk-[A-Za-z0-9]{20,}/u },
  { name: 'PEM private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
];

/** Every file this repository would publish on `git add -A`. */
function commitEligibleFiles() {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split('\u0000')
    .filter((path) => path.length > 0 && !path.split('/').some((segment) => SKIP_SEGMENTS.has(segment)));
}

/** Scan one file, appending any findings. Binary files are skipped. */
function scanFile(file, findings) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  if (text.includes('\u0000')) return 0;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    for (const { name, pattern } of PATTERNS) {
      if (pattern.test(lines[index])) findings.push({ file, line: index + 1, name });
    }
  }
  return 1;
}

const findings = [];
let scanned = 0;
for (const file of commitEligibleFiles()) scanned += scanFile(file, findings);

if (findings.length > 0) {
  process.stderr.write(`check-secrets: ${findings.length} finding(s); matched text is deliberately not printed\n`);
  for (const finding of findings) process.stderr.write(`  ${finding.file}:${finding.line}  ${finding.name}\n`);
  process.exit(1);
}
process.stdout.write(`check-secrets: clean — ${scanned} commit-eligible file(s), ${PATTERNS.length} patterns\n`);
