#!/usr/bin/env node
/**
 * Convention-driven CI change classifier (see issue #331).
 *
 * Replaces the hand-maintained per-service dorny filter block: services are
 * discovered from `packages/*-service`, and changed files are classified by the
 * repo's naming conventions. Adding a service requires NO edits here — only the
 * ci.yml jobs and per-service reusable workflows (which are inherently
 * per-service).
 *
 * Runs on bare node (no pnpm install) in the detect job — Node 24 strips the
 * erasable type syntax natively, so keep this file free of enums, namespaces,
 * and parameter properties.
 *
 * Classification (first matching rule wins):
 *   - *.md anywhere            → docs (never triggers pipelines; lint runs unconditionally),
 *                                except packages/<pkg>/permissions/** (generated, shipped in the crate)
 *   - packages/native-*, packages/bundler        → shared (all services)
 *   - packages/<svc>[-...]/**                    → that service
 *   - packages/<unrecognised>/**                 → unknown (runs all — convention drift, fail loud)
 *   - e2e/test/<svc>[-...]/**, e2e/wdio.<svc>*.conf.ts → that service; other e2e/** → all (shared test infra)
 *   - fixtures/{e2e-apps,package-tests}/<svc>[-...]/** → that service; unrecognised dir → unknown
 *   - a .github/workflows/ YAML file whose diff only adds or removes comments and blank lines → none
 *     (main reads the diff from DIFF_BASE; if it can't, the file falls through to the rules below)
 *   - .github/workflows/: core-infra list → all; meta list → none;
 *     actions/** → all; service token in filename → that service; else → unknown
 *   - scripts/: service token in filename → that service; else → all (cross-service tooling)
 *   - package.json, when the base copy can be read: release/lint devDependencies
 *     (@releasekit/*, @biomejs/*, eslint*, @typescript-eslint/*) → none; other devDependencies
 *     (vitest, typescript, turbo…) → shared (build + unit, no service E2E); any non-devDependencies
 *     change (scripts, dependencies, pnpm, engines, packageManager…) → all
 *   - e2e/package.json, when the base copy can be read: each changed dependency maps to the
 *     service(s) whose E2E configs/tests use it; shared runner deps or non-dependency fields → all
 *   - pnpm-workspace.yaml, when the base copy can be read: changed catalog entries classify by the
 *     workspace package.json files that reference `catalog:` for them; non-catalog changes → all
 *   - pnpm-lock.yaml, when the base copy can be read: a changed importer is classified like its
 *     package.json; an edited package or snapshot, or a catalog or other top-level change → all;
 *     a package or snapshot that was only added or removed → none
 *   - root infra files (package.json, lockfile, turbo.json, tsconfig*…) → all
 *   - biome.jsonc, eslint.config.js → none (the lint job has no `if:` gate)
 *   - everything else (docs/, .claude/, dotfiles…) → none
 *
 * A releasekit release commit (RELEASE_COMMIT=true) runs lint only: it bumps versions, changelogs
 * and Cargo locks, and its publish doesn't wait for CI.
 *
 * 'all' and 'unknown' both run every pipeline; they differ only in reporting —
 * 'unknown' marks files no convention rule could place (likely naming drift) and is
 * called out separately in the step summary. Silent under-running is the failure
 * mode that hid real gaps before (#330), so drift over-runs, never under-runs.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 'none' | 'shared' | 'all' | 'unknown' | a service name discovered from packages/. */
type Verdict = string;

interface Classification {
  runs: Record<string, boolean>;
  sharedChanges: boolean;
  lintOnly: boolean;
  triggersAll: string[];
  unknownFiles: string[];
  commentOnlyFiles: string[];
  sharedDetail: Array<{ file: string; pkg: string; services: string[]; typesOnly: boolean }>;
  perFile: Array<{ file: string; verdict: Verdict }>;
}

// Core CI orchestration: changes affect every service pipeline.
const CORE_INFRA_WORKFLOWS = new Set([
  'ci.yml',
  '_ci-detect-changes.reusable.yml',
  '_ci-build.reusable.yml',
  '_ci-lint.reusable.yml',
  '_ci-unit.reusable.yml',
  '_ci-package.reusable.yml',
]);

// Workflows the service tests can't exercise, so a change to one needs only the lint job (which runs actionlint).
const META_WORKFLOWS = new Set([
  'codeql.yml',
  'crate-drift.yml',
  'pr-title.yml',
  'auto-label-issues.yml',
  'expense.yml',
  'release.yml',
  '_release.reusable.yml',
  'standing-pr.yml',
  '_standing-pr-update.reusable.yml',
  'release-preview.yml',
  'release-preview-comment.yml',
]);

// Workspace / dependency / build / test configuration at the repo root.
const ROOT_INFRA_FILES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  '.nvmrc',
  'turbo.json',
  'version.config.json',
  'vitest.config.ts',
  'wdio.conf.ts',
]);

// The lint job runs unconditionally, so lint config alone never needs pipelines.
const LINT_ONLY_FILES = new Set(['biome.jsonc', 'eslint.config.js']);

const SHARED_PACKAGE_PREFIXES = ['native-'];
const SHARED_PACKAGES = new Set(['bundler']);

// Types-only packages ship nothing but type declarations (erased at compile time), so a change
// to one can only break COMPILATION — caught by the always-on build + unit jobs — never a
// service's runtime. They therefore need no per-service E2E. Guarded by
// test/scripts/native-types-types-only.spec.ts, which fails if real runtime code ever lands here.
const TYPES_ONLY_PACKAGES = new Set(['native-types']);

export function discoverServices(repoRoot: string): string[] {
  const packagesDir = path.join(repoRoot, 'packages');
  return fs
    .readdirSync(packagesDir)
    .filter((name) => name.endsWith('-service'))
    .map((name) => name.slice(0, -'-service'.length))
    .sort();
}

/**
 * Map each shared package dir → the service names that transitively depend on it, derived from
 * the `@wdio/*` deps in every package's `package.json`. A shared code change can then run only
 * the services it can actually affect at runtime (e.g. native-mobile-core → react-native +
 * flutter) instead of all of them. Reads package.json only — no install — so it still runs on the
 * bare-node detect job. Convention-driven: derived from real deps, never a hand-maintained map.
 */
