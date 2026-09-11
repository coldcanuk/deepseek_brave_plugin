#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Fail when a hand-authored `lib/types/*.d.ts` no longer describes the module
 * it declares.
 *
 * This package ships no build step: `lib/*.js` and `lib/types/*.d.ts` are both
 * written by hand and versioned as source. Nothing in the toolchain ties them
 * together, so a new runtime export can land with no declaration at all and
 * every existing check still passes — `tsc` only proves the declarations are
 * *internally* consistent, not that they match the JavaScript beside them.
 *
 * The check is a bidirectional comparison of the two export surfaces:
 *
 *   - every runtime export must be declared (otherwise consumers cannot see it);
 *   - every declared *value* export must exist at runtime (otherwise TypeScript
 *     promises a binding that is `undefined` when imported).
 *
 * Type-only declarations (`export type`, `export interface`, `export declare
 * type`) are values-free by definition and are excluded from the runtime half of
 * the comparison. Everything is resolved through the real ESM modules, so a
 * re-export chain is compared by what it actually publishes rather than by how
 * the declaration file spells it.
 *
 * Pair it with `npm run check:types:tsc`, which type-checks the declarations
 * themselves. This script covers the JS-to-`.d.ts` seam that `tsc` cannot see.
 * @module dsh-web-search-brave/scripts/check-types
 */
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { basename, join, resolve } from 'node:path';

/** Repository root, derived from this script's location so the cwd does not matter. */
const ROOT = resolve(import.meta.dirname, '..');
/** Directory holding the runtime ESM modules. */
const LIB = join(ROOT, 'lib');
/** Directory holding the hand-authored declarations. */
const TYPES = join(LIB, 'types');

/** Matches `export ... { ... }` and captures the brace list. */
const EXPORT_BRACES = /\bexport\s+(type\s+)?\{([^}]*)\}/gsu;
/** Matches `export * from '...'`. */
const EXPORT_STAR = /\bexport\s+\*\s+from\s+['"]([^'"]+)['"]/gu;
/** Matches a declaration that introduces runtime values. */
const VALUE_DECLARATION = /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|enum)\s+([A-Za-z_$][\w$]*)/gu;
/** Matches `export declare namespace`/`export type`/`export interface`, which are type-only. */
const TYPE_DECLARATION = /\bexport\s+(?:declare\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/gu;

/**
 * Read a file, returning `undefined` when it does not exist.
 * @param path - the file to read.
 * @returns the contents, or `undefined`.
 */
function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Split a brace list on top-level commas, tolerating `a as b` and nested braces.
 * @param body - the text between `{` and `}`.
 * @returns one entry per exported name, already reduced to its local or exported name.
 */
function splitExportList(body) {
  const names = [];
  let depth = 0;
  let current = '';
  for (const character of body) {
    if (character === '{' || character === '(' || character === '[') depth += 1;
    if (character === '}' || character === ')' || character === ']') depth -= 1;
    if (character === ',' && depth === 0) {
      names.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  names.push(current);
  return names
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      // `local as exported` — the name a consumer imports is the exported one.
      const aliased = /\bas\s+([A-Za-z_$][\w$]*)\s*$/u.exec(entry);
      return aliased === null ? entry : aliased[1];
    })
    .filter((name) => /^[A-Za-z_$][\w$]*$/u.test(name));
}

/**
 * Resolve the value and type export surfaces a declaration file declares.
 *
 * Re-exports are followed into the sibling declaration the specifier points at,
 * so `lib/types/index.d.ts` is compared against the union of everything it
 * publishes rather than against the names it happens to repeat.
 * @param file - the absolute path of the declaration file.
 * @param seen - files already visited, so a cycle cannot recurse forever.
 * @returns the declared value names and the declared type-only names.
 */
export function declaredExports(file, seen = new Set()) {
  if (seen.has(file)) return { values: new Set(), types: new Set() };
  seen.add(file);
  const source = readIfPresent(file);
  const values = new Set();
  const types = new Set();
  if (source === undefined) return { values, types };

  for (const match of source.matchAll(VALUE_DECLARATION)) values.add(match[1]);
  for (const match of source.matchAll(TYPE_DECLARATION)) types.add(match[1]);

  for (const match of source.matchAll(EXPORT_BRACES)) {
    // `export type { A }` publishes a type only; it must not be held to the
    // runtime surface the way a value re-export is.
    const names = splitExportList(match[2]);
    for (const name of names) (match[1] === undefined ? values : types).add(name);
  }
  for (const match of source.matchAll(EXPORT_STAR)) {
    const nested = resolveSpecifier(file, match[1]);
    if (nested === undefined) continue;
    const inner = declaredExports(nested, seen);
    for (const name of inner.values) values.add(name);
    for (const name of inner.types) types.add(name);
  }
  // A name that is declared type-only must not be held to the runtime surface.
  for (const name of types) values.delete(name);
  return { values, types };
}

/**
 * Map an import specifier onto a declaration file on disk.
 * @param fromFile - the file containing the specifier.
 * @param specifier - the raw specifier text.
 * @returns the declaration path, or `undefined` for a bare package specifier.
 */
function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const candidate = resolve(join(fromFile, '..'), specifier).replace(/\.js$/u, '.d.ts');
  return readIfPresent(candidate) === undefined ? undefined : candidate;
}

/**
 * The runtime export names of one module, sorted.
 * @param file - the absolute path of the ESM module.
 * @returns the exported binding names.
 */
async function runtimeExports(file) {
  const module = await import(pathToFileURL(file).href);
  return new Set(Object.keys(module));
}

/** Report the two drift directions for one module pair. */
function reportPair(moduleName, declared, runtime) {
  const problems = [];
  for (const name of runtime) {
    if (declared.values.has(name)) continue;
    if (declared.types.has(name)) continue;
    problems.push(`  ${moduleName}: ${name} is exported at runtime but not declared in lib/types/${moduleName}.d.ts`);
  }
  for (const name of declared.values) {
    if (runtime.has(name)) continue;
    problems.push(`  ${moduleName}: ${name} is declared in lib/types/${moduleName}.d.ts but is not exported at runtime`);
  }
  return problems;
}

/** Every runtime module paired with the declaration that must describe it. */
function modulePairs() {
  return readdirSync(LIB)
    .filter((entry) => entry.endsWith('.js'))
    .sort()
    .map((entry) => ({ moduleName: basename(entry, '.js'), js: join(LIB, entry), dts: join(TYPES, `${basename(entry, '.js')}.d.ts`) }));
}

/** Run the comparison and return every problem found. */
export async function compareAll() {
  const problems = [];
  for (const { moduleName, js, dts } of modulePairs()) {
    if (readIfPresent(dts) === undefined) {
      problems.push(`  ${moduleName}: lib/${moduleName}.js has no lib/types/${moduleName}.d.ts`);
      continue;
    }
    const declared = declaredExports(dts);
    const runtime = await runtimeExports(js);
    problems.push(...reportPair(moduleName, declared, runtime));
  }
  return problems;
}

const problems = await compareAll();
if (problems.length > 0) {
  process.stderr.write(`check:types FAILED: ${problems.length} declaration drift finding(s)\n`);
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.exit(1);
}
process.stdout.write(`check:types OK: ${modulePairs().length} module(s) match their declarations.\n`);
