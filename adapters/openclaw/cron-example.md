# OpenClaw cron example: drive `surplus tick`

> **Example config — verify against your OpenClaw version.** The exact cron
> job schema has changed between OpenClaw releases; treat the snippets below
> as the shape of the integration, and check OpenClaw's cron documentation
> (`openclaw cron --help` or the docs site) for the current syntax before
> pasting.

The job is deliberately boring: shell out to `surplus tick` every 15 minutes.
All scheduling intelligence lives inside the tick (usage probe → decision
engine → maybe dispatch), so the cron entry never needs to know about burn
windows, resets, or quota.

## Job definition (illustrative)

```jsonc
// EXAMPLE ONLY — match field names to your OpenClaw cron docs.
{
  "name": "surplus-tick",
  "schedule": "*/15 * * * *",
  "command": "/opt/homebrew/bin/node /Users/you/Projects/surplus/bin/surplus.js tick",
  "timeoutSeconds": 120
}
```

Or, if your OpenClaw config registers cron jobs in its config file:

```yaml
# EXAMPLE ONLY — match to your OpenClaw version's cron section.
cron:
  - name: surplus-tick
    schedule: "*/15 * * * *"
    run: /opt/homebrew/bin/node /Users/you/Projects/surplus/bin/surplus.js tick
```

Notes:

- **Absolute paths.** Cron-spawned shells get a minimal environment; do not
  rely on `$PATH` finding `node` or a `surplus` alias. Use
  `which node` to find your node path; replace `/Users/you/Projects/surplus`
  with your clone.
- **Idempotent by design.** If a tick fires while a previous work session is
  still running, the dispatcher's concurrency cap and respawn guard make it a
  no-op. A 15-minute schedule alongside the launchd agent is also fine, just
  redundant.
- **Kill switch still applies.** `surplus pause` (or touching
  `~/.surplus/PAUSED`) makes every tick decide `stop`, regardless of which
  scheduler fired it.
- **Plain crontab fallback.** No OpenClaw required — the same job in
  `crontab -e`:

  ```
  */15 * * * * /opt/homebrew/bin/node /Users/you/Projects/surplus/bin/surplus.js tick >> /Users/you/.surplus/logs/cron.log 2>&1
  ```

## Companion pattern: agent enqueues, tick burns

The cron job only *spends* quota; an OpenClaw agent can *supply* the backlog.
When an agent session produces a concrete, finishable improvement for a
registered project, have it run:

```sh
surplus task create my-backlog-app "Migrate config parsing to zod" \
  --body "Replace the hand-rolled validation in src/config.ts. All existing
config fixtures must still load. Acceptance: pnpm test passes; invalid config
produces a one-line actionable error."
```

The task waits in the queue until the next burn window; the agent's job ends
at enqueue. See [README.md](./README.md) for guidance on writing task bodies
the judge can score.