export function buildServiceDependents(repoRoot: string, services: string[]): Record<string, string[]> {
  const packagesDir = path.join(repoRoot, 'packages');
  const dirByName: Record<string, string> = {};
  const wdioDepsByDir: Record<string, string[]> = {};
  for (const dir of fs.readdirSync(packagesDir)) {
    const pkgPath = path.join(packagesDir, dir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      continue;
    }
    let pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      continue;
    }
    if (pkg.name) {
      dirByName[pkg.name] = dir;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    wdioDepsByDir[dir] = Object.keys(deps).filter((d) => d.startsWith('@wdio/'));
  }
  // Transitive set of workspace package dirs a given dir depends on.
  const closure = (dir: string, seen: Set<string>): Set<string> => {
    for (const depName of wdioDepsByDir[dir] ?? []) {
      const depDir = dirByName[depName];
      if (depDir && !seen.has(depDir)) {
        seen.add(depDir);
        closure(depDir, seen);
      }
    }
    return seen;
  };
  const dependents: Record<string, string[]> = {};
  for (const svc of services) {
    for (const sharedDir of closure(`${svc}-service`, new Set<string>())) {
      if (!dependents[sharedDir]) {
        dependents[sharedDir] = [];
      }
      dependents[sharedDir].push(svc);
    }
  }
  for (const dir of Object.keys(dependents)) {
    dependents[dir].sort();
  }
  return dependents;
}

const WORKFLOW_YAML = /^\.github\/workflows\/.+\.ya?ml$/;

// A diff with no changed lines (a rename or mode change) doesn't count. A `#` line inside a block
// scalar, such as a heredoc or a github-script, looks like a comment here too.
export function isCommentOnlyYamlDiff(diff: string): boolean {
  let inHunk = false;
  let changed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || !(line.startsWith('+') || line.startsWith('-'))) {
      continue;
    }
    changed++;
    if (!/^\s*(#.*)?$/.test(line.slice(1))) {
      return false;
    }
  }
  return changed > 0;
}

// A file whose diff can't be read (readDiff returns undefined) keeps its usual verdict.
export function findCommentOnlyWorkflowChanges(
  files: string[],
  services: string[],
  readDiff: (file: string) => string | undefined,
): Set<string> {
  const commentOnly = new Set<string>();
  for (const file of files) {
    if (!WORKFLOW_YAML.test(file) || classifyFile(file, services) === 'none') {
      continue;
    }
    const diff = readDiff(file);
    if (diff !== undefined && isCommentOnlyYamlDiff(diff)) {
      commentOnly.add(file);
    }
  }
  return commentOnly;
}

function gitDiffReader(diffBase: string | undefined): (file: string) => string | undefined {
  let base: string | undefined;
  try {
    base = diffBase ? execFileSync('git', ['merge-base', diffBase, 'HEAD'], { encoding: 'utf8' }).trim() : undefined;
  } catch {
    base = undefined;
  }
  return (file) => {
    if (!base) {
      return undefined;
    }
    try {
      return execFileSync('git', ['diff', '--unified=0', '--no-color', '--no-ext-diff', base, 'HEAD', '--', file], {
        encoding: 'utf8',
      });
    } catch {
      return undefined;
    }
  };
}

function serviceForDir(dir: string, services: string[]): string | undefined {
  return services.find((svc) => dir === svc || dir.startsWith(`${svc}-`));
}

function serviceForToken(filename: string, services: string[]): string | undefined {
  // Normalise every separator to a single '-' and frame the string with '-' so a
  // multi-word service name ('react-native') matches a hyphen-bounded token run in
  // '_ci-e2e-react-native-all-providers.reusable.yml'. A plain token-split would only
  // see 'react' and 'native' and never match the joined service name.
  const normalized = `-${filename.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-`;
  // Prefer the LONGEST matching service so a future short service (e.g. 'react') can't
  // shadow a longer one that contains it ('react-native') — both substring-match the same
  // filename, and a plain find() would return whichever sorts first.
  return services.filter((svc) => normalized.includes(`-${svc}-`)).sort((a, b) => b.length - a.length)[0];
}

const LOCKFILE_ENTRY_SECTIONS = new Set(['importers', 'packages', 'snapshots']);

// Root devDependencies that only feed release automation or the unconditional lint job.
const ROOT_INERT_DEV_DEP_PREFIXES = ['@releasekit/', '@biomejs/', 'eslint', '@typescript-eslint/'];

const DIFF_MANIFEST_FILES = ['package.json', 'e2e/package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'] as const;
type DiffManifestFile = (typeof DIFF_MANIFEST_FILES)[number];

export interface ManifestPair {
  base: string;
  head: string;
}

interface ParsedLockfile {
  entries: Record<'importers' | 'packages' | 'snapshots', Map<string, string>>;
  other: Map<string, string>;
}

interface ManifestEffect {
  all: boolean;
  unknown: boolean;
  rootShared: boolean;
  services: Set<string>;
  sharedDirs: string[];
}

function emptyEffect(): ManifestEffect {
  return { all: false, unknown: false, rootShared: false, services: new Set(), sharedDirs: [] };
}

function stripCodeComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWordMatch(text: string, token: string): boolean {
  return new RegExp(`(?<![a-z0-9-@/])${escapeRegex(token)}(?![a-z0-9-])`, 'i').test(text);
}

function e2eCandidateTokens(dep: string): string[] {
  const tokens = [dep.toLowerCase()];
  const wdioSvc = dep.match(/^@wdio\/(.+)-service$/);
  if (wdioSvc) {
    tokens.push(wdioSvc[1].toLowerCase());
  }
  const scoped = dep.match(/^@([^/]+)\/(.+)$/);
  if (scoped && !['wdio', 'types', 'vitest'].includes(scoped[1])) {
    tokens.push(scoped[1].toLowerCase(), scoped[2].toLowerCase());
  }
  if (dep.startsWith('appium-')) {
    tokens.push('appium');
  }
  return tokens;
}

/**
 * Map each dependency (and family token) in `e2e/` → the services whose E2E configs or specs
 * reference it. Derived by scanning `e2e/**` with `classifyFile`: per-service configs and test
 * directories map to their service, while shared E2E helpers and `e2e/package.json` scripts map
 * to all services.
 */
