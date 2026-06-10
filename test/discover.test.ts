import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectDirName, discoverRepos, expandTilde } from '../src/discover.js';

let dir: string;

function makeRepo(name: string, opts: { commit?: boolean; dirty?: boolean } = {}): string {
  const repo = join(dir, 'roots', name);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  if (opts.commit !== false) {
    writeFileSync(join(repo, 'README.md'), name);
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', [
      '-C', repo,
      '-c', 'user.name=t',
      '-c', 'user.email=t@t',
      '-c', 'commit.gpgsign=false',
      'commit', '-qm', 'init',
    ]);
  }
  if (opts.dirty) writeFileSync(join(repo, 'scratch.txt'), 'wip');
  return repo;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'surplus-discover-'));
  mkdirSync(join(dir, 'roots'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('expandTilde', () => {
  it('expands ~ and ~/ against the home dir', () => {
    expect(expandTilde('~', '/home/x')).toBe('/home/x');
    expect(expandTilde('~/Projects', '/home/x')).toBe('/home/x/Projects');
    expect(expandTilde('/abs/path', '/home/x')).toBe('/abs/path');
  });
});

describe('claudeProjectDirName', () => {
  it('replaces slashes with dashes, preserving dots', () => {
    expect(claudeProjectDirName('/Users/x/.claude/skills/y')).toBe('-Users-x-.claude-skills-y');
  });
});

describe('discoverRepos', () => {
  it('finds git repos one level deep with branch, recency, and dirty state', () => {
    const a = makeRepo('alpha');
    makeRepo('beta', { dirty: true });
    mkdirSync(join(dir, 'roots', 'not-a-repo'));

    const repos = discoverRepos({ roots: [join(dir, 'roots')], homeDir: dir });
    expect(repos.map((r) => r.name).sort()).toEqual(['alpha', 'beta']);
    const alpha = repos.find((r) => r.name === 'alpha')!;
    expect(alpha.path).toBe(a);
    expect(alpha.branch).toBe('main');
    expect(alpha.lastCommitAt).toBeTypeOf('number');
    expect(alpha.dirty).toBe(false);
    expect(repos.find((r) => r.name === 'beta')!.dirty).toBe(true);
  });

  it('flags registered repos and tolerates missing roots', () => {
    const a = makeRepo('alpha');
    const repos = discoverRepos({
      roots: [join(dir, 'roots'), join(dir, 'missing-root')],
      registeredPaths: new Set([a]),
      homeDir: dir,
    });
    expect(repos.find((r) => r.name === 'alpha')!.registered).toBe(true);
  });

  it('flags repos recently opened in Claude Code via projects-dir mtime', () => {
    const a = makeRepo('alpha');
    makeRepo('beta');
    const claudeDir = join(dir, '.claude', 'projects');
    const recent = join(claudeDir, claudeProjectDirName(a));
    mkdirSync(recent, { recursive: true });

    const stale = join(claudeDir, claudeProjectDirName(join(dir, 'roots', 'beta')));
    mkdirSync(stale, { recursive: true });
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    const repos = discoverRepos({
      roots: [join(dir, 'roots')],
      homeDir: dir,
      claudeProjectsDir: claudeDir,
    });
    expect(repos.find((r) => r.name === 'alpha')!.claudeRecent).toBe(true);
    expect(repos.find((r) => r.name === 'beta')!.claudeRecent).toBe(false);
  });

  it('repos with no commits sort last and report null lastCommitAt', () => {
    makeRepo('committed');
    makeRepo('empty', { commit: false });
    const repos = discoverRepos({ roots: [join(dir, 'roots')], homeDir: dir });
    expect(repos[repos.length - 1]!.name).toBe('empty');
    expect(repos[repos.length - 1]!.lastCommitAt).toBeNull();
  });
});
