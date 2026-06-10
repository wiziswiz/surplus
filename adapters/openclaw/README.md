# OpenClaw adapter

surplus has no OpenClaw-specific code, and needs none. The whole integration
surface is two CLI commands:

- **`surplus tick`** — idempotent. Probes usage, runs the decision engine, and
  dispatches work only when a burn window is open. Safe to call as often as you
  like, from any scheduler; overlapping or redundant calls are no-ops (a
  respawn guard prevents double dispatch, and `~/.surplus/PAUSED` stops
  everything).
- **`surplus task create <project> "<title>" --body "..."`** — enqueues work.
  Anything that can shell out can feed the backlog.

That makes OpenClaw useful in two roles:

## 1. Scheduler: drive ticks from an OpenClaw cron job

Instead of (or alongside) the launchd agent, let OpenClaw's cron fire the tick
every 15 minutes. See [`cron-example.md`](./cron-example.md) for the job
config. Running both launchd and an OpenClaw cron is harmless — ticks are
idempotent — but pick one to keep logs tidy.

## 2. Producer: an agent that fills the queue

The more interesting pattern: an OpenClaw agent that *enqueues* work it
discovers — triaged bookmarks, TODOs found in notes, follow-ups from a
research session — so surplus has something worth burning quota on when the
window opens.

Give the agent an instruction like:

> When you identify a concrete, self-contained improvement for one of my
> registered surplus projects, enqueue it:
>
> ```sh
> surplus task create my-backlog-app "Add CSV export to the reports page" \
>   --body "Export the currently filtered rows. Reuse the existing filter
> state. Acceptance: a downloaded file opens in Numbers with correct headers."
> ```
>
> Write the body as acceptance criteria, not vibes — the judge scores the run
> against it. Do not enqueue vague tasks ("improve performance"); split big
> ideas into tasks that one work session can finish.

Useful flags when enqueuing programmatically:

```sh
surplus task create <project> "<title>" \
  --body "<markdown acceptance criteria>" \
  --priority 50            # lower = claimed first (default 100)
  --provider codex         # claude | codex | any (default any)
```

Tasks land in the queue and wait; nothing executes until a burn window opens
and the dispatcher claims them. The agent never needs credentials, network
access to surplus, or knowledge of usage windows — `surplus tick` owns all of
that.
