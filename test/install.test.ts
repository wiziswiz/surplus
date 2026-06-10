import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  tmpHome: '',
  execCalls: [] as Array<{ cmd: string; args: readonly string[] }>,
  failUnload: false,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const execFileSync = ((cmd: string, args: readonly string[]) => {
    h.execCalls.push({ cmd, args });
    if (h.failUnload && args[0] === 'unload') throw new Error('launchctl: Could not find specified service');
    return Buffer.from('');
  }) as unknown as typeof real.execFileSync;
  return { ...real, execFileSync, default: { ...real, execFileSync } };
});

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  const homedir = () => h.tmpHome;
  return { ...real, homedir, default: { ...real, homedir } };
});

import { tmpdir } from 'node:os'; // real tmpdir (mock spreads the actual module)
import {
  LAUNCHD_LABEL,
  installLaunchd,
  launchdPlistPath,
  renderPlist,
  uninstallLaunchd,
} from '../src/install.js';

beforeAll(() => {
  h.tmpHome = mkdtempSync(join(tmpdir(), 'surplus-install-test-'));
});

afterAll(() => {
  if (h.tmpHome) rmSync(h.tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  h.execCalls = [];
  h.failUnload = false;
});

describe('renderPlist', () => {
  it('renders label, interval, RunAtLoad false, program arguments and log paths', () => {
    const xml = renderPlist({
      nodePath: '/usr/local/bin/node',
      scriptPath: '/repo/bin/surplus.js',
      intervalSeconds: 900,
      logPath: '/home/u/.surplus/logs/launchd.log',
    });
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain('<integer>900</integer>');
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(xml).toContain('<string>/usr/local/bin/node</string>');
    expect(xml).toContain('<string>/repo/bin/surplus.js</string>');
    expect(xml).toContain('<string>tick</string>');
    // both stdout and stderr go to the same launchd.log
    expect(xml.match(/<string>\/home\/u\/\.surplus\/logs\/launchd\.log<\/string>/g)).toHaveLength(2);
  });

  it('escapes XML special characters in paths', () => {
    const xml = renderPlist({
      nodePath: '/odd & path/<node>',
      scriptPath: '/repo/bin/surplus.js',
      intervalSeconds: 60,
      logPath: '/tmp/a&b.log',
    });
    expect(xml).toContain('/odd &amp; path/&lt;node&gt;');
    expect(xml).toContain('/tmp/a&amp;b.log');
    expect(xml).not.toContain('& path');
  });
});

describe('installLaunchd', () => {
  it('writes the plist under ~/Library/LaunchAgents and loads it via launchctl', () => {
    const plistPath = installLaunchd();
    expect(plistPath).toBe(join(h.tmpHome, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`));
    expect(plistPath).toBe(launchdPlistPath());
    expect(existsSync(plistPath)).toBe(true);

    const xml = readFileSync(plistPath, 'utf8');
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain('<integer>900</integer>'); // default 15m
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(xml).toContain(`<string>${process.execPath}</string>`);
    expect(xml).toContain('/bin/surplus.js</string>');
    expect(xml).toContain('<string>tick</string>');
    expect(xml).toContain(join(h.tmpHome, '.surplus', 'logs', 'launchd.log'));

    // logs dir created lazily
    expect(existsSync(join(h.tmpHome, '.surplus', 'logs'))).toBe(true);

    // unload (ignore errors) then load, via array args — no shell
    expect(h.execCalls).toEqual([
      { cmd: 'launchctl', args: ['unload', plistPath] },
      { cmd: 'launchctl', args: ['load', plistPath] },
    ]);
  });

  it('honors a custom interval in minutes', () => {
    const plistPath = installLaunchd({ intervalMinutes: 5 });
    expect(readFileSync(plistPath, 'utf8')).toContain('<integer>300</integer>');
  });

  it('ignores launchctl unload failures (agent not loaded yet)', () => {
    h.failUnload = true;
    const plistPath = installLaunchd();
    expect(existsSync(plistPath)).toBe(true);
    expect(h.execCalls.at(-1)).toEqual({ cmd: 'launchctl', args: ['load', plistPath] });
  });

  it('rejects a non-positive interval', () => {
    expect(() => installLaunchd({ intervalMinutes: 0 })).toThrow(/invalid interval/);
    expect(() => installLaunchd({ intervalMinutes: -3 })).toThrow(/invalid interval/);
  });
});

describe('uninstallLaunchd', () => {
  it('unloads, removes the plist and reports whether it existed', () => {
    const plistPath = installLaunchd();
    h.execCalls = [];

    expect(uninstallLaunchd()).toBe(true);
    expect(existsSync(plistPath)).toBe(false);
    expect(h.execCalls).toEqual([{ cmd: 'launchctl', args: ['unload', plistPath] }]);

    // second call: nothing left to remove
    expect(uninstallLaunchd()).toBe(false);
  });

  it('returns false and ignores unload errors when nothing was installed', () => {
    h.failUnload = true;
    expect(uninstallLaunchd()).toBe(false);
  });
});
