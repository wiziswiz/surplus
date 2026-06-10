/**
 * decide.ts — the pure decision engine.
 *
 * decide() is called once per enabled provider with that provider's usage
 * snapshot. It is PURE: it never reads the system clock or the filesystem —
 * all inputs (including `now`) arrive via DecideInput.
 *
 * Priority order (first match wins):
 *   1. paused              → stop
 *   2. usage unavailable   → stop (never burn blind)
 *   3. weeklySurplus mode  → stop / pace-wait / burn
 *   4. fiveHourBurst mode  → burn
 *   5. idle (with a sensible nextCheckAt)
 */

import type { DecideInput, Decision } from './types.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Fallback poll interval when no concrete trigger time is known. */
const FALLBACK_POLL_MS = 30 * MINUTE_MS;

/** Defensively clamp a percentage into [0, 100]; null/NaN stay null. */
function clampPct(pct: number | null): number | null {
  if (pct == null || Number.isNaN(pct)) return null;
  return Math.min(100, Math.max(0, pct));
}

/** "5h 30m" / "12m" style duration for human-readable reasons. */
function fmtDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / MINUTE_MS));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function decide(input: DecideInput): Decision {
  const { usage, config, now, paused } = input;

  // 1. Kill switch beats everything (including unavailable usage).
  if (paused) {
    return { action: 'stop', reason: 'paused via kill switch' };
  }

  // 2. Never burn blind: an unusable snapshot is a hard stop.
  if (usage.unavailable) {
    return {
      action: 'stop',
      reason: `usage unavailable (${usage.error ?? 'unknown'}) — never burn blind`,
      nextCheckAt: now + FALLBACK_POLL_MS,
    };
  }

  const fiveHourPct = clampPct(usage.fiveHourPct);
  const sevenDayPct = clampPct(usage.sevenDayPct);
  const fiveHourResetMs = usage.fiveHourResetsAt?.getTime() ?? null;
  const sevenDayResetMs = usage.sevenDayResetsAt?.getTime() ?? null;

  const weekly = config.modes.weeklySurplus;
  const burst = config.modes.fiveHourBurst;

  // Reserve floors: quota protected for OTHER agents sharing the same
  // subscription (OpenClaw/Hermes crons, interactive use). The effective
  // ceilings are the stricter of the mode target and the reserve floor.
  const reserve = config.reserve;
  const effWeeklyStopPct = Math.min(weekly.stopAtPct, 100 - reserve.weeklyPct);
  const effFiveHourPausePct = Math.min(config.pacing.fiveHourPausePct, 100 - reserve.fiveHourPct);

  // 3. weeklySurplus: burn leftover weekly quota in the window before the
  //    7-day reset. Wins over fiveHourBurst when both are eligible.
  if (weekly.enabled && sevenDayResetMs != null) {
    if (sevenDayResetMs <= now) {
      // A 7-day reset in the past means the snapshot no longer describes the
      // current window — treat the window as unknown and stop.
      return {
        action: 'stop',
        reason: `stale snapshot: 7-day reset (${usage.sevenDayResetsAt!.toISOString()}) is in the past`,
        nextCheckAt: now + FALLBACK_POLL_MS,
      };
    }

    const windowStartMs = sevenDayResetMs - weekly.burnWindowHours * HOUR_MS;
    if (now >= windowStartMs) {
      // Inside the burn window (boundary inclusive: now === windowStart burns).
      //
      // codex weeklyResetFallback world: when live usage isn't discoverable,
      // sevenDayResetsAt is synthesized from config while sevenDayPct stays
      // null. We cannot see utilization, so treat null as 0 and let the time
      // gate alone govern the burn. (Contrast with fiveHourBurst below, where
      // null pcts conservatively DISABLE the burst.)
      const effSevenDayPct = sevenDayPct ?? 0;

      if (effSevenDayPct >= effWeeklyStopPct) {
        // Exactly at the ceiling counts as hit — no burn.
        const why =
          effWeeklyStopPct < weekly.stopAtPct
            ? `reserve floor (${reserve.weeklyPct}% kept for other agents)`
            : `stop target ${weekly.stopAtPct}%`;
        return {
          action: 'stop',
          reason: `weekly ceiling hit: 7-day window at ${effSevenDayPct}% (${why})`,
          nextCheckAt: sevenDayResetMs,
        };
      }

      if (fiveHourPct != null && fiveHourPct >= effFiveHourPausePct) {
        return {
          action: 'pace-wait',
          reason:
            `5h window hot (${fiveHourPct}% >= ${effFiveHourPausePct}%` +
            (effFiveHourPausePct < config.pacing.fiveHourPausePct
              ? `, ${reserve.fiveHourPct}% reserved for other agents`
              : '') +
            `); waiting for 5h reset before burning weekly surplus`,
          nextCheckAt: fiveHourResetMs ?? now + FALLBACK_POLL_MS,
        };
      }

      const pacingNote =
        fiveHourPct == null ? '; 5h pacing unavailable (no 5h data)' : '';
      return {
        action: 'burn',
        mode: 'weeklySurplus',
        reason:
          `weekly surplus: ${100 - effSevenDayPct}% of weekly quota remaining ` +
          `(used ${effSevenDayPct}%, stop at ${effWeeklyStopPct}%), ` +
          `7-day reset in ${fmtDuration(sevenDayResetMs - now)}${pacingNote}`,
      };
    }
  }

  // 4. fiveHourBurst: burn the tail of the 5h window. Conservative by design —
  //    a null fiveHourPct or sevenDayPct DISABLES the burst (treated as 100,
  //    failing the < checks), unlike weeklySurplus which is time-gated and
  //    treats a null sevenDayPct as 0. A 5h reset in the past simply skips
  //    the mode (no stop): the burst gate is opportunistic, not load-bearing.
  if (burst.enabled && fiveHourResetMs != null && fiveHourResetMs > now) {
    const msLeft = fiveHourResetMs - now;
    const effBurstWeeklyGuardPct = Math.min(burst.weeklyGuardPct, 100 - reserve.weeklyPct);
    if (
      msLeft <= burst.triggerMinutesBeforeReset * MINUTE_MS &&
      (fiveHourPct ?? 100) < 100 - reserve.fiveHourPct &&
      (sevenDayPct ?? 100) < effBurstWeeklyGuardPct
    ) {
      return {
        action: 'burn',
        mode: 'fiveHourBurst',
        reason:
          `5h burst: ${fmtDuration(msLeft)} left in 5h window at ${fiveHourPct}%, ` +
          `weekly at ${sevenDayPct}% (guard ${burst.weeklyGuardPct}%)`,
      };
    }
  }

  // 5. Idle — explain the nearest future trigger and suggest when to re-poll.
  const candidates: Array<{ at: number; what: string }> = [];

  if (weekly.enabled && sevenDayResetMs != null && sevenDayResetMs > now) {
    const windowStartMs = sevenDayResetMs - weekly.burnWindowHours * HOUR_MS;
    if (windowStartMs > now) {
      candidates.push({
        at: windowStartMs,
        what: `weekly surplus window opens in ${fmtDuration(windowStartMs - now)}`,
      });
    }
  }

  if (burst.enabled && fiveHourResetMs != null && fiveHourResetMs > now) {
    const triggerAtMs = fiveHourResetMs - burst.triggerMinutesBeforeReset * MINUTE_MS;
    if (triggerAtMs > now) {
      candidates.push({
        at: triggerAtMs,
        what: `5h burst trigger in ${fmtDuration(triggerAtMs - now)}`,
      });
    } else {
      // Already inside the trigger zone but a guard blocked the burst —
      // nothing changes until the 5h window resets.
      candidates.push({
        at: fiveHourResetMs,
        what: `5h reset in ${fmtDuration(fiveHourResetMs - now)} (burst blocked by guard)`,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      action: 'idle',
      reason: 'no future burn trigger visible (modes disabled or reset times unknown)',
      nextCheckAt: now + FALLBACK_POLL_MS,
    };
  }

  candidates.sort((a, b) => a.at - b.at);
  const nearest = candidates[0]!;
  return {
    action: 'idle',
    reason: `idle: next trigger is ${nearest.what}`,
    nextCheckAt: nearest.at,
  };
}