export function buildE2eDependencyServices(repoRoot: string, services: string[]): Record<string, string[]> {
  const e2eDir = path.join(repoRoot, 'e2e');
  if (!fs.existsSync(e2eDir)) {
    return {};
  }
  const serviceTexts: Record<string, string[]> = Object.fromEntries(services.map((svc) => [svc, []]));
  const sharedTexts: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'logs') {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.(ts|js|mjs)$/.test(entry.name)) {
        const relPath = path.relative(repoRoot, fullPath).split(path.sep).join('/');
        const verdict = classifyFile(relPath, services);
        const text = stripCodeComments(fs.readFileSync(fullPath, 'utf8'));
        if (services.includes(verdict)) {
          serviceTexts[verdict].push(text);
        } else {
          sharedTexts.push(text);
        }
      }
    }
  };
  walk(e2eDir);

  const e2ePkgPath = path.join(e2eDir, 'package.json');
  const depNames = new Set<string>();
  if (fs.existsSync(e2ePkgPath)) {
    try {
      const e2ePkg = JSON.parse(fs.readFileSync(e2ePkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      sharedTexts.push(JSON.stringify(e2ePkg.scripts ?? {}));
      for (const dep of Object.keys({ ...e2ePkg.dependencies, ...e2ePkg.devDependencies })) {
        depNames.add(dep);
      }
    } catch {
      // Ignore malformed e2e/package.json here; classifyE2ePackageJson handles parse errors.
    }
  }

  const joinedServiceText: Record<string, string> = Object.fromEntries(
    services.map((svc) => [svc, serviceTexts[svc].join('\n').toLowerCase()]),
  );
  const joinedSharedText = sharedTexts.join('\n').toLowerCase();
  const allServices = [...services].sort();

  const resolveForDep = (dep: string): string[] => {
    const directSvc = serviceForToken(dep, services);
    if (directSvc) {
      return [directSvc];
    }
    if (dep.startsWith('@wdio/native-') || dep === '@wdio/bundler' || hasWordMatch(joinedSharedText, dep)) {
      return allServices;
    }
    const tokens = e2eCandidateTokens(dep);
    const matched = services.filter((svc) => tokens.some((tok) => hasWordMatch(joinedServiceText[svc], tok))).sort();
    return matched.length > 0 ? matched : allServices;
  };

  const result: Record<string, string[]> = {};
  for (const dep of depNames) {
    result[dep] = resolveForDep(dep);
    for (const token of e2eCandidateTokens(dep)) {
      if (!result[token]) {
        result[token] = resolveForDep(token);
      }
    }
  }
  return result;
}

/**
 * Map each dependency name referenced via `catalog:` in workspace `package.json` files → the
 * relative `package.json` paths that consume it.
 */
export function buildCatalogConsumers(repoRoot: string): Record<string, string[]> {
  const pkgFiles: string[] = ['package.json', 'e2e/package.json'];
  for (const group of ['packages', 'examples', 'fixtures/e2e-apps', 'fixtures/package-tests']) {
    const groupDir = path.join(repoRoot, group);
    if (!fs.existsSync(groupDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pkgFiles.push(`${group}/${entry.name}/package.json`);
      }
    }
  }

  const consumers: Record<string, string[]> = {};
  for (const relPath of pkgFiles) {
    const fullPath = path.join(repoRoot, relPath);
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    let pkg: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    try {
      pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch {
      continue;
    }
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    };
    for (const [dep, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.startsWith('catalog:')) {
        if (!consumers[dep]) {
          consumers[dep] = [];
        }
        if (!consumers[dep].includes(relPath)) {
          consumers[dep].push(relPath);
        }
      }
    }
  }
  for (const dep of Object.keys(consumers)) {
    consumers[dep].sort();
  }
  return consumers;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInertRootDevDep(dep: string): boolean {
  return ROOT_INERT_DEV_DEP_PREFIXES.some((prefix) => dep.startsWith(prefix));
}

function classifyRootDevDep(dep: string, effect: ManifestEffect): void {
  if (!isInertRootDevDep(dep)) {
    effect.rootShared = true;
  }
}

function servicesForE2eDep(dep: string, services: string[], e2eDeps: Record<string, string[]>): string[] {
  const fromMap = e2eDeps[dep];
  if (fromMap && fromMap.length > 0) {
    return fromMap;
  }
  const directSvc = serviceForToken(dep, services);
  if (directSvc) {
    return [directSvc];
  }
  for (const token of e2eCandidateTokens(dep)) {
    const tokenSvcs = e2eDeps[token];
    if (tokenSvcs && tokenSvcs.length > 0) {
      return tokenSvcs;
    }
  }
  return services;
}

function classifyE2eDep(
  dep: string,
  services: string[],
  e2eDeps: Record<string, string[]>,
  effect: ManifestEffect,
): void {
  const matched = servicesForE2eDep(dep, services, e2eDeps);
  if (matched.length === 0 || matched.length >= services.length) {
    effect.all = true;
    return;
  }
  for (const svc of matched) {
    effect.services.add(svc);
  }
}

function classifyCatalogDep(
  dep: string,
  services: string[],
  catalogConsumers: Record<string, string[]>,
  e2eDeps: Record<string, string[]>,
  effect: ManifestEffect,
): void {
  const consumers = catalogConsumers[dep] ?? [];
  if (consumers.length === 0) {
    effect.all = true;
    return;
  }
  for (const pkgFile of consumers) {
    if (pkgFile === 'e2e/package.json') {
      classifyE2eDep(dep, services, e2eDeps, effect);
      continue;
    }
    if (pkgFile === 'package.json') {
      classifyRootDevDep(dep, effect);
      continue;
    }
    const verdict = classifyFile(pkgFile, services);
    if (verdict === 'shared') {
      const dir = pkgFile.split('/')[1];
      if (dir && !effect.sharedDirs.includes(dir)) {
        effect.sharedDirs.push(dir);
      }
    } else if (services.includes(verdict)) {
      effect.services.add(verdict);
    } else {
      effect.all = true;
    }
  }
}

function changedRecordKeys(base: Record<string, unknown>, head: Record<string, unknown>): string[] {
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (JSON.stringify(base[key]) !== JSON.stringify(head[key])) {
      changed.push(key);
    }
  }
  return changed;
}

function classifyRootPackageJson(base: string, head: string): ManifestEffect {
  const effect = emptyEffect();
  let baseObj: unknown;
  let headObj: unknown;
  try {
    baseObj = JSON.parse(base);
    headObj = JSON.parse(head);
  } catch {
    effect.all = true;
    effect.unknown = true;
    return effect;
  }
  if (!isPlainObject(baseObj) || !isPlainObject(headObj)) {
    effect.all = true;
    effect.unknown = true;
    return effect;
  }
  for (const key of changedRecordKeys(baseObj, headObj)) {
    if (key !== 'devDependencies') {
      effect.all = true;
      return effect;
    }
  }
  const baseDev = baseObj.devDependencies ?? {};
  const headDev = headObj.devDependencies ?? {};
  if (!isPlainObject(baseDev) || !isPlainObject(headDev)) {
    effect.all = true;
    return effect;
  }
  for (const dep of changedRecordKeys(baseDev, headDev)) {
    classifyRootDevDep(dep, effect);
  }
  return effect;
}

function classifyE2ePackageJson(
  base: string,
  head: string,
  services: string[],
  e2eDeps: Record<string, string[]>,
): ManifestEffect {
  const effect = emptyEffect();
  let baseObj: unknown;
  let headObj: unknown;
  try {
    baseObj = JSON.parse(base);
    headObj = JSON.parse(head);
  } catch {
    effect.all = true;
    effect.unknown = true;
    return effect;
  }
  if (!isPlainObject(baseObj) || !isPlainObject(headObj)) {
    effect.all = true;
    effect.unknown = true;
    return effect;
  }
  for (const key of changedRecordKeys(baseObj, headObj)) {
    if (key !== 'dependencies' && key !== 'devDependencies') {
      effect.all = true;
      return effect;
    }
  }
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const baseDeps = baseObj[field] ?? {};
    const headDeps = headObj[field] ?? {};
    if (!isPlainObject(baseDeps) || !isPlainObject(headDeps)) {
      effect.all = true;
      return effect;
    }
    for (const dep of changedRecordKeys(baseDeps, headDeps)) {
      classifyE2eDep(dep, services, e2eDeps, effect);
    }
  }
  return effect;
}

