import { describe, expect, it } from 'vitest';
import { decide } from '../src/decide.js';
import { defaultConfig } from '../src/config.js';
import type { DecideInput, SurplusConfig, UsageSnapshot } from '../src/types.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Fixed fake clock — decide() must never read the real one. */
const NOW = Date.parse('2026-06-09T12:00:00.000Z');

function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider: 'claude',
    planName: 'Max',
    fiveHourPct: 50,
    sevenDayPct: 50,
    fiveHourResetsAt: new Date(NOW + 2 * HOUR_MS),
    // 6h to the weekly reset → inside the default 12h burn window.
    sevenDayResetsAt: new Date(NOW + 6 * HOUR_MS),
    unavailable: false,
    fetchedAt: NOW,
    ...over,
  };
}

function cfg(mutate?: (c: SurplusConfig) => void): SurplusConfig {
  const c = defaultConfig();
  mutate?.(c);
  return c;
}

function run(
  usageOver: Partial<UsageSnapshot> = {},
  mutateCfg?: (c: SurplusConfig) => void,
  extra: Partial<Pick<DecideInput, 'paused' | 'now'>> = {},
) {
  return decide({
    usage: snap(usageOver),
    config: cfg(mutateCfg),
    now: extra.now ?? NOW,
    paused: extra.paused ?? false,
  });
}

describe('decide: kill switch & unavailable usage', () => {
  it('paused → stop, even when a burn would otherwise fire', () => {
    const d = run({}, undefined, { paused: true });
    expect(d.action).toBe('stop');
    expect(d.reason).toContain('paused via kill switch');
    expect(d.mode).toBeUndefined();
  });

  it('paused wins over unavailable usage', () => {
    const d = run({ unavailable: true, error: 'network' }, undefined, { paused: true });
    expect(d.action).toBe('stop');
    expect(d.reason).toContain('paused via kill switch');
  });

  it('unavailable → stop with the error tag in the reason', () => {
    const d = run({ unavailable: true, error: 'http-401' });
    expect(d.action).toBe('stop');
    expect(d.reason).toContain('http-401');
  });

  it('unavailable without an error tag → stop with "unknown"', () => {
    const d = run({ unavailable: true });
    expect(d.action).toBe('stop');
    expect(d.reason).toContain('unknown');
  });
});

