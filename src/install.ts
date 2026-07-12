/**
 * surplus — launchd agent + Dock-app install/uninstall.
 *
 * Three installable pieces:
 *  - com.surplus.tick.plist  — runs `surplus tick` every StartInterval seconds
 *  - com.surplus.board.plist — keeps `surplus board` alive (always-on dashboard)
 *  - /Applications/Surplus.app — thin shell that opens the dashboard from
 *    Dock/Spotlight (Hermes-Mini pattern: a bash launcher, no framework)
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOGS_DIR, SURPLUS_DIR_NAME } from './types.js';

export const LAUNCHD_LABEL = 'com.surplus.tick';
export const BOARD_LAUNCHD_LABEL = 'com.surplus.board';

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

/**
 * PATH for the launchd services. launchd's default PATH is only
 * `/usr/bin:/bin:/usr/sbin:/sbin`, which omits Homebrew (`/opt/homebrew/bin`),
 * `/usr/local/bin`, `~/.local/bin`, etc. — so a service can't find the `claude`
 * or `codex` CLIs it must spawn for usage probing AND task execution. Bake the
 * install-time PATH (the user's shell, where the CLIs live) plus the common CLI
 * locations into the plist so the services can actually run the tools.
 */
export function launchdPath(env: NodeJS.ProcessEnv = process.env): string {
  const seen = new Set<string>();
  const dirs: string[] = [];
  const add = (d: string): void => {
    if (d && !seen.has(d)) {
      seen.add(d);
      dirs.push(d);
    }
  };
  for (const d of (env.PATH ?? '').split(':')) add(d);
  for (const d of [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]) {
    add(d);
  }
  return dirs.join(':');
}

/** Pure plist renderer (exported for tests). */
export function renderPlist(args: {
  nodePath: string;
  scriptPath: string;
  intervalSeconds: number;
  logPath: string;
  path: string;
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
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(args.path)}</string>
  </dict>
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
      path: launchdPath(),
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

// ---------------------------------------------------------------------------
// Always-on board service (launchd KeepAlive)
// ---------------------------------------------------------------------------

/** Absolute path of the board-service plist. */
export function boardPlistPath(): string {
  return join(launchAgentsDir(), `${BOARD_LAUNCHD_LABEL}.plist`);
}

/** Pure plist renderer for the KeepAlive board service (exported for tests). */
export function renderBoardPlist(args: {
  nodePath: string;
  scriptPath: string;
  port: number;
  logPath: string;
  path: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(BOARD_LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(args.nodePath)}</string>
    <string>${escapeXml(args.scriptPath)}</string>
    <string>board</string>
    <string>--port</string>
    <string>${args.port}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(args.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(args.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(args.logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Install the always-on board service. launchd starts it at login and
 * restarts it if it ever dies — the dashboard is permanently reachable.
 * @returns absolute path of the written plist.
 */
export function installBoardLaunchd(opts: { port: number }): string {
  if (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535) {
    throw new Error(`invalid board port: ${opts.port}`);
  }
  const logPath = join(homedir(), SURPLUS_DIR_NAME, LOGS_DIR, 'board-launchd.log');
  mkdirSync(dirname(logPath), { recursive: true });
  mkdirSync(launchAgentsDir(), { recursive: true });

  const target = boardPlistPath();
  writeFileSync(
    target,
    renderBoardPlist({
      nodePath: process.execPath,
      scriptPath: surplusBinPath(),
      port: opts.port,
      logPath,
      path: launchdPath(),
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

/** Unload and remove the board-service plist. */
export function uninstallBoardLaunchd(): boolean {
  const target = boardPlistPath();
  const existed = existsSync(target);
  try {
    execFileSync('launchctl', ['unload', target], { stdio: 'ignore' });
  } catch {
    /* never loaded — fine */
  }
  if (existed) rmSync(target, { force: true });
  return existed;
}

// ---------------------------------------------------------------------------
// Dock app — thin /Applications/Surplus.app shell (Hermes-Mini pattern)
// ---------------------------------------------------------------------------

/** Default install location; overridable for tests. */
export function dockAppPath(applicationsDir = '/Applications'): string {
  return join(applicationsDir, 'Surplus.app');
}

/** Pure Info.plist renderer for the Dock app (exported for tests). */
export function renderDockAppInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Surplus</string>
  <key>CFBundleDisplayName</key>
  <string>Surplus</string>
  <key>CFBundleIdentifier</key>
  <string>com.surplus.dock</string>
  <key>CFBundleExecutable</key>
  <string>launch</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
</dict>
</plist>
`;
}

/**
 * Launcher script: nudge the board service awake (in case it was unloaded),
 * then open the dashboard in the default browser. No secrets embedded.
 */
export function renderDockAppLauncher(port: number): string {
  return `#!/bin/bash
launchctl kickstart "gui/$(id -u)/${BOARD_LAUNCHD_LABEL}" 2>/dev/null || true
exec open "http://localhost:${port}"
`;
}

/**
 * Write the thin .app bundle. Idempotent — rewrites in place on re-install.
 * @returns absolute path of the .app.
 */
export function installDockApp(opts: { port: number; applicationsDir?: string }): string {
  const app = dockAppPath(opts.applicationsDir);
  const macos = join(app, 'Contents', 'MacOS');
  mkdirSync(macos, { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), renderDockAppInfoPlist());
  const launcher = join(macos, 'launch');
  writeFileSync(launcher, renderDockAppLauncher(opts.port));
  chmodSync(launcher, 0o755);
  return app;
}

/** Remove the Dock app. */
export function uninstallDockApp(applicationsDir?: string): boolean {
  const app = dockAppPath(applicationsDir);
  const existed = existsSync(app);
  if (existed) rmSync(app, { recursive: true, force: true });
  return existed;
}