function splitIndentedKeyLine(line: string, indent: number): { key: string; inline: string } | undefined {
  const prefix = ' '.repeat(indent);
  if (!line.startsWith(prefix) || line.startsWith(`${prefix} `)) {
    return undefined;
  }
  const rest = line.slice(indent).trimEnd();
  if (!rest || rest.startsWith('#')) {
    return undefined;
  }
  let keyEnd: number;
  if (rest.startsWith("'") || rest.startsWith('"')) {
    keyEnd = rest.indexOf(rest[0] as string, 1) + 1;
  } else {
    const separator = rest.indexOf(': ');
    keyEnd = separator === -1 ? rest.length - 1 : separator;
  }
  if (keyEnd <= 0 || rest[keyEnd] !== ':') {
    return undefined;
  }
  return { key: unquoteLockKey(rest.slice(0, keyEnd)), inline: rest.slice(keyEnd + 1).trim() };
}

interface ParsedWorkspaceYaml {
  catalogs: Map<string, { dep: string; value: string }>;
  other: Map<string, string>;
  valid: boolean;
}

function parseWorkspaceYaml(text: string): ParsedWorkspaceYaml {
  const catalogs = new Map<string, { dep: string; value: string }>();
  const other = new Map<string, string>();
  let section: string | undefined;
  let catalogName = 'default';
  let sawTopLevel = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    if (!line.startsWith(' ')) {
      const colon = line.indexOf(':');
      if (colon <= 0) {
        return { catalogs, other, valid: false };
      }
      sawTopLevel = true;
      section = line.slice(0, colon).trim();
      catalogName = 'default';
      if (section !== 'catalogs' && section !== 'catalog') {
        const prev = other.get(section);
        other.set(section, prev === undefined ? line : `${prev}\n${line}`);
      }
      continue;
    }
    if (!section) {
      return { catalogs, other, valid: false };
    }
    if (section === 'catalogs') {
      const catEntry = splitIndentedKeyLine(line, 2);
      if (catEntry && catEntry.inline === '') {
        catalogName = catEntry.key;
        continue;
      }
      const depEntry = splitIndentedKeyLine(line, 4);
      if (depEntry && depEntry.inline !== '') {
        catalogs.set(`${catalogName}\0${depEntry.key}`, { dep: depEntry.key, value: depEntry.inline });
        continue;
      }
      return { catalogs, other, valid: false };
    }
    if (section === 'catalog') {
      const depEntry = splitIndentedKeyLine(line, 2);
      if (depEntry && depEntry.inline !== '') {
        catalogs.set(`default\0${depEntry.key}`, { dep: depEntry.key, value: depEntry.inline });
        continue;
      }
      return { catalogs, other, valid: false };
    }
    const prev = other.get(section) ?? '';
    other.set(section, prev ? `${prev}\n${line}` : line);
  }
  return { catalogs, other, valid: sawTopLevel };
}

function classifyWorkspaceYaml(
  base: string,
  head: string,
  services: string[],
  catalogConsumers: Record<string, string[]>,
  e2eDeps: Record<string, string[]>,
): ManifestEffect {
  const effect = emptyEffect();
  const parsedBase = parseWorkspaceYaml(base);
  const parsedHead = parseWorkspaceYaml(head);
  if (!parsedBase.valid || !parsedHead.valid) {
    effect.all = true;
    effect.unknown = true;
    return effect;
  }
  for (const key of new Set([...parsedBase.other.keys(), ...parsedHead.other.keys()])) {
    if ((parsedBase.other.get(key) ?? '') !== (parsedHead.other.get(key) ?? '')) {
      effect.all = true;
      return effect;
    }
  }
  for (const key of new Set([...parsedBase.catalogs.keys(), ...parsedHead.catalogs.keys()])) {
    const baseEntry = parsedBase.catalogs.get(key);
    const headEntry = parsedHead.catalogs.get(key);
    if (baseEntry?.value === headEntry?.value) {
      continue;
    }
    const dep = (headEntry ?? baseEntry)?.dep;
    if (dep) {
      classifyCatalogDep(dep, services, catalogConsumers, e2eDeps, effect);
    }
  }
  return effect;
}