describe('decide: weeklySurplus mode', () => {
  it('burns inside the window when below stopAtPct', () => {
    const d = run({ sevenDayPct: 42 });
    expect(d.action).toBe('burn');
    expect(d.mode).toBe('weeklySurplus');
    // Reason includes remaining % and time to reset.
    expect(d.reason).toContain('58%');
    expect(d.reason).toContain('6h 0m');
  });

  it('burns exactly at the window boundary (now === resetsAt - burnWindowHours)', () => {
    const d = run({ sevenDayResetsAt: new Date(NOW + 12 * HOUR_MS) });
    expect(d.action).toBe('burn');
    expect(d.mode).toBe('weeklySurplus');
  });

  it('idles just before the window opens, nextCheckAt = window start', () => {
    const resetsAt = NOW + 12 * HOUR_MS + 1;
    const d = run({ sevenDayResetsAt: new Date(resetsAt) });
    expect(d.action).toBe('idle');
    expect(d.nextCheckAt).toBe(resetsAt - 12 * HOUR_MS);
  });

  it('pct exactly at stopAtPct → no burn (stop, weekly target hit)', () => {
    const d = run({ sevenDayPct: 95 });
    expect(d.action).toBe('stop');
    expect(d.reason).toContain('95%');
    expect(d.nextCheckAt).toBe(NOW + 6 * HOUR_MS);
  });

  it('pct above stopAtPct → stop', () => {
    const d = run({ sevenDayPct: 97 });
    expect(d.action).toBe('stop');
  });

  it('pace-waits when 5h window is hot, nextCheckAt = 5h reset', () => {
    const d = run({ fiveHourPct: 92 });
    expect(d.action).toBe('pace-wait');
    expect(d.nextCheckAt).toBe(NOW + 2 * HOUR_MS);
  });

  it('pace-wait boundary: fiveHourPct exactly at fiveHourPausePct paces', () => {
    const d = run({ fiveHourPct: 90 });
    expect(d.action).toBe('pace-wait');
  });

  it('pace-wait with null fiveHourResetsAt → nextCheckAt = now + 30min', () => {
    const d = run({ fiveHourPct: 92, fiveHourResetsAt: null });
    expect(d.action).toBe('pace-wait');
    expect(d.nextCheckAt).toBe(NOW + 30 * MINUTE_MS);
  });

  it('still burns when fiveHourPct is null, noting pacing unavailable', () => {
    const d = run({ fiveHourPct: null });
    expect(d.action).toBe('burn');
    expect(d.mode).toBe('weeklySurplus');
    expect(d.reason).toContain('pacing unavailable');
  });

  it('codex weeklyResetFallback world: null sevenDayPct treated as 0 → time-gated burn', () => {
    const d = run({
      provider: 'codex',
      sevenDayPct: null,
      fiveHourPct: null,
      fiveHourResetsAt: null,
    });
    expect(d.action).toBe('burn');
    expect(d.mode).toBe('weeklySurplus');
  });

  it('7-day reset in the past → stop with "stale snapshot"', () => {
    const d = run({ sevenDayResetsAt: new Date(NOW - 1) });
    expect(d.action).toBe('stop');
    expect(d.reason).toContain('stale snapshot');
  });

  it('mode disabled → no weekly burn even deep inside the window', () => {
    const d = run({}, (c) => {
      c.modes.weeklySurplus.enabled = false;
    });
    expect(d.action).not.toBe('burn');
  });

  it('unknown sevenDayResetsAt → weekly path skipped (idle, not stop)', () => {
    const d = run({ sevenDayResetsAt: null });
    expect(d.action).toBe('idle');
  });

  it('clamps out-of-range sevenDayPct: 150 → 100 → stop (target hit)', () => {
    const d = run({ sevenDayPct: 150 });
    expect(d.action).toBe('stop');
    expect(d.reason).toContain('100%');
  });

  it('clamps negative fiveHourPct to 0 → burns without pacing', () => {
    const d = run({ fiveHourPct: -5 });
    expect(d.action).toBe('burn');
  });
});

describe('decide: fiveHourBurst mode', () => {
  /** Weekly disabled, burst enabled, 20m left in the 5h window. */
  const burstCfg = (c: SurplusConfig) => {
    c.modes.weeklySurplus.enabled = false;
    c.modes.fiveHourBurst.enabled = true;
  };
  const burstSnap: Partial<UsageSnapshot> = {
    fiveHourResetsAt: new Date(NOW + 20 * MINUTE_MS),
    fiveHourPct: 60,
    sevenDayPct: 40,
  };

  it('burns inside the trigger zone with pcts under the guards', () => {
    const d = run(burstSnap, burstCfg);
    expect(d.action).toBe('burn');
    expect(d.mode).toBe('fiveHourBurst');
    expect(d.reason).toContain('20m');
  });

  it('disabled by default', () => {
    const d = run(burstSnap, (c) => {
      c.modes.weeklySurplus.enabled = false;
    });
    expect(d.action).toBe('idle');
  });

  it('does not fire outside the trigger zone', () => {
    const d = run({ ...burstSnap, fiveHourResetsAt: new Date(NOW + 31 * MINUTE_MS) }, burstCfg);
    expect(d.action).toBe('idle');
  });

  it('fires exactly at the trigger boundary (30m left)', () => {
    const d = run({ ...burstSnap, fiveHourResetsAt: new Date(NOW + 30 * MINUTE_MS) }, burstCfg);
    expect(d.action).toBe('burn');
    expect(d.mode).toBe('fiveHourBurst');
  });

  it('weekly guard: sevenDayPct exactly at weeklyGuardPct blocks the burst', () => {
    const d = run({ ...burstSnap, sevenDayPct: 70 }, burstCfg);
    expect(d.action).toBe('idle');
  });

  it('null sevenDayPct DISABLES the burst (conservative asymmetry vs weekly)', () => {
    const d = run({ ...burstSnap, sevenDayPct: null }, burstCfg);
    expect(d.action).toBe('idle');
  });

  it('null fiveHourPct DISABLES the burst', () => {
    const d = run({ ...burstSnap, fiveHourPct: null }, burstCfg);
    expect(d.action).toBe('idle');
  });

  it('fiveHourPct at 100 blocks the burst', () => {
    const d = run({ ...burstSnap, fiveHourPct: 100 }, burstCfg);
    expect(d.action).toBe('idle');
  });

  it('5h reset in the past → skip burst (idle), not stop', () => {
    const d = run(
      { ...burstSnap, fiveHourResetsAt: new Date(NOW - MINUTE_MS), sevenDayResetsAt: null },
      burstCfg,
    );
    expect(d.action).toBe('idle');
  });

  it('clamps out-of-range sevenDayPct: 150 → 100 → blocked by guard', () => {
    const d = run({ ...burstSnap, sevenDayPct: 150 }, burstCfg);
    expect(d.action).toBe('idle');
  });
});

