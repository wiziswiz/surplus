# Codex CLI adapter — investigation notes

Machine-verified against the locally installed CLI on 2026-06-09. All probing
was read-only; no `codex exec` was run (would burn quota). No token material
was read or recorded anywhere — only file NAMES under `~/.codex/` plus the
non-secret usage numbers in session rollout JSONL.

## Installation & auth

| Command | Observed |
|---|---|
| `which codex` | `/opt/homebrew/bin/codex` |
| `codex --version` | `codex-cli 0.137.0` |
| `codex login status` | `Logged in using ChatGPT` (subscription auth, not API key) |
| `ls ~/.codex/` | `auth.json cache config.toml goals_1.sqlite history.jsonl installation_id log logs_2.sqlite memories models_cache.json rules session_index.jsonl sessions shell_snapshots skills state_5.sqlite(+shm/wal) tmp version.json` |
| `~/.codex/config.toml` | `model = "gpt-5.4"` (only non-secret keys grepped; file never dumped) |

## `codex exec` flags (verified via `codex exec --help`, 0.137.0)

- `exec` subcommand exists (alias `e`); prompt as positional arg, or from
  stdin when omitted or when `-` is passed.
- `-s, --sandbox <read-only|workspace-write|danger-full-access>` — verified.
- `--dangerously-bypass-approvals-and-sandbox` exists — NOT used; we prefer
  the sandboxed unattended set below.
- NO `--full-auto` flag in this version. NO `-a/--ask-for-approval` on `exec`
  (it exists only on the interactive top-level command with values
  `untrusted|on-failure|on-request|never`; help text marks `on-failure` as
  DEPRECATED and says "Prefer ... `never` for non-interactive runs").
- `-C, --cd <DIR>` — exists; we use `cwd` on spawn instead (equivalent,
  avoids path-flag handling).
- `-m, --model <MODEL>` — verified.
- `-c, --config <key=value>` — TOML-typed config overrides; used for
  `sandbox_workspace_write.network_access=true`, `approval_policy=never`,
  and `model_reasoning_effort="<level>"`.
- `--json` — "Print events to stdout as JSONL" (verified present; we stream
  the human text output to the log instead and use `--output-last-message`).
- `-o, --output-last-message <FILE>` — final agent message → used for
  `RunnerResult.summary`.
- `--skip-git-repo-check`, `--color <always|never|auto>`, `--ephemeral`,
  `--output-schema <FILE>`, `--add-dir <DIR>` — all present. `--ephemeral` is
  deliberately NOT used so each run persists a session rollout containing
  fresh rate-limit data (see usage surface below).

Chosen headless flag set (safest that still runs unattended):

```
codex exec \
  --sandbox workspace-write \
  -c sandbox_workspace_write.network_access=true \
  -c approval_policy=never \
  --skip-git-repo-check \
  --color never \
  --output-last-message <logsDir>/<task>-attempt<N>-codex.last.txt \
  -m <model> \
  [-c model_reasoning_effort="<low|medium|high|xhigh>"] \
  -            # prompt piped via stdin
```

Note: `approval_policy` as a config key was not independently verifiable
read-only (no config-schema dump command), but `exec` is non-interactive by
design and unknown `-c` keys are ignored without `--strict-config`, so the
override is harmless if the key ever drifts.

## Reasoning effort (verified via `codex debug models`)

`codex debug models` renders the model catalog as JSON. All current models
(`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `codex-auto-review`) list
`supported_reasoning_levels`: `low`, `medium`, `high`, `xhigh`
(default `medium`). Mapping implemented: low→low, medium→medium, high→high,
xhigh/max→`xhigh`; anything else omits the flag (codex default applies).

## Usage / rate-limit surface

What was NOT discoverable in 0.137.0:

- No `codex usage` or `codex status` subcommand (both fall through to the
  general help).
- `codex doctor` diagnoses install/config/auth health (`--json` redacted
  report) but does not report rate limits.
- No flags mentioning rate limits in `codex --help` / `codex exec --help`.
- No on-demand "fetch my limits" command at all without spending tokens.

What WAS verified — a passive, read-only surface: every session (including
`codex exec` runs) writes a rollout file
`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` containing
`token_count` events of this shape (real example, numbers are usage stats,
not secrets):

```json
{"timestamp":"2026-06-01T18:18:57.745Z","type":"event_msg","payload":{
  "type":"token_count",
  "info":{"total_token_usage":{...},"last_token_usage":{...},"model_context_window":258400},
  "rate_limits":{
    "limit_id":"codex","limit_name":null,
    "primary":  {"used_percent":28.0,"window_minutes":300,  "resets_at":1780350282},
    "secondary":{"used_percent":6.0, "window_minutes":10080,"resets_at":1780859956},
    "credits":null,"plan_type":"plus","rate_limit_reached_type":null}}}
```

- `primary` = 5-hour window (`window_minutes: 300`), `secondary` = 7-day
  window (`window_minutes: 10080`); `resets_at` is epoch SECONDS;
  `used_percent` is 0–100; `plan_type` e.g. `"plus"`.
- The same `rate_limits` block is what `codex exec --json` emits live in its
  `token_count` events — the rollout file is simply the persisted copy.

Adapter strategy (`getUsage`):

1. CLI missing (`codex --version` fails/ENOENT) → `null` always.
2. Scan the newest rollout files (newest-first, max 20 files, last 512KB of
   each) for the latest `token_count.rate_limits`. Use it only while its
   7-day window is still current (`secondary.resets_at > now`); 5h fields are
   nulled if the 5h window already reset. Staleness caveat: `used_percent`
   was true at recording time, so it can only UNDER-estimate current usage;
   mid-run quota exhaustion is caught by the runner's quota classification.
   Because we don't pass `--ephemeral`, every surplus codex run refreshes
   this data, so it becomes effectively live while burning.
3. Else `config.providers.codex.weeklyResetFallback` (ISO timestamp or
   `'Thu 21:00'` local weekday-time) rolled forward to the next weekly
   occurrence strictly after now → time-gated snapshot with null
   utilizations, `planName: 'ChatGPT'`.
4. Else `null` (dispatcher skips the provider).

## Run classification

- Hard timeout (`taskTimeoutMinutes`): SIGTERM → 15s grace → SIGKILL →
  outcome `timeout`.
- Exit via external signal (user pause etc.) → `killed`.
- Nonzero exit + quota/auth regex on the output tail (rate limit / usage
  limit / quota / 429 / 401 / unauthorized / not logged in / `codex login` /
  session expired / reauthenticate) → `quota`; otherwise `error`.
- Clean exit whose final message admits hitting a limit (narrow regex) →
  `quota`; otherwise `failed` = completed-pending-judge (the claude-side
  judge promotes to `passed`).
- Final summary is passed through `redactSecrets()` from vision.ts before it
  leaves the adapter.

## Other observations

- Logs: `<logsDir>/<task.id>-attempt<N>-codex.log` (+ `-codex.last.txt` for
  the final message), mirroring runner.ts's `<task.id>-attempt<N>.log`
  claude convention without clashing.
- Heartbeat callback every 3 minutes, matching runner.ts's cadence.
- Worktree lifecycle reuses `prepareWorktree`/`finalizeWorktree` from
  runner.ts (runner.ts's header explicitly designates them for the codex
  provider); `finalizeWorktree` checkpoint-commits and never throws, and is
  called in `finally`.