function unquoteLockKey(raw: string): string {
  if (raw.length >= 2) {
    const quote = raw[0];
    if ((quote === "'" || quote === '"') && raw.endsWith(quote)) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

// Entry keys sit at two spaces: `key:` opens a block, and `key: {}` is pnpm's inline form for an entry with no body.
function splitLockEntryLine(line: string): { key: string; inline: string } | undefined {
  if (!line.startsWith('  ') || line.startsWith('   ')) {
    return undefined;
  }
  const rest = line.slice(2).trimEnd();
  let keyEnd: number;
  if (rest.startsWith("'") || rest.startsWith('"')) {
    keyEnd = rest.indexOf(rest[0] as string, 1) + 1;
  } else {
    const separator = rest.indexOf(': ');
    keyEnd = separator === -1 ? rest.length - 1 : separator;
  }
  if (keyEnd <= 0 || rest[keyEnd] !== ':') {
    return undefined;
  }
  return { key: unquoteLockKey(rest.slice(0, keyEnd)), inline: rest.slice(keyEnd + 1).trim() };
}

// pnpm-lock.yaml is two YAML documents, with entries under importers, packages and snapshots. The detect
// job has no YAML parser, so this reads it line by line.
function parseLockfile(text: string): ParsedLockfile {
  const entries: ParsedLockfile['entries'] = {
    importers: new Map(),
    packages: new Map(),
    snapshots: new Map(),
  };
  const other = new Map<string, string>();
  let section: string | undefined;
  let entryKey: string | undefined;
  let entryLines: string[] = [];

  const flushEntry = () => {
    if (!section || !entryKey || !LOCKFILE_ENTRY_SECTIONS.has(section)) {
      return;
    }
    const bucket = entries[section as 'importers' | 'packages' | 'snapshots'];
    // Blank lines separate entries, so they mustn't count as part of the one they follow.
    while (entryLines.at(-1)?.trim() === '') {
      entryLines.pop();
    }
    const body = entryLines.join('\n');
    const previous = bucket.get(entryKey);
    bucket.set(entryKey, previous === undefined ? body : `${previous}\n${body}`);
    entryKey = undefined;
    entryLines = [];
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '---' || line === '...') {
      flushEntry();
      section = undefined;
      continue;
    }
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) {
      flushEntry();
      const colon = line.indexOf(':');
      section = colon === -1 ? line : line.slice(0, colon);
      if (!LOCKFILE_ENTRY_SECTIONS.has(section)) {
        const previous = other.get(section);
        other.set(section, previous === undefined ? line : `${previous}\n${line}`);
      }
      continue;
    }
    if (!section) {
      continue;
    }
    if (LOCKFILE_ENTRY_SECTIONS.has(section)) {
      const entry = splitLockEntryLine(line);
      if (entry) {
        flushEntry();
        entryKey = entry.key;
        if (entry.inline) {
          entryLines.push(entry.inline);
        }
        continue;
      }
      if (entryKey) {
        entryLines.push(line);
      }
      continue;
    }
    const previous = other.get(section) ?? '';
    other.set(section, previous ? `${previous}\n${line}` : line);
  }
  flushEntry();
  return { entries, other };
}

function looksLikeLockfile(text: string): boolean {
  return text.includes('lockfileVersion:') && text.includes('\nimporters:');
}

function canonicalLockfile(parsed: ParsedLockfile): string {
  const dump = (map: Map<string, string>) =>
    [...map.entries()]
      .sort(([a], [b]) => {
        if (a < b) {
          return -1;
        }
        if (a > b) {
          return 1;
        }
        return 0;
      })
      .map(([key, body]) => `${key}\n${body}`)
      .join('\n');
  return [
    dump(parsed.other),
    dump(parsed.entries.importers),
    dump(parsed.entries.packages),
    dump(parsed.entries.snapshots),
  ].join('\n---\n');
}

interface ParsedImporterBody {
  sections: Map<string, Map<string, string>>;
  other: Map<string, string>;
  valid: boolean;
}

function parseLockImporterBody(body: string): ParsedImporterBody {
  const sections = new Map<string, Map<string, string>>();
  const other = new Map<string, string>();
  if (body.trim() === '' || body.trim() === '{}') {
    return { sections, other, valid: true };
  }
  let currentSection: string | undefined;
  let currentDep: string | undefined;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }
    const secEntry = splitIndentedKeyLine(line, 4);
    if (secEntry) {
      currentDep = undefined;
      if (secEntry.inline !== '') {
        currentSection = undefined;
        other.set(secEntry.key, secEntry.inline);
      } else {
        currentSection = secEntry.key;
        if (!sections.has(currentSection)) {
          sections.set(currentSection, new Map());
        }
      }
      continue;
    }
    const depEntry = splitIndentedKeyLine(line, 6);
    if (depEntry && currentSection) {
      currentDep = depEntry.key;
      const bucket = sections.get(currentSection);
      if (bucket) {
        bucket.set(currentDep, depEntry.inline);
      }
      continue;
    }
    if (line.startsWith('        ') && currentSection && currentDep) {
      const bucket = sections.get(currentSection);
      if (bucket) {
        const prev = bucket.get(currentDep) ?? '';
        bucket.set(currentDep, prev ? `${prev}\n${line}` : line);
      }
      continue;
    }
    return { sections, other, valid: false };
  }
  return { sections, other, valid: true };
}

function parseLockCatalogs(text: string | undefined): {
  entries: Map<string, { dep: string; value: string }>;
  valid: boolean;
} {
  const entries = new Map<string, { dep: string; value: string }>();
  if (!text) {
    return { entries, valid: true };
  }
  let catalogName: string | undefined;
  let currentKey: string | undefined;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim() || line.trim().startsWith('#') || line === 'catalogs:') {
      continue;
    }
    const catEntry = splitIndentedKeyLine(line, 2);
    if (catEntry && catEntry.inline === '') {
      catalogName = catEntry.key;
      currentKey = undefined;
      continue;
    }
    const depEntry = splitIndentedKeyLine(line, 4);
    if (depEntry && catalogName) {
      currentKey = `${catalogName}\0${depEntry.key}`;
      entries.set(currentKey, { dep: depEntry.key, value: depEntry.inline });
      continue;
    }
    if (line.startsWith('      ') && currentKey) {
      const prev = entries.get(currentKey);
      if (prev) {
        prev.value = prev.value ? `${prev.value}\n${line}` : line;
      }
      continue;
    }
    return { entries, valid: false };
  }
  return { entries, valid: true };
}

function changedMapKeys(base: Map<string, string>, head: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const key of new Set([...base.keys(), ...head.keys()])) {
    if ((base.get(key) ?? '') !== (head.get(key) ?? '')) {
      changed.push(key);
    }
  }
  return changed;
}

function classifyImporterPath(importer: string, services: string[]): Verdict {
  if (importer === '.' || importer === 'e2e') {
    return 'all';
  }
  const asFile =
    importer.startsWith('packages/') || importer.startsWith('fixtures/') ? `${importer}/package.json` : undefined;
  if (!asFile) {
    return 'all';
  }
  const verdict = classifyFile(asFile, services);
  if (verdict === 'none' || verdict === 'unknown') {
    return 'all';
  }
  return verdict;
}

