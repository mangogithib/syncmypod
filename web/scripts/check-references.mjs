#!/usr/bin/env node
//
// Finds identifiers that are used but never defined.
//
// `node --check` parses a file and stops there: it has no idea whether
// `loadJobs()` refers to anything. Both bugs that reached the browser in this
// project were exactly that - a function called after its definition was
// deleted, and a route using `rateLimit` that the file never imported. Each
// took down a whole page, and each was invisible to every check being run.
//
// There is no linter here on purpose: the web app has two npm dependencies and
// adding ESLint means a config, a plugin set and a toolchain to keep current.
// This is the part of a linter that has actually caught something, in about a
// hundred lines and no dependencies, using Node's own module resolution to do
// the hard part.
//
// **How it works.** Every module is imported for real. An import that fails to
// resolve, or a module that throws while evaluating, is a failure - which is
// exactly what a missing import does. Then each file is scanned for identifiers
// that are called as functions and checked against what that file declares,
// imports, or can get from a global.
//
// It will not catch everything a real linter would. It catches the one thing
// that has actually broken this application, twice.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(process.argv[2] || '.');

// Anything a browser or Node supplies. Not exhaustive - it only has to cover
// what this application actually reaches for.
const GLOBALS = new Set([
  // language
  'Array', 'Boolean', 'Date', 'Error', 'Infinity', 'JSON', 'Map', 'Math', 'NaN',
  'Number', 'Object', 'Promise', 'Proxy', 'Reflect', 'RegExp', 'Set', 'String',
  'Symbol', 'TypeError', 'WeakMap', 'WeakSet', 'BigInt', 'Intl', 'undefined',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURIComponent',
  'encodeURIComponent', 'decodeURI', 'encodeURI', 'structuredClone', 'queueMicrotask',
  // timers and async, both runtimes
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'AbortController',
  'AbortSignal', 'fetch', 'Response', 'Request', 'Headers', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'Blob', 'FormData', 'EventTarget', 'CustomEvent',
  // browser
  'window', 'document', 'location', 'history', 'navigator', 'localStorage',
  'sessionStorage', 'console', 'alert', 'confirm', 'prompt', 'requestAnimationFrame',
  'cancelAnimationFrame', 'getComputedStyle', 'matchMedia', 'Image', 'Audio',
  'HTMLElement', 'Element', 'Node', 'Event', 'FileReader', 'IntersectionObserver',
  'MutationObserver', 'ResizeObserver', 'DOMParser', 'crypto', 'btoa', 'atob',
  // node
  'process', 'Buffer', 'globalThis', 'require', 'module', 'exports', '__dirname',
  '__filename', 'setImmediate', 'performance',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

// Strings, template literals, comments and regex literals all contain things
// that look like calls and are not - `/remaster(ed)?/` is not a call to
// `remaster`. Blanking them is cruder than parsing and enough for this.
function stripNoise(source) {
  return (
    source
      // Newlines are kept so reported line numbers still match the file.
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
      .replace(/'(?:[^'\\\n]|\\[\s\S])*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\[\s\S])*"/g, '""')
      // A regex literal, recognised by what can precede one. Division cannot
      // follow any of these, so there is no ambiguity to get wrong.
      .replace(
        /([(,=:[!&|?{};+\-*%~^]|\breturn|\bcase|\btypeof|\bof|\bin)(\s*)\/(?![/*])(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[gimsuyd]*/g,
        '$1$2/RE/'
      )
  );
}

function declaredNames(source) {
  const names = new Set();
  const add = (pattern, group = 1) => {
    for (const match of source.matchAll(pattern)) names.add(match[group]);
  };

  add(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g);
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);
  // Destructured bindings, parameters and catch bindings, taken loosely: the
  // aim is to avoid false positives, so over-collecting here is the safe error.
  add(/\b(?:const|let|var)\s*\{([^}]*)\}/g);
  add(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g);
  // Loop bindings: `for (const problem of problems)`.
  add(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+(?:of|in)\b/g);
  add(/\bimport\s+([A-Za-z_$][\w$]*)\s+from/g);
  add(/\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g);

  for (const match of source.matchAll(/\bimport\s*\{([^}]*)\}\s*from/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  for (const match of source.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(':').pop().trim().split('=')[0].trim();
      if (name) names.add(name);
    }
  }
  // Function parameters, including arrow functions.
  for (const match of source.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/[=:]/)[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const match of source.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(match[1]);

  // Destructured parameters: `function f({ onSignedIn })`. The brace survives
  // the parameter pass above as a single unparseable token, so the names inside
  // it are collected separately.
  for (const match of source.matchAll(/\{([^{}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(':').pop().trim().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }

  // Method shorthand in an object or a class: `setHeaders(res) {`, `close() {`.
  // These are definitions, not calls, and they are how most of this codebase's
  // option objects are written.
  for (const match of source.matchAll(
    /(?:^|[\n{,;])\s*(?:async\s+|static\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g
  )) {
    names.add(match[1]);
  }

  return names;
}

// Tooling is excluded from both checks.
//
// Not squeamishness: this file's own source contains backticks inside regex
// literals, which the string-stripper above cannot pair correctly, so scanning
// itself produces a finding about text inside one of its own messages. Build
// scripts are also not loaded by the application, so a reference bug in one
// fails loudly the moment it is run rather than silently in a browser.
const files = walk(ROOT).filter(
  (file) => !/[\\/]scripts[\\/]/.test(file)
);
const problems = [];

// --- every module must actually load --------------------------------------
//
// Only possible where the dependencies are installed, which means inside the
// container rather than in a bare checkout. Skipped rather than failed when
// they are absent, so the static scan below is still useful anywhere.
// The entry point is not imported. It starts a listener and the housekeeping
// timers as a side effect, so importing it here would fight the running
// application for its port and then never exit. Nothing is lost: it imports
// only the route modules, and every one of those IS loaded below - a missing
// import in any of them fails there.
const ENTRY_POINT = 'server/index.js';

let canLoad = true;
try {
  await import('express');
} catch {
  canLoad = false;
  console.log('note: dependencies not installed, skipping the module-load check');
}

for (const file of canLoad ? files : []) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  // Only server modules can be imported here; browser modules reference `window`
  // at import time in places and have no DOM to do it against.
  if (!rel.startsWith('server/')) continue;
  if (rel === ENTRY_POINT) continue;
  try {
    await import(pathToFileURL(file).href);
  } catch (err) {
    // A missing dependency at module scope is exactly the bug being hunted.
    problems.push(`${relative(ROOT, file)}: fails to load - ${err.message.split('\n')[0]}`);
  }
}

// --- called but never defined ---------------------------------------------
for (const file of files) {
  const source = stripNoise(readFileSync(file, 'utf8'));
  const declared = declaredNames(source);

  const seen = new Set();
  for (const match of source.matchAll(/(^|[^\w$.?])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[2];
    if (seen.has(name)) continue;
    seen.add(name);

    if (declared.has(name) || GLOBALS.has(name)) continue;
    // Keywords that are followed by a parenthesis.
    if (
      /^(if|for|while|switch|catch|return|typeof|new|await|function|super|import|do|else|yield|void|delete|in|of|instanceof|async|constructor|get|set|static|case|throw)$/.test(
        name
      )
    ) {
      continue;
    }
    // A property access written across a line break, e.g. `.then(\n  x =>`.
    if (new RegExp(`[.?]\\s*${name}\\s*\\(`).test(source)) continue;

    const line = source.slice(0, match.index).split('\n').length;
    problems.push(`${relative(ROOT, file)}:${line}: ${name}() is called but never defined here`);
  }
}

// --- calls on the api client ----------------------------------------------
//
// The scan above deliberately ignores anything after a dot, because a property
// could come from anywhere and every guess would be a false positive. `api` is
// the exception worth making: it is one object literal in one file, every view
// reaches for it, and a name that is not on it fails only when a user clicks
// the thing.
//
// This is not hypothetical. `api.importJob` was called from two views and never
// existed, which turned every playlist import and every re-match into "Lost
// track of the import" the moment it started - the server finished the job
// correctly and the dialog could not read it. Nothing here caught that, because
// of the dot.
const API_MODULE = join(ROOT, 'public', 'js', 'lib', 'api.js');
let apiMethods = null;
try {
  const source = stripNoise(readFileSync(API_MODULE, 'utf8'));
  const open = source.indexOf('export const api = {');
  if (open !== -1) {
    // Ends at the first line that is nothing but `};`, which is how the object
    // is closed. Nested objects inside it are indented, so they cannot match.
    const rest = source.slice(open);
    const end = rest.search(/\n\};/);
    const literal = end === -1 ? rest : rest.slice(0, end);
    apiMethods = new Set(
      [...literal.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:/gm)].map((match) => match[1])
    );
  }
} catch {
  // No client module here - this may be a partial tree. Not a failure.
}

if (apiMethods && apiMethods.size > 0) {
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    if (!rel.startsWith('public/') || rel === 'public/js/lib/api.js') continue;

    const source = stripNoise(readFileSync(file, 'utf8'));
    const seen = new Set();
    for (const match of source.matchAll(/\bapi\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[1];
      if (apiMethods.has(name) || seen.has(name)) continue;
      seen.add(name);
      const line = source.slice(0, match.index).split('\n').length;
      problems.push(`${rel}:${line}: api.${name}() is not on the api client`);
    }
  }
}

if (problems.length > 0) {
  console.error('Undefined references:\n');
  for (const problem of problems) console.error('  ' + problem);
  console.error(`\n${problems.length} problem(s).`);
  process.exit(1);
}

console.log(`No undefined references in ${files.length} files.`);

// Explicit, because importing the entry point leaves a listener and a database
// pool open and the process would otherwise never exit.
process.exit(0);
