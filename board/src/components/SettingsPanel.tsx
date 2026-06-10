import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { patchConfig } from '../api';
import type { ConfigDto, ConfigPatchDto } from '../types';
import { EFFORT_OPTIONS, MODEL_OPTIONS } from '../lib';
import { SlideOver } from './SlideOver';

// ---------------------------------------------------------------------------
// Draft model: numbers held as strings so typing/clearing never fights the user;
// validated on blur (range) and on save (everything).
// ---------------------------------------------------------------------------

interface Draft {
  weeklyEnabled: boolean;
  burnWindowHours: string;
  stopAtPct: string;
  burstEnabled: boolean;
  triggerMinutesBeforeReset: string;
  weeklyGuardPct: string;
  reserveWeeklyPct: string;
  reserveFiveHourPct: string;
  watchdogIntervalMinutes: string;
  fiveHourPausePct: string;
  maxConcurrent: string;
  maxAttempts: string;
  taskTimeoutMinutes: string;
  maxTurnsHint: string;
  claudeModel: string;
  claudeEffort: string;
  codexEnabled: boolean;
  codexModel: string;
  codexEffort: string;
  codexWeeklyResetFallback: string;
  judgeModel: string;
  judgePassScore: string;
}

type NumKey =
  | 'burnWindowHours'
  | 'stopAtPct'
  | 'triggerMinutesBeforeReset'
  | 'weeklyGuardPct'
  | 'reserveWeeklyPct'
  | 'reserveFiveHourPct'
  | 'watchdogIntervalMinutes'
  | 'fiveHourPausePct'
  | 'maxConcurrent'
  | 'maxAttempts'
  | 'taskTimeoutMinutes'
  | 'maxTurnsHint'
  | 'judgePassScore';

const RULES: Record<NumKey, { min: number; max: number }> = {
  burnWindowHours: { min: 1, max: 168 },
  stopAtPct: { min: 0, max: 100 },
  triggerMinutesBeforeReset: { min: 1, max: 300 },
  weeklyGuardPct: { min: 0, max: 100 },
  reserveWeeklyPct: { min: 0, max: 100 },
  reserveFiveHourPct: { min: 0, max: 100 },
  watchdogIntervalMinutes: { min: 1, max: 120 },
  fiveHourPausePct: { min: 0, max: 100 },
  maxConcurrent: { min: 1, max: 8 },
  maxAttempts: { min: 1, max: 10 },
  taskTimeoutMinutes: { min: 5, max: 600 },
  maxTurnsHint: { min: 1, max: 200 },
  judgePassScore: { min: 1, max: 5 },
};

function fromConfig(c: ConfigDto): Draft {
  return {
    weeklyEnabled: c.modes.weeklySurplus.enabled,
    burnWindowHours: String(c.modes.weeklySurplus.burnWindowHours),
    stopAtPct: String(c.modes.weeklySurplus.stopAtPct),
    burstEnabled: c.modes.fiveHourBurst.enabled,
    triggerMinutesBeforeReset: String(c.modes.fiveHourBurst.triggerMinutesBeforeReset),
    weeklyGuardPct: String(c.modes.fiveHourBurst.weeklyGuardPct),
    reserveWeeklyPct: String(c.reserve.weeklyPct),
    reserveFiveHourPct: String(c.reserve.fiveHourPct),
    watchdogIntervalMinutes: String(c.reserve.watchdogIntervalMinutes),
    fiveHourPausePct: String(c.pacing.fiveHourPausePct),
    maxConcurrent: String(c.dispatcher.maxConcurrent),
    maxAttempts: String(c.dispatcher.maxAttempts),
    taskTimeoutMinutes: String(c.dispatcher.taskTimeoutMinutes),
    maxTurnsHint: String(c.dispatcher.maxTurnsHint),
    claudeModel: c.providers.claude.defaults.model,
    claudeEffort: c.providers.claude.defaults.effort,
    codexEnabled: c.providers.codex.enabled,
    codexModel: c.providers.codex.defaults.model,
    codexEffort: c.providers.codex.defaults.effort,
    codexWeeklyResetFallback: c.providers.codex.weeklyResetFallback ?? '',
    judgeModel: c.judge.model,
    judgePassScore: String(c.judgePassScore),
  };
}

