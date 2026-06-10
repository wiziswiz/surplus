/**
 * surplus — launchd agent install/uninstall.
 *
 * Writes ~/Library/LaunchAgents/com.surplus.tick.plist which runs
 * `node <repo>/bin/surplus.js tick` every StartInterval seconds, logging to
 * ~/.surplus/logs/launchd.log.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOGS_DIR, SURPLUS_DIR_NAME } from './types.js';

export const LAUNCHD_LABEL = 'com.surplus.tick';

function launchAgentsDir(): string {
  return join(homedir(), 'Library', 'LaunchAgents');
}

/** Absolute path of the launchd plist surplus installs. */
export function launchdPlistPath(): string {
  return join(launchAgentsDir(), `${LAUNCHD_LABEL}.plist`);
}

/** Absolute path to bin/surplus.js, resolved relative to this module (dist/ or src/ → ../bin). */
function surplusBinPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'surplus.js');
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pure plist renderer (exported for tests). */
export function renderPlist(args: {
  nodePath: string;
  scriptPath: string;
  intervalSeconds: number;
  logPath: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(args.nodePath)}</string>
    <string>${escapeXml(args.scriptPath)}</string>
    <string>tick</string>
  </array>
  <key>StartInterval</key>
  <integer>${args.intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapeXml(args.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(args.logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Write the plist and (re)load it via launchctl.
 * @returns absolute path of the written plist.
 */
export function installLaunchd(opts?: { intervalMinutes?: number }): string {
  const minutes = opts?.intervalMinutes ?? 15;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`invalid interval: ${minutes} minutes (must be a positive number)`);
  }
  const intervalSeconds = Math.max(60, Math.round(minutes * 60));

  const logPath = join(homedir(), SURPLUS_DIR_NAME, LOGS_DIR, 'launchd.log');
  mkdirSync(dirname(logPath), { recursive: true });
  mkdirSync(launchAgentsDir(), { recursive: true });

  const target = launchdPlistPath();
  writeFileSync(
    target,
    renderPlist({
      nodePath: process.execPath,
      scriptPath: surplusBinPath(),
      intervalSeconds,
      logPath,
    }),
  );

  try {
    execFileSync('launchctl', ['unload', target], { stdio: 'ignore' });
  } catch {
    // not loaded yet — fine
  }
  execFileSync('launchctl', ['load', target], { stdio: 'ignore' });
  return target;
}

/**
 * Unload and remove the plist.
 * @returns true when a plist existed and was removed.
 */
export function uninstallLaunchd(): boolean {
  const target = launchdPlistPath();
  const existed = existsSync(target);
  try {
    execFileSync('launchctl', ['unload', target], { stdio: 'ignore' });
  } catch {
    // never loaded / launchctl unavailable — fine
  }
  if (existed) rmSync(target, { force: true });
  return existed;
}