describe('decide: mode priority & idle scheduling', () => {
  it('weeklySurplus wins when both modes are eligible', () => {
    const d = run(
      {
        sevenDayResetsAt: new Date(NOW + 6 * HOUR_MS),
        sevenDayPct: 40,
        fiveHourResetsAt: new Date(NOW + 20 * MINUTE_MS),
        fiveHourPct: 60,
      },
      (c) => {
        c.modes.fiveHourBurst.enabled = true;
      },
    );
    expect(d.action).toBe('burn');
    expect(d.mode).toBe('weeklySurplus');
  });

  it('idle nextCheckAt = min(weekly window start, 5h burst trigger)', () => {
    // Weekly window opens in 8h; burst trigger in 90m → burst trigger wins.
    const d = run(
      {
        sevenDayResetsAt: new Date(NOW + 20 * HOUR_MS),
        fiveHourResetsAt: new Date(NOW + 2 * HOUR_MS),
      },
      (c) => {
        c.modes.fiveHourBurst.enabled = true;
      },
    );
    expect(d.action).toBe('idle');
    expect(d.nextCheckAt).toBe(NOW + 90 * MINUTE_MS);
  });

  it('idle picks the weekly window start when it is nearer', () => {
    const d = run({
      sevenDayResetsAt: new Date(NOW + 13 * HOUR_MS),
      fiveHourResetsAt: new Date(NOW + 4 * HOUR_MS),
    });
    expect(d.action).toBe('idle');
    expect(d.nextCheckAt).toBe(NOW + 1 * HOUR_MS);
    expect(d.reason).toContain('weekly surplus window');
  });

  it('idle inside burst trigger zone but blocked → nextCheckAt = 5h reset', () => {
    const d = run(
      {
        sevenDayResetsAt: null,
        fiveHourResetsAt: new Date(NOW + 10 * MINUTE_MS),
        fiveHourPct: 100, // blocks the burst
        sevenDayPct: 40,
      },
      (c) => {
        c.modes.weeklySurplus.enabled = false;
        c.modes.fiveHourBurst.enabled = true;
      },
    );
    expect(d.action).toBe('idle');
    expect(d.nextCheckAt).toBe(NOW + 10 * MINUTE_MS);
  });

  it('idle with no visible triggers → fallback poll in 30min', () => {
    const d = run({ sevenDayResetsAt: null, fiveHourResetsAt: null });
    expect(d.action).toBe('idle');
    expect(d.nextCheckAt).toBe(NOW + 30 * MINUTE_MS);
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it('is pure: identical inputs give identical decisions regardless of wall clock', () => {
    const input: DecideInput = { usage: snap(), config: cfg(), now: NOW, paused: false };
    const a = decide(input);
    const b = decide(input);
    expect(b).toEqual(a);
  });
});