function validateNum(key: NumKey, raw: string): string | null {
  const { min, max } = RULES[key];
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(n)) return 'Enter a whole number';
  if (n < min || n > max) return `Must be ${min}–${max}`;
  return null;
}

function buildPatch(d: Draft): ConfigPatchDto {
  return {
    modes: {
      weeklySurplus: {
        enabled: d.weeklyEnabled,
        burnWindowHours: Number(d.burnWindowHours),
        stopAtPct: Number(d.stopAtPct),
      },
      fiveHourBurst: {
        enabled: d.burstEnabled,
        triggerMinutesBeforeReset: Number(d.triggerMinutesBeforeReset),
        weeklyGuardPct: Number(d.weeklyGuardPct),
      },
    },
    reserve: {
      weeklyPct: Number(d.reserveWeeklyPct),
      fiveHourPct: Number(d.reserveFiveHourPct),
      watchdogIntervalMinutes: Number(d.watchdogIntervalMinutes),
    },
    pacing: { fiveHourPausePct: Number(d.fiveHourPausePct) },
    dispatcher: {
      maxConcurrent: Number(d.maxConcurrent),
      maxAttempts: Number(d.maxAttempts),
      taskTimeoutMinutes: Number(d.taskTimeoutMinutes),
      maxTurnsHint: Number(d.maxTurnsHint),
    },
    providers: {
      claude: { defaults: { model: d.claudeModel, effort: d.claudeEffort } },
      codex: {
        enabled: d.codexEnabled,
        defaults: { model: d.codexModel, effort: d.codexEffort },
        weeklyResetFallback: d.codexWeeklyResetFallback.trim() || null,
      },
    },
    judge: { model: d.judgeModel },
    judgePassScore: Number(d.judgePassScore),
  };
}

// ---------------------------------------------------------------------------
// Field primitives (playbook §7: labels above, helper text below, inline errors)
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-faint">{title}</h3>
      {children}
    </section>
  );
}

function Toggle({
  id,
  label,
  help,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {help && <p className="max-w-xs text-xs leading-relaxed text-faint">{help}</p>}
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="toggle-track"
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  );
}

