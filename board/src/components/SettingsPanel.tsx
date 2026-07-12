import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { getBoardService, getState, installBoardService, patchConfig } from '../api';
import type {
  BoardServiceDto,
  ClaudeAccountDto,
  ConfigDto,
  ConfigPatchDto,
  StateDto,
} from '../types';
import { EFFORT_SELECT_OPTIONS, MODEL_OPTIONS, codexModelOptions } from '../lib';
import { SlideOver } from './SlideOver';
import { InfoTip } from './InfoTip';

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
  /** Comma-separated representation of config.discovery.roots. */
  discoveryRoots: string;
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
    discoveryRoots: c.discovery.roots.join(', '),
  };
}

/** Parse the comma-separated roots draft; empty input falls back to the default. */
export function parseDiscoveryRoots(raw: string): string[] {
  const roots = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
  return roots.length > 0 ? roots : ['~/Projects'];
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
    discovery: { roots: parseDiscoveryRoots(d.discoveryRoots) },
  };
}

// ---------------------------------------------------------------------------
// Field primitives (playbook §7: labels above, helper text below, inline errors)
// ---------------------------------------------------------------------------

function Section({
  title,
  tip,
  children,
}: {
  title: string;
  /** Optional InfoTip rendered beside the section title. */
  tip?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.12em] text-faint">
        {title}
        {tip}
      </h3>
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
  labelTip,
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
  labelTip?: ReactNode;
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
      <span className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {labelTip}
      </span>
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

type SelectOption = string | { value: string; label: string };

function SelectField({
  id,
  label,
  labelTip,
  help,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  /** Optional InfoTip rendered beside the label. */
  labelTip?: ReactNode;
  help?: string;
  value: string;
  /** Accepts plain strings (value=label) OR {value,label} pairs. */
  options: SelectOption[];
  onChange: (v: string) => void;
}) {
  const normalized = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  // Preserve a custom (hand-edited config) value even if it's not in the list.
  const opts = normalized.some((o) => o.value === value)
    ? normalized
    : [{ value, label: value }, ...normalized];
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {labelTip}
      </span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={help ? `${id}-help` : undefined}
        className="field-input w-full max-w-80"
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
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
// Service: the always-on dashboard launchd agent (install-only — uninstalling
// the service that keeps this page alive is CLI-only by design). Hidden when
// the server reports available:false.
// ---------------------------------------------------------------------------

function ServiceSection() {
  const [service, setService] = useState<BoardServiceDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getBoardService()
      .then(setService)
      .catch(() => setService(null));
  }, []);

  if (!service?.available) return null;

  const install = async () => {
    setBusy(true);
    setErr(null);
    try {
      await installBoardService();
      setService(await getBoardService());
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'install failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Service">
      <div className="flex items-center gap-3" aria-live="polite">
        {service.installed ? (
          <p className="text-sm font-medium text-jade">Always-on dashboard: installed ✓</p>
        ) : (
          <button
            onClick={() => void install()}
            disabled={busy}
            className="rounded-chip bg-ember/20 px-3 py-1.5 text-xs font-semibold text-ember transition-colors duration-150 hover:bg-ember/30 disabled:opacity-50"
          >
            {busy ? 'Installing…' : 'Install'}
          </button>
        )}
      </div>
      <p className="-mt-2 max-w-xs text-xs leading-relaxed text-faint">
        Keeps this dashboard running at login and restarts it if it dies. Also installs the
        Dock app.
      </p>
      {err && (
        <p role="alert" className="text-xs text-danger">
          {err}
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Claude accounts — multiple subscriptions via Claude Code profile dirs
// (CLAUDE_CONFIG_DIR). surplus NEVER sees or stores tokens: each profile dir
// keeps its own Claude Code login, refreshed by Claude Code itself.
// ---------------------------------------------------------------------------

const ACCOUNT_ID_RE = /^[a-z0-9-]{1,24}$/;
const MAX_CLAUDE_ACCOUNTS = 6;

function defaultAccounts(): ClaudeAccountDto[] {
  return [{ id: 'main', label: 'personal', configDir: null, priority: null }];
}

/** AccountKey for a claude account id ('main' keeps the legacy key 'claude'). */
function accountKeyOf(id: string): string {
  return id === 'main' ? 'claude' : `claude:${id}`;
}

function loginCommand(id: string): string {
  return `CLAUDE_CONFIG_DIR=~/.surplus/profiles/${id} claude`;
}

function UsageIndicator({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${ok ? 'text-jade' : 'text-faint'}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-jade' : 'bg-line'}`}
      />
      {ok ? 'usage ok' : 'no usage'}
    </span>
  );
}

function AccountsSection({
  config,
  usage,
  onSaved,
}: {
  config: ConfigDto;
  /** Current /api/state usage map (keyed by AccountKey) for the ok/dead dots. */
  usage: StateDto['usage'];
  onSaved: (cfg: ConfigDto) => void;
}) {
  const [accounts, setAccounts] = useState<ClaudeAccountDto[]>(() => {
    const declared = config.providers.claude.accounts;
    return declared && declared.length > 0 ? declared : defaultAccounts();
  });
  const [prioDrafts, setPrioDrafts] = useState<Record<string, string>>({});
  const [prioErrs, setPrioErrs] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Add-account flow.
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [addErr, setAddErr] = useState<string | null>(null);
  const [addedId, setAddedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  const patchAccounts = async (next: ClaudeAccountDto[]): Promise<boolean> => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const effective = await patchConfig({ providers: { claude: { accounts: next } } });
      setAccounts(effective.providers.claude.accounts ?? next);
      onSaved(effective);
      setSaved(true);
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const prioValue = (a: ClaudeAccountDto): string =>
    prioDrafts[a.id] ?? (a.priority === null ? '' : String(a.priority));

  const commitPriority = (a: ClaudeAccountDto) => {
    const draft = prioDrafts[a.id];
    if (draft === undefined) return; // never touched
    const raw = draft.trim();
    let next: number | null = null;
    if (raw !== '') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 99) {
        setPrioErrs((e) => ({ ...e, [a.id]: 'Whole number 0–99, or blank for auto' }));
        return;
      }
      next = n;
    }
    setPrioErrs((e) => ({ ...e, [a.id]: null }));
    if (next === a.priority) return;
    void patchAccounts(accounts.map((x) => (x.id === a.id ? { ...x, priority: next } : x)));
  };

  const addAccount = async () => {
    const id = newId.trim();
    const label = newLabel.trim() || id;
    if (!ACCOUNT_ID_RE.test(id)) {
      setAddErr('Id must be 1–24 lowercase letters, digits or dashes');
      return;
    }
    if (id === 'main' || accounts.some((a) => a.id === id)) {
      setAddErr(`'${id}' is already taken`);
      return;
    }
    if (accounts.length >= MAX_CLAUDE_ACCOUNTS) {
      setAddErr(`At most ${MAX_CLAUDE_ACCOUNTS} accounts`);
      return;
    }
    if (label.length > 40) {
      setAddErr('Label must be at most 40 characters');
      return;
    }
    setAddErr(null);
    const entry: ClaudeAccountDto = {
      id,
      label,
      configDir: `~/.surplus/profiles/${id}`,
      priority: null,
    };
    if (await patchAccounts([...accounts, entry])) {
      setAddedId(id);
      setNewId('');
      setNewLabel('');
      setCopied(false);
      setCheckResult(null);
    }
  };

  const checkConnection = async (id: string) => {
    setChecking(true);
    setCheckResult(null);
    try {
      const s = await getState(true);
      const snap = s.usage[accountKeyOf(id)];
      if (snap && !snap.unavailable) {
        setCheckResult(
          `connected — ${snap.planName ?? 'plan unknown'} · 7d at ${snap.sevenDayPct ?? '—'}%`,
        );
      } else {
        setCheckResult('not logged in yet');
      }
    } catch {
      setCheckResult('could not reach surplus');
    } finally {
      setChecking(false);
    }
  };

  return (
    <Section title="Claude accounts">
      <p className="-mt-2 max-w-sm text-xs leading-relaxed text-dim">
        Burn surplus from more than one Claude subscription. Each extra account lives in its
        own Claude Code profile folder — surplus never sees or stores your tokens.
      </p>

      <ul className="flex flex-col gap-2">
        {accounts.map((a) => {
          const snap = usage[accountKeyOf(a.id)];
          const ok = Boolean(snap && !snap.unavailable);
          return (
            <li key={a.id} className="flex flex-col gap-1 rounded-card bg-overlay p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink">{a.label}</span>
                <code className="rounded-chip bg-raised px-1.5 py-0.5 text-[10px] text-dim">
                  {accountKeyOf(a.id)}
                </code>
                <span className="ml-auto" />
                <UsageIndicator ok={ok} />
                {a.id !== 'main' && (
                  <button
                    onClick={() => void patchAccounts(accounts.filter((x) => x.id !== a.id))}
                    disabled={busy}
                    aria-label={`Remove account ${a.label}`}
                    className="rounded-chip px-2 py-1 text-xs text-faint transition-colors duration-150 hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
              <p className="truncate text-xs text-faint" title={a.configDir ?? undefined}>
                {a.configDir ?? 'default login (~/.claude)'}
              </p>
              <div className="flex items-center gap-2">
                <label
                  htmlFor={`acct-prio-${a.id}`}
                  className="text-xs font-medium text-ink"
                >
                  Priority
                </label>
                <input
                  id={`acct-prio-${a.id}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={99}
                  value={prioValue(a)}
                  onChange={(e) => {
                    setPrioDrafts((d) => ({ ...d, [a.id]: e.target.value }));
                    setSaved(false);
                  }}
                  onBlur={() => commitPriority(a)}
                  placeholder="auto"
                  aria-invalid={prioErrs[a.id] ? true : undefined}
                  aria-describedby={
                    prioErrs[a.id] ? `acct-prio-${a.id}-err` : `acct-prio-${a.id}-help`
                  }
                  className="field-input w-20"
                />
                {!prioErrs[a.id] && (
                  <span id={`acct-prio-${a.id}-help`} className="text-xs text-faint">
                    lower burns first; blank = auto (soonest reset first)
                  </span>
                )}
                {prioErrs[a.id] && (
                  <span id={`acct-prio-${a.id}-err`} role="alert" className="text-xs text-danger">
                    {prioErrs[a.id]}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <span
        aria-live="polite"
        className={`-mt-1 text-xs text-jade transition-opacity duration-300 ${saved ? 'opacity-100' : 'opacity-0'}`}
      >
        Saved
      </span>
      {err && (
        <p role="alert" className="text-xs text-danger">
          {err}
        </p>
      )}

      {accounts.length < MAX_CLAUDE_ACCOUNTS && (
        <div className="flex flex-col gap-3 rounded-card bg-overlay p-4">
          <h4 className="text-xs font-semibold uppercase tracking-[0.15em] text-ember">
            Add account
          </h4>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="acct-new-id" className="text-sm font-medium text-ink">
                Id
              </label>
              <input
                id="acct-new-id"
                type="text"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder="work"
                aria-describedby="acct-new-id-help"
                className="field-input w-full"
              />
              <p id="acct-new-id-help" className="text-xs leading-relaxed text-faint">
                Short slug: lowercase letters, digits, dashes.
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="acct-new-label" className="text-sm font-medium text-ink">
                Label
              </label>
              <input
                id="acct-new-label"
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Work Max"
                className="field-input w-full"
              />
            </div>
          </div>
          <div>
            <button
              onClick={() => void addAccount()}
              disabled={busy || newId.trim() === ''}
              className="rounded-chip bg-ember/20 px-3 py-1.5 text-xs font-semibold text-ember transition-colors duration-150 hover:bg-ember/30 disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add account'}
            </button>
          </div>
          {addErr && (
            <p role="alert" className="text-xs text-danger">
              {addErr}
            </p>
          )}

          {addedId && (
            <div className="flex flex-col gap-2 border-t border-line pt-3" aria-live="polite">
              <p className="text-sm font-medium text-ink">
                Now log in once as &lsquo;{addedId}&rsquo;
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-chip bg-raised px-2 py-1.5 text-[11px] text-dim">
                  {loginCommand(addedId)}
                </code>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(loginCommand(addedId)).then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                  aria-live="polite"
                  className="shrink-0 rounded-chip bg-raised px-2 py-1.5 text-xs text-dim transition-colors duration-150 hover:bg-active hover:text-ink"
                >
                  {copied ? 'copied' : 'copy'}
                </button>
              </div>
              <p className="max-w-sm text-xs leading-relaxed text-faint">
                Run this in Terminal and log in once with the account you want to add. surplus
                never sees or stores your tokens — Claude Code keeps that login refreshed
                itself.
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => void checkConnection(addedId)}
                  disabled={checking}
                  className="rounded-chip bg-raised px-3 py-1.5 text-xs font-medium text-ink transition-colors duration-150 hover:bg-active disabled:opacity-50"
                >
                  {checking ? 'Checking…' : 'Check connection'}
                </button>
                <span aria-live="polite" className="text-xs text-dim">
                  {checkResult}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function SettingsPanel({
  config,
  state,
  onClose,
  onSaved,
}: {
  config: ConfigDto;
  /** Live /api/state — per-account usage for the accounts section indicators. */
  state: StateDto;
  onClose: () => void;
  onSaved: (cfg: ConfigDto) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => fromConfig(config));
  const [errors, setErrors] = useState<Partial<Record<NumKey, string | null>>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [apiErr, setApiErr] = useState<string | null>(null);
  // Simple-by-default tiering: advanced sections render only when toggled on.
  // The choice persists, but every field stays in the Draft + buildPatch so
  // advanced values always submit regardless of what's currently visible.
  const [advanced, setAdvanced] = useState<boolean>(
    () => localStorage.getItem('surplus.settingsAdvanced') === '1',
  );
  const setAdvancedPersist = (v: boolean) => {
    setAdvanced(v);
    localStorage.setItem('surplus.settingsAdvanced', v ? '1' : '0');
  };

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
            <div className="flex items-center gap-3">
              <div
                role="group"
                aria-label="Detail level"
                className="flex items-center gap-0.5 rounded-chip bg-overlay p-0.5"
              >
                <button
                  type="button"
                  aria-pressed={!advanced}
                  onClick={() => setAdvancedPersist(false)}
                  className={`rounded-chip px-2.5 py-1 text-xs font-medium transition-colors duration-150 ${
                    !advanced ? 'bg-ember/20 text-ember' : 'text-dim hover:text-ink'
                  }`}
                >
                  Simple
                </button>
                <button
                  type="button"
                  aria-pressed={advanced}
                  onClick={() => setAdvancedPersist(true)}
                  className={`rounded-chip px-2.5 py-1 text-xs font-medium transition-colors duration-150 ${
                    advanced ? 'bg-ember/20 text-ember' : 'text-dim hover:text-ink'
                  }`}
                >
                  Advanced
                </button>
              </div>
              <button
                onClick={close}
                aria-label="Close settings"
                className="rounded-chip px-2 py-1 text-dim transition-colors duration-150 hover:bg-overlay hover:text-ink"
              >
                ✕
              </button>
            </div>
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
                <NumField
                  id="set-stopAtPct"
                  label="Stop at"
                  labelTip={
                    <InfoTip
                      label="What does Stop at mean?"
                      text="Surplus stops burning once your weekly usage reaches this, so it never fully drains the week."
                    />
                  }
                  unit="%"
                  help="Stop burning when 7-day utilization reaches this."
                  value={draft.stopAtPct}
                  error={errors.stopAtPct}
                  min={RULES.stopAtPct.min}
                  max={RULES.stopAtPct.max}
                  onChange={(v) => set('stopAtPct', v)}
                  onBlur={() => blurCheck('stopAtPct')}
                />
              </div>
              {advanced && (
                <>
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
                </>
              )}
            </Section>

            <Section
              title="Reserve"
              tip={
                <InfoTip
                  label="What is Reserve?"
                  text="Quota surplus never touches — leaves room for your other tools (like scheduled scripts or assistants) that share the same Claude login."
                />
              }
            >
              <p className="-mt-2 max-w-sm text-xs leading-relaxed text-dim">
                Quota left for your other tools on the same login — surplus never touches it.
              </p>
              <div className="grid grid-cols-2 gap-4">
                {num('reserveWeeklyPct', 'Weekly reserve', '%', 'Of the 7-day window, always left untouched.')}
                {num('reserveFiveHourPct', '5-hour reserve', '%', 'Of each 5-hour window, always left untouched.')}
              </div>
              {advanced &&
                num('watchdogIntervalMinutes', 'Watchdog interval', 'min', 'How often a running task re-checks usage against the ceilings.')}
            </Section>

            <AccountsSection config={config} usage={state.usage} onSaved={onSaved} />

            <Section title="Providers">
              <div className="flex flex-col gap-3 rounded-card bg-overlay p-4">
                <h4 className="text-xs font-semibold uppercase tracking-[0.15em] text-ember">
                  claude
                </h4>
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
                    labelTip={
                      <InfoTip
                        label="What is effort?"
                        text="How hard the model works per task. 'max' is the highest."
                      />
                    }
                    value={draft.claudeEffort}
                    options={EFFORT_SELECT_OPTIONS}
                    onChange={(v) => set('claudeEffort', v)}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-3 rounded-card bg-overlay p-4">
                <h4 className="text-xs font-semibold uppercase tracking-[0.15em] text-jade">
                  codex
                </h4>
                <Toggle
                  id="set-codexEnabled"
                  label="Enabled"
                  help="Usage probing and dispatch start on the next surplus restart."
                  checked={draft.codexEnabled}
                  onChange={(v) => set('codexEnabled', v)}
                />
                {draft.codexEnabled && (
                  <div className="grid grid-cols-2 gap-4">
                    <SelectField
                      id="set-codexModel"
                      label="Default model"
                      value={draft.codexModel}
                      options={codexModelOptions()}
                      onChange={(v) => set('codexModel', v)}
                    />
                    <SelectField
                      id="set-codexEffort"
                      label="Default effort"
                      labelTip={
                        <InfoTip
                          label="What is effort?"
                          text="How hard the model works per task. 'max' is the highest."
                        />
                      }
                      value={draft.codexEffort}
                      options={EFFORT_SELECT_OPTIONS}
                      onChange={(v) => set('codexEffort', v)}
                    />
                  </div>
                )}
                {advanced && (
                  <div className="flex flex-col gap-1">
                    <span className="flex items-center gap-1.5">
                      <label htmlFor="set-codexFallback" className="text-sm font-medium text-ink">
                        Weekly reset fallback
                      </label>
                      <InfoTip
                        label="What is the codex weekly reset fallback?"
                        text="Only needed if surplus can't read your Codex usage automatically (it usually can, from Codex's own session files). If your gauges stay blank, set your weekly reset here as a backup, e.g. 'Thu 21:00'."
                      />
                    </span>
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
                )}
              </div>
            </Section>

            {advanced && (
              <>
                <Section title="Pacing">
                  {num('fiveHourPausePct', '5-hour pause at', '%', 'Between launches, wait for the 5-hour reset once utilization hits this.')}
                </Section>

                <Section
                  title="Dispatcher"
                  tip={
                    <InfoTip
                      label="What is the Dispatcher?"
                      text="How tasks run under the hood — how many at once, retries, and time limits. Defaults are fine for almost everyone."
                    />
                  }
                >
                  <div className="grid grid-cols-2 gap-4">
                    {num('maxConcurrent', 'Max concurrent', 'tasks')}
                    {num('maxAttempts', 'Max attempts', 'tries', 'Failed attempts before a task is auto-blocked.')}
                    {num('taskTimeoutMinutes', 'Task timeout', 'min', 'Hard wall-clock cap per run.')}
                    {num('maxTurnsHint', 'Turn hint', 'turns', 'Suggested turn bound embedded in the goal condition.')}
                  </div>
                </Section>

                <Section title="Discovery">
                  <div className="flex flex-col gap-1">
                    <label htmlFor="set-discoveryRoots" className="text-sm font-medium text-ink">
                      Scan folders
                    </label>
                    <input
                      id="set-discoveryRoots"
                      type="text"
                      value={draft.discoveryRoots}
                      onChange={(e) => set('discoveryRoots', e.target.value)}
                      placeholder="~/Projects, ~/Code"
                      aria-describedby="set-discoveryRoots-help"
                      className="field-input w-full max-w-80"
                    />
                    <p
                      id="set-discoveryRoots-help"
                      className="max-w-xs text-xs leading-relaxed text-faint"
                    >
                      Comma-separated folders the Add-Project picker scans for git repos. ~ is
                      your home folder.
                    </p>
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
              </>
            )}

            <ServiceSection />
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