function classifyLockfile(
  base: string,
  head: string,
  services: string[],
  e2eDeps: Record<string, string[]>,
  catalogConsumers: Record<string, string[]>,
): ManifestEffect {
  const effect = emptyEffect();
  if (!looksLikeLockfile(base) || !looksLikeLockfile(head)) {
    effect.all = true;
    effect.unknown = true;
    return effect;
  }
  const parsedBase = parseLockfile(base);
  const parsedHead = parseLockfile(head);

  for (const name of new Set([...parsedBase.other.keys(), ...parsedHead.other.keys()])) {
    if ((parsedBase.other.get(name) ?? '') === (parsedHead.other.get(name) ?? '')) {
      continue;
    }
    if (name === 'catalogs') {
      const baseCat = parseLockCatalogs(parsedBase.other.get('catalogs'));
      const headCat = parseLockCatalogs(parsedHead.other.get('catalogs'));
      if (!baseCat.valid || !headCat.valid) {
        effect.all = true;
        continue;
      }
      for (const key of new Set([...baseCat.entries.keys(), ...headCat.entries.keys()])) {
        const b = baseCat.entries.get(key);
        const h = headCat.entries.get(key);
        if (b?.value !== h?.value) {
          const dep = (h ?? b)?.dep;
          if (dep) {
            classifyCatalogDep(dep, services, catalogConsumers, e2eDeps, effect);
          }
        }
      }
      continue;
    }
    effect.all = true;
  }

  for (const key of new Set([...parsedBase.entries.importers.keys(), ...parsedHead.entries.importers.keys()])) {
    const baseImpBody = parsedBase.entries.importers.get(key);
    const headImpBody = parsedHead.entries.importers.get(key);
    if (baseImpBody === headImpBody) {
      continue;
    }
    if (key === '.') {
      const baseImp = parseLockImporterBody(baseImpBody ?? '');
      const headImp = parseLockImporterBody(headImpBody ?? '');
      if (!baseImp.valid || !headImp.valid || changedMapKeys(baseImp.other, headImp.other).length > 0) {
        effect.all = true;
        continue;
      }
      for (const sec of new Set([...baseImp.sections.keys(), ...headImp.sections.keys()])) {
        const changedDeps = changedMapKeys(
          baseImp.sections.get(sec) ?? new Map(),
          headImp.sections.get(sec) ?? new Map(),
        );
        if (changedDeps.length === 0) {
          continue;
        }
        if (sec !== 'devDependencies') {
          effect.all = true;
        } else {
          for (const dep of changedDeps) {
            classifyRootDevDep(dep, effect);
          }
        }
      }
      continue;
    }
    if (key === 'e2e') {
      const baseImp = parseLockImporterBody(baseImpBody ?? '');
      const headImp = parseLockImporterBody(headImpBody ?? '');
      if (!baseImp.valid || !headImp.valid || changedMapKeys(baseImp.other, headImp.other).length > 0) {
        effect.all = true;
        continue;
      }
      for (const sec of new Set([...baseImp.sections.keys(), ...headImp.sections.keys()])) {
        const changedDeps = changedMapKeys(
          baseImp.sections.get(sec) ?? new Map(),
          headImp.sections.get(sec) ?? new Map(),
        );
        if (changedDeps.length === 0) {
          continue;
        }
        if (sec !== 'dependencies' && sec !== 'devDependencies') {
          effect.all = true;
        } else {
          for (const dep of changedDeps) {
            classifyE2eDep(dep, services, e2eDeps, effect);
          }
        }
      }
      continue;
    }
    const verdict = classifyImporterPath(key, services);
    if (verdict === 'all' || verdict === 'unknown') {
      effect.all = true;
    } else if (verdict === 'shared') {
      const dir = key.split('/')[1];
      if (dir) {
        effect.sharedDirs.push(dir);
      }
    } else {
      effect.services.add(verdict);
    }
  }

  // Only in-place edits count. Anything that uses a newly added package also changes an importer or an
  // existing snapshot, which is classified.
  for (const section of ['packages', 'snapshots'] as const) {
    const baseEntries = parsedBase.entries[section];
    const headEntries = parsedHead.entries[section];
    for (const key of new Set([...baseEntries.keys(), ...headEntries.keys()])) {
      if (baseEntries.has(key) && headEntries.has(key) && baseEntries.get(key) !== headEntries.get(key)) {
        effect.all = true;
      }
    }
  }

  // The text changed but no entry the reader understands did, so it can't place the change: run everything.
  if (
    !effect.all &&
    !effect.rootShared &&
    effect.services.size === 0 &&
    effect.sharedDirs.length === 0 &&
    base !== head &&
    canonicalLockfile(parsedBase) === canonicalLockfile(parsedHead)
  ) {
    effect.all = true;
    effect.unknown = true;
  }
  return effect;
}

function manifestVerdict(effect: ManifestEffect): Verdict {
  if (effect.unknown) {
    return 'unknown';
  }
  if (effect.all) {
    return 'all';
  }
  if (effect.sharedDirs.length > 0 || (effect.rootShared && effect.services.size === 0)) {
    return 'shared';
  }
  if (effect.services.size === 1) {
    return [...effect.services][0] as string;
  }
  if (effect.services.size === 0) {
    return 'none';
  }
  return [...effect.services].sort().join(',');
}

function diffBaseRef(): string | undefined {
  const baseRef = process.env.DIFF_BASE ?? '';
  // Reject anything that isn't a plain ref, and a new branch's all-zero before-sha.
  if (!/^[A-Za-z0-9._/-]+$/.test(baseRef) || baseRef.startsWith('-') || /^0+$/.test(baseRef)) {
    return undefined;
  }
  return baseRef;
}