function NumField({
  id,
  label,
  unit,
  help,
  value,
  error,
  min,
  max,
  onChange,
  onBlur,
}: {
  id: string;
  label: string;
  unit: string;
  help?: string;
  value: string;
  error: string | null | undefined;
  min: number;
  max: number;
  onChange: (v: string) => void;
  onBlur: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : help ? `${id}-help` : undefined}
          className="field-input w-28"
        />
        <span className="text-xs text-faint">{unit}</span>
      </div>
      {help && !error && (
        <p id={`${id}-help`} className="max-w-xs text-xs leading-relaxed text-faint">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function SelectField({
  id,
  label,
  help,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  help?: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  // Preserve a custom (hand-edited config) value even if it's not in the list.
  const opts = options.includes(value) ? options : [value, ...options];
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={help ? `${id}-help` : undefined}
        className="field-input w-full max-w-80"
      >
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {help && (
        <p id={`${id}-help`} className="max-w-xs text-xs leading-relaxed text-faint">
          {help}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function SettingsPanel({
  config,
  onClose,
  onSaved,
}: {
  config: ConfigDto;
  onClose: () => void;
  onSaved: (cfg: ConfigDto) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => fromConfig(config));
  const [errors, setErrors] = useState<Partial<Record<NumKey, string | null>>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [apiErr, setApiErr] = useState<string | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  };
  const blurCheck = (key: NumKey) => {
    setErrors((e) => ({ ...e, [key]: validateNum(key, draft[key]) }));
  };
  const hasErrors = useMemo(() => Object.values(errors).some(Boolean), [errors]);

  const num = (key: NumKey, label: string, unit: string, help?: string) => (
    <NumField
      id={`set-${key}`}
      label={label}
      unit={unit}
      help={help}
      value={draft[key]}
      error={errors[key]}
      min={RULES[key].min}
      max={RULES[key].max}
      onChange={(v) => set(key, v)}
      onBlur={() => blurCheck(key)}
    />
  );

  const save = async () => {
    const all: Partial<Record<NumKey, string | null>> = {};
    for (const key of Object.keys(RULES) as NumKey[]) {
      all[key] = validateNum(key, draft[key]);
    }
    setErrors(all);
    if (Object.values(all).some(Boolean)) return;
    setBusy(true);
    setApiErr(null);
    try {
      const effective = await patchConfig(buildPatch(draft));
      onSaved(effective);
      setSaved(true);
    } catch (e) {
      setApiErr(e instanceof Error ? e.message : 'save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SlideOver label="Settings" onClose={onClose} widthClass="w-lg">
      {(close) => (
        <>
          <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-4">
            <h2 className="text-base font-semibold text-ink">Settings</h2>
            <button
              onClick={close}
              aria-label="Close settings"
              className="rounded-chip px-2 py-1 text-dim transition-colors duration-150 hover:bg-overlay hover:text-ink"
            >
              ✕
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-8 px-6 py-6">
            <Section title="Burn modes">
              <Toggle
                id="set-weeklyEnabled"
                label="Weekly surplus"
                help="Burn leftover weekly quota in the hours before the 7-day reset."
                checked={draft.weeklyEnabled}
                onChange={(v) => set('weeklyEnabled', v)}
              />
              <div className="grid grid-cols-2 gap-4">
                {num('burnWindowHours', 'Burn window', 'h', 'Enter burn mode this many hours before the weekly reset.')}
                {num('stopAtPct', 'Stop at', '%', 'Stop burning when 7-day utilization reaches this.')}
              </div>
              <Toggle
                id="set-burstEnabled"
                label="5-hour burst"
                help="Squeeze the tail of each 5-hour window when it would otherwise expire unused."
                checked={draft.burstEnabled}
                onChange={(v) => set('burstEnabled', v)}
              />
              <div className="grid grid-cols-2 gap-4">
                {num('triggerMinutesBeforeReset', 'Trigger before reset', 'min')}
                {num('weeklyGuardPct', 'Weekly guard', '%', 'Never burst once 7-day utilization is at or above this.')}
              </div>
            </Section>

            <Section title="Reserve">
              <p className="-mt-2 max-w-sm text-xs leading-relaxed text-dim">
                Quota kept for your other agents on the same subscriptions — surplus never
                touches it, and a mid-run watchdog aborts a worker that crosses a ceiling.
              </p>
              <div className="grid grid-cols-2 gap-4">
                {num('reserveWeeklyPct', 'Weekly reserve', '%', 'Of the 7-day window, always left untouched.')}
                {num('reserveFiveHourPct', '5-hour reserve', '%', 'Of each 5-hour window, always left untouched.')}
              </div>
              {num('watchdogIntervalMinutes', 'Watchdog interval', 'min', 'How often a running task re-checks usage against the ceilings.')}
            </Section>

            <Section title="Pacing">
              {num('fiveHourPausePct', '5-hour pause at', '%', 'Between launches, wait for the 5-hour reset once utilization hits this.')}
            </Section>

            <Section title="Dispatcher">
              <div className="grid grid-cols-2 gap-4">
                {num('maxConcurrent', 'Max concurrent', 'tasks')}
                {num('maxAttempts', 'Max attempts', 'tries', 'Failed attempts before a task is auto-blocked.')}
                {num('taskTimeoutMinutes', 'Task timeout', 'min', 'Hard wall-clock cap per run.')}
                {num('maxTurnsHint', 'Turn hint', 'turns', 'Suggested turn bound embedded in the goal condition.')}
              </div>
            </Section>

            <Section title="Providers">
              <div className="flex flex-col gap-3 rounded-card bg-overlay p-4">
                <span className="text-xs font-semibold uppercase tracking-[0.15em] text-ember">
                  claude
                </span>
                <div className="grid grid-cols-2 gap-4">
                  <SelectField
                    id="set-claudeModel"
                    label="Default model"
                    value={draft.claudeModel}
                    options={MODEL_OPTIONS.claude}
                    onChange={(v) => set('claudeModel', v)}
                  />
                  <SelectField
                    id="set-claudeEffort"
                    label="Default effort"
                    value={draft.claudeEffort}
                    options={EFFORT_OPTIONS}
                    onChange={(v) => set('claudeEffort', v)}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-3 rounded-card bg-overlay p-4">
                <span className="text-xs font-semibold uppercase tracking-[0.15em] text-jade">
                  codex
                </span>
                <Toggle
                  id="set-codexEnabled"
                  label="Enabled"
                  help="Usage probing and dispatch start on the next surplus restart."
                  checked={draft.codexEnabled}
                  onChange={(v) => set('codexEnabled', v)}
                />
                <div className="grid grid-cols-2 gap-4">
                  <SelectField
                    id="set-codexModel"
                    label="Default model"
                    value={draft.codexModel}
                    options={MODEL_OPTIONS.codex}
                    onChange={(v) => set('codexModel', v)}
                  />
                  <SelectField
                    id="set-codexEffort"
                    label="Default effort"
                    value={draft.codexEffort}
                    options={EFFORT_OPTIONS}
                    onChange={(v) => set('codexEffort', v)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="set-codexFallback" className="text-sm font-medium text-ink">
                    Weekly reset fallback
                  </label>
                  <input
                    id="set-codexFallback"
                    type="text"
                    value={draft.codexWeeklyResetFallback}
                    onChange={(e) => set('codexWeeklyResetFallback', e.target.value)}
                    placeholder="Thu 21:00"
                    aria-describedby="set-codexFallback-help"
                    className="field-input w-full max-w-80"
                  />
                  <p id="set-codexFallback-help" className="max-w-xs text-xs leading-relaxed text-faint">
                    Known weekly reset when live usage isn't discoverable from the codex CLI.
                    Leave empty to clear.
                  </p>
                </div>
              </div>
            </Section>

            <Section title="Judge">
              <div className="grid grid-cols-2 gap-4">
                <SelectField
                  id="set-judgeModel"
                  label="Judge model"
                  help="Always runs on claude; cheap models judge fine."
                  value={draft.judgeModel}
                  options={MODEL_OPTIONS.claude}
                  onChange={(v) => set('judgeModel', v)}
                />
                {num('judgePassScore', 'Pass score', '/ 5', 'Judge score at or above which a run counts as done.')}
              </div>
            </Section>
          </div>

          <div className="sticky bottom-0 mt-auto flex items-center gap-3 border-t border-line bg-raised px-6 py-4">
            <button
              onClick={() => void save()}
              disabled={busy || hasErrors}
              className="rounded-chip bg-ember/20 px-4 py-1.5 text-sm font-semibold text-ember transition-colors duration-150 hover:bg-ember/30 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            <span
              aria-live="polite"
              className={`text-xs text-jade transition-opacity duration-300 ${saved ? 'opacity-100' : 'opacity-0'}`}
            >
              Saved
            </span>
            {apiErr && (
              <p role="alert" className="text-xs text-danger">
                {apiErr}
              </p>
            )}
          </div>
        </>
      )}
    </SlideOver>
  );
}
