# launchd adapter

surplus runs as a macOS LaunchAgent: launchd executes `surplus tick` every
15 minutes, and the tick decides — from live usage — whether to do anything.
Ticks are cheap and idempotent; almost all of them exit immediately with
`idle`.

## Automatic install (recommended)

```sh
node bin/surplus.js install
```

This renders [`com.jonathanwizman.surplus.plist.template`](./com.jonathanwizman.surplus.plist.template)
with your real paths (node binary, `bin/surplus.js`, log file), writes it to:

```
~/Library/LaunchAgents/com.jonathanwizman.surplus.plist
```

and loads it. Defaults: tick every 900 s, no run at load, logs to
`~/.surplus/logs/launchd.log`.

## Manual install

If you prefer to do it yourself (or `surplus install` is unavailable):

1. Render the template — replace the four placeholders with absolute paths:

   ```sh
   sed -e "s|__NODE__|$(which node)|" \
       -e "s|__SURPLUS_BIN__|$HOME/Projects/surplus/bin/surplus.js|" \
       -e "s|__INTERVAL__|900|" \
       -e "s|__LOG__|$HOME/.surplus/logs/launchd.log|g" \
       adapters/launchd/com.jonathanwizman.surplus.plist.template \
       > ~/Library/LaunchAgents/com.jonathanwizman.surplus.plist
   ```

   Adjust `__SURPLUS_BIN__` to wherever you cloned the repo. launchd does not
   expand `~` or `$PATH` — every path must be absolute.

2. Create the log directory (surplus also does this lazily, but launchd
   needs the parent dir for `StandardOutPath` to work):

   ```sh
   mkdir -p ~/.surplus/logs
   ```

3. Load the agent:

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jonathanwizman.surplus.plist
   ```

   (On older macOS: `launchctl load -w ~/Library/LaunchAgents/com.jonathanwizman.surplus.plist`.)

## Verify

```sh
launchctl list | grep surplus
```

You should see a line containing `com.jonathanwizman.surplus`. The first
column is the PID of the last run (`-` when not currently running), the
second is the last exit status.

Force a tick now instead of waiting for the interval:

```sh
launchctl kickstart gui/$(id -u)/com.jonathanwizman.surplus
```

Then watch the log:

```sh
tail -f ~/.surplus/logs/launchd.log
```

To stop work without uninstalling, use the kill switch: `surplus pause`
(creates `~/.surplus/PAUSED`; ticks keep firing but always decide `stop`).

## Uninstall

```sh
node bin/surplus.js uninstall
```

Or manually:

```sh
launchctl bootout gui/$(id -u)/com.jonathanwizman.surplus
rm ~/Library/LaunchAgents/com.jonathanwizman.surplus.plist
```

(On older macOS: `launchctl unload -w ...` before removing the file.)
Runtime state in `~/.surplus` (queue DB, logs, config) is left intact;
delete that directory yourself if you want a clean slate.

## Notes

- `StartInterval` ticks do not fire while the Mac sleeps; launchd coalesces
  missed intervals into one run on wake. Because the tick decides from current
  usage rather than a schedule, nothing is lost.
- launchd is just one driver. Any scheduler that can run `surplus tick` works
  the same way — see [`../openclaw/`](../openclaw/README.md) for a cron/agent
  example.