function readManifestPairs(files: string[]): Partial<Record<DiffManifestFile, ManifestPair>> {
  const baseRef = diffBaseRef();
  if (!baseRef) {
    return {};
  }
  const pairs: Partial<Record<DiffManifestFile, ManifestPair>> = {};
  for (const file of DIFF_MANIFEST_FILES) {
    if (!files.includes(file)) {
      continue;
    }
    try {
      const base = execFileSync('git', ['show', `${baseRef}:${file}`], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      pairs[file] = { base, head: fs.readFileSync(file, 'utf8') };
    } catch {
      // Base or head copy unavailable — falls back to classifyFile ('all').
    }
  }
  return pairs;
}

/**
 * Classify one changed file.
 * Returns: 'none' | 'shared' | 'all' | a service name.
 */
export function classifyFile(file: string, services: string[]): Verdict {
  // Generated permission docs ship in the plugin crates, so a change to them must run that service's CI.
  const isPermissionsFile = /^packages\/[^/]+\/permissions\//.test(file);
  if (file.endsWith('.md') && !isPermissionsFile) {
    return 'none';
  }

  const pkg = file.match(/^packages\/([^/]+)\//);
  if (pkg) {
    const dir = pkg[1];
    if (SHARED_PACKAGES.has(dir) || SHARED_PACKAGE_PREFIXES.some((p) => dir.startsWith(p))) {
      return 'shared';
    }
    return serviceForDir(dir, services) ?? 'unknown';
  }

  if (file.startsWith('e2e/')) {
    const test = file.match(/^e2e\/test\/([^/]+)\//);
    // serviceForDir (not exact match) so suffixed dirs like `dioxus-browser`
    // route to their service — mirrors the wdio.<svc>-*.conf.ts rule below.
    if (test) {
      return serviceForDir(test[1], services) ?? 'all';
    }
    const conf = file.match(/^e2e\/wdio\.([^/]+)\.conf\.ts$/);
    if (conf) {
      return serviceForDir(conf[1], services) ?? 'all';
    }
    return 'all';
  }

  const fixture = file.match(/^fixtures\/(?:e2e-apps|package-tests)\/([^/]+)\//);
  if (fixture) {
    return serviceForDir(fixture[1], services) ?? 'unknown';
  }
  if (file.startsWith('fixtures/')) {
    return 'unknown';
  }

  if (file.startsWith('.github/workflows/actions/')) {
    return 'all';
  }
  if (file.startsWith('.github/workflows/')) {
    const name = path.basename(file);
    if (CORE_INFRA_WORKFLOWS.has(name)) {
      return 'all';
    }
    if (META_WORKFLOWS.has(name)) {
      return 'none';
    }
    return serviceForToken(name, services) ?? 'unknown';
  }
  if (file.startsWith('.github/')) {
    return 'none';
  }

  if (file.startsWith('scripts/')) {
    return serviceForToken(path.basename(file), services) ?? 'all';
  }

  if (!file.includes('/')) {
    if (LINT_ONLY_FILES.has(file)) {
      return 'none';
    }
    if (ROOT_INFRA_FILES.has(file)) {
      return 'all';
    }
    if (file.startsWith('tsconfig') && file.endsWith('.json')) {
      return 'all';
    }
  }

  return 'none';
}

/**
 * Services whose E2E a shared-package change must run. A types-only package needs none — its
 * change is erased at compile time, so build/unit already cover it. The `bundler` build tool
 * changes every package's build output, so all. Otherwise: the transitive dependents from the dep
 * graph, falling back to every service for a new/unknown shared package with no known dependents
 * (over-run, never silently under-run).
 */
function affectedServices(dir: string, services: string[], dependents: Record<string, string[]>): string[] {
  if (TYPES_ONLY_PACKAGES.has(dir)) {
    return [];
  }
  if (SHARED_PACKAGES.has(dir)) {
    return services;
  }
  return dependents[dir]?.length ? dependents[dir] : services;
}

function classifyManifestFile(
  file: DiffManifestFile,
  pair: ManifestPair,
  services: string[],
  e2eDeps: Record<string, string[]>,
  catalogConsumers: Record<string, string[]>,
): ManifestEffect {
  switch (file) {
    case 'package.json':
      return classifyRootPackageJson(pair.base, pair.head);
    case 'e2e/package.json':
      return classifyE2ePackageJson(pair.base, pair.head, services, e2eDeps);
    case 'pnpm-workspace.yaml':
      return classifyWorkspaceYaml(pair.base, pair.head, services, catalogConsumers, e2eDeps);
    case 'pnpm-lock.yaml':
      return classifyLockfile(pair.base, pair.head, services, e2eDeps, catalogConsumers);
  }
}

export function classifyChanges(
  files: string[],
  services: string[],
  {
    forceAll = false,
    releaseCommit = false,
    dependents = {} as Record<string, string[]>,
    e2eDeps = {} as Record<string, string[]>,
    catalogConsumers = {} as Record<string, string[]>,
    lockfile,
    manifests = {},
    commentOnly = new Set<string>(),
  }: {
    forceAll?: boolean;
    releaseCommit?: boolean;
    dependents?: Record<string, string[]>;
    e2eDeps?: Record<string, string[]>;
    catalogConsumers?: Record<string, string[]>;
    lockfile?: ManifestPair;
    manifests?: Partial<Record<DiffManifestFile, ManifestPair>>;
    commentOnly?: Set<string>;
  } = {},
): Classification {
  const runs: Record<string, boolean> = Object.fromEntries(services.map((svc) => [svc, false]));
  let sharedChanges = false;
  // Deliberate run-everything verdicts (core infra, cross-service scripts, shared e2e)
  // vs files no convention rule could place — both run all pipelines, but only the
  // latter signal naming-convention drift.
  const triggersAll: string[] = [];
  const unknownFiles: string[] = [];
  const sharedDetail: Array<{ file: string; pkg: string; services: string[]; typesOnly: boolean }> = [];

  if (forceAll) {
    for (const svc of services) {
      runs[svc] = true;
    }
    return {
      runs,
      sharedChanges: true,
      lintOnly: false,
      triggersAll,
      unknownFiles,
      commentOnlyFiles: [],
      sharedDetail,
      perFile: [],
    };
  }

  if (releaseCommit) {
    return {
      runs,
      sharedChanges: false,
      lintOnly: true,
      triggersAll,
      unknownFiles,
      commentOnlyFiles: [],
      sharedDetail,
      perFile: [],
    };
  }

  const manifestPairs: Partial<Record<DiffManifestFile, ManifestPair>> = {
    ...manifests,
    ...(lockfile ? { 'pnpm-lock.yaml': lockfile } : {}),
  };

  const perFile: Array<{ file: string; verdict: Verdict }> = [];
  const commentOnlyFiles: string[] = [];
  for (const file of files) {
    if (commentOnly.has(file)) {
      commentOnlyFiles.push(file);
      perFile.push({ file, verdict: 'none' });
      continue;
    }
    if ((DIFF_MANIFEST_FILES as readonly string[]).includes(file)) {
      const manifestFile = file as DiffManifestFile;
      const pair = manifestPairs[manifestFile];
      if (!pair) {
        perFile.push({ file, verdict: 'all' });
        triggersAll.push(file);
        for (const svc of services) {
          runs[svc] = true;
        }
        continue;
      }
      const effect = classifyManifestFile(manifestFile, pair, services, e2eDeps, catalogConsumers);
      if (effect.rootShared) {
        sharedChanges = true;
      }
      if (effect.all) {
        if (effect.unknown) {
          unknownFiles.push(file);
        } else {
          triggersAll.push(file);
        }
        for (const svc of services) {
          runs[svc] = true;
        }
      }
      for (const dir of effect.sharedDirs) {
        sharedChanges = true;
        const affected = affectedServices(dir, services, dependents);
        for (const svc of affected) {
          runs[svc] = true;
        }
        sharedDetail.push({ file, pkg: dir, services: affected, typesOnly: TYPES_ONLY_PACKAGES.has(dir) });
      }
      for (const svc of effect.services) {
        if (services.includes(svc)) {
          runs[svc] = true;
        } else {
          unknownFiles.push(file);
          for (const every of services) {
            runs[every] = true;
          }
        }
      }
      perFile.push({ file, verdict: manifestVerdict(effect) });
      continue;
    }
    const verdict = classifyFile(file, services);
    perFile.push({ file, verdict });
    if (verdict === 'none') {
      continue;
    }
    if (verdict === 'shared') {
      // A shared-package change always needs build/unit (sharedChanges keeps it off the lint-only
      // path below); affectedServices decides which services' E2E it can actually affect at runtime.
      sharedChanges = true;
      const dir = (file.match(/^packages\/([^/]+)\//) as RegExpMatchArray)[1];
      const affected = affectedServices(dir, services, dependents);
      for (const svc of affected) {
        runs[svc] = true;
      }
      sharedDetail.push({ file, pkg: dir, services: affected, typesOnly: TYPES_ONLY_PACKAGES.has(dir) });
    } else if (verdict === 'all' || verdict === 'unknown') {
      if (verdict === 'all') {
        triggersAll.push(file);
      } else {
        unknownFiles.push(file);
      }
      for (const svc of services) {
        runs[svc] = true;
      }
    } else {
      runs[verdict] = true;
    }
  }

  // Lint-only = nothing needs build: no service runs AND no shared (compile-affecting) change.
  // A types-only shared change runs no service yet must still build/typecheck, so the
  // sharedChanges term keeps it off this path (build + unit gate on `run_lint_only != true`).
  const lintOnly = services.every((svc) => !runs[svc]) && !sharedChanges;
  return { runs, sharedChanges, lintOnly, triggersAll, unknownFiles, commentOnlyFiles, sharedDetail, perFile };
}

function appendFile(envVar: string, content: string): void {
  const target = process.env[envVar];
  if (target) {
    fs.appendFileSync(target, content);
  }
}

function main(): void {
  const files: string[] = JSON.parse(process.env.CHANGED_FILES || '[]');
  const forceAll = process.env.FORCE_ALL === 'true';
  const releaseCommit = process.env.RELEASE_COMMIT === 'true';
  const services = discoverServices(process.cwd());
  const dependents = buildServiceDependents(process.cwd(), services);
  const e2eDeps = buildE2eDependencyServices(process.cwd(), services);
  const catalogConsumers = buildCatalogConsumers(process.cwd());
  const manifests = readManifestPairs(files);
  const commentOnly = findCommentOnlyWorkflowChanges(files, services, gitDiffReader(diffBaseRef()));

  const { runs, sharedChanges, lintOnly, triggersAll, unknownFiles, commentOnlyFiles, sharedDetail, perFile } =
    classifyChanges(files, services, {
      forceAll,
      releaseCommit,
      dependents,
      e2eDeps,
      catalogConsumers,
      manifests,
      commentOnly,
    });

  let output = '';
  for (const [svc, run] of Object.entries(runs)) {
    output += `run_${svc}=${run}\n`;
  }
  output += `runs=${JSON.stringify(runs)}\n`;
  output += `has_shared_changes=${sharedChanges}\n`;
  output += `run_lint_only=${lintOnly}\n`;
  appendFile('GITHUB_OUTPUT', output);

  let summary = '## Change Detection Summary\n\n';
  summary += forceAll ? '**Force-all mode** — running everything.\n\n' : '';
  summary += releaseCommit && !forceAll ? '**Release commit** — lint only.\n\n' : '';
  summary += '| Service | Run |\n|---------|-----|\n';
  for (const [svc, run] of Object.entries(runs)) {
    summary += `| ${svc} | ${run} |\n`;
  }
  summary += `\n- Shared package changes: ${sharedChanges}\n- Lint only: ${lintOnly}\n`;
  if (sharedDetail.length > 0) {
    summary += '\n### Shared package changes (narrowed to runtime dependents)\n\n';
    summary += 'build + unit run regardless; E2E runs only for the services a shared change can affect:\n\n';
    for (const { file, pkg, services: svcs, typesOnly } of sharedDetail) {
      const target = typesOnly ? 'types-only → typecheck/build only, no E2E' : svcs.join(', ') || 'all';
      summary += `- \`${file}\` (${pkg}) → ${target}\n`;
    }
  }
  if (triggersAll.length > 0) {
    summary += '\n### Core infra / cross-service changes (run all pipelines)\n\n';
    for (const file of triggersAll) {
      summary += `- \`${file}\`\n`;
    }
  }
  if (commentOnlyFiles.length > 0) {
    summary += '\n### Comment-only workflow changes (no pipelines)\n\n';
    for (const file of commentOnlyFiles) {
      summary += `- \`${file}\`\n`;
    }
  }
  if (unknownFiles.length > 0) {
    summary += '\n### ⚠️ Unclassified files (running all pipelines defensively)\n\n';
    summary += 'No naming-convention rule places these — possible convention drift. ';
    summary += 'Either rename to match the conventions or teach `scripts/detect-changes.ts` about them:\n\n';
    for (const file of unknownFiles) {
      summary += `- \`${file}\`\n`;
    }
  }
  appendFile('GITHUB_STEP_SUMMARY', summary);

  console.log(`services: ${services.join(', ')}`);
  for (const { file, verdict } of perFile) {
    console.log(`  ${verdict.padEnd(7)} ${file}`);
  }
  console.log(output.trimEnd());
}

if (import.meta.main) {
  main();
}
