/**
 * discover.ts — local git-repo discovery for the board's Add-Project picker.
 *
 * Scans configured roots ONE level deep for directories containing .git,
 * ranks by last commit time, and flags repos recently opened in Claude Code
 * (via ~/.claude/projects mtimes — the closest available signal to "projects
 * the user is actively working on"). Local filesystem only; never leaves
 * the machine.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DiscoveredRepo } from './types.js';

const CLAUDE_RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REPOS = 200;
const GIT_TIMEOUT_MS = 3_000;

export function expandTilde(p: string, homeDir = os.homedir()): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return path.join(homeDir, p.slice(2));
  return p;
}

/**
 * Claude Code encodes a project path as a directory name: '/' -> '-'
 * (dots preserved — verified against real ~/.claude/projects entries).
 */
export function claudeProjectDirName(repoPath: string): string {
  return repoPath.replace(/\//g, '-');
}

function gitQuiet(repoPath: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    return null;
  }
}

export interface DiscoverOpts {
  roots: string[];
  /** Absolute paths of already-registered projects. */
  registeredPaths?: Set<string>;
  homeDir?: string;
  /** Clock override for tests. */
  now?: () => number;
  /** Claude Code projects dir; default <home>/.claude/projects. */
  claudeProjectsDir?: string;
}

export function discoverRepos(opts: DiscoverOpts): DiscoveredRepo[] {
  const homeDir = opts.homeDir ?? os.homedir();
  const now = opts.now ? opts.now() : Date.now();
  const registered = opts.registeredPaths ?? new Set<string>();
  const claudeDir = opts.claudeProjectsDir ?? path.join(homeDir, '.claude', 'projects');

  const seen = new Set<string>();
  const repos: DiscoveredRepo[] = [];

  for (const rawRoot of opts.roots) {
    const root = path.resolve(expandTilde(rawRoot, homeDir));
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue; // root missing/unreadable — skip silently
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const repoPath = path.join(root, entry);
      if (seen.has(repoPath)) continue;
      let isDir = false;
      try {
        isDir = statSync(repoPath).isDirectory();
      } catch {
        continue;
      }
      if (!isDir || !existsSync(path.join(repoPath, '.git'))) continue;
      seen.add(repoPath);

      const lastCommitRaw = gitQuiet(repoPath, ['log', '-1', '--format=%ct']);
      const lastCommitAt =
        lastCommitRaw !== null && /^\d+$/.test(lastCommitRaw) ? Number(lastCommitRaw) * 1000 : null;
      const branch = gitQuiet(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const status = gitQuiet(repoPath, ['status', '--porcelain']);

      let claudeRecent = false;
      try {
        const mtimeMs = statSync(path.join(claudeDir, claudeProjectDirName(repoPath))).mtimeMs;
        claudeRecent = now - mtimeMs < CLAUDE_RECENT_MS;
      } catch {
        /* never opened in Claude Code */
      }

      repos.push({
        name: entry,
        path: repoPath,
        branch: branch !== null && branch !== '' ? branch : null,
        lastCommitAt,
        dirty: status !== null && status !== '',
        registered: registered.has(repoPath),
        claudeRecent,
      });
      if (repos.length >= MAX_REPOS) break;
    }
  }

  // Most recently active first; repos with no commits sink to the bottom.
  repos.sort((a, b) => (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0));
  return repos;
}
