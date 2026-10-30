# ACP S3: hidden-window throttling, not measured here

Status: 2026-10-28. Part of [acp-agent-host.md](acp-agent-host.md) §4.5 and §10 Q4.

## Result

**Not measured.** The slice that built the ingest, the reaper and the desktop poster was developed without a
signed-in desktop session and a backend to run an hour-long hidden-window turn against, so no relay claim latency
or heartbeat gap was recorded. §10 Q4 stays at its recommendation: **keep background throttling on** until a
measurement fails its budget.

The measurement is now an acceptance item of S4 in [acp-agent-host.md](acp-agent-host.md): the page relay that
claims `acp_cancel` is what a hidden window throttles, and S4 adds the remote paths that depend on it, so S4
measures there. This file stays the record of the method.

## What the slice does so the measurement can fail safely

- The poster does not depend on the page: the main process posts the output itself, from timers in the main
  process, which Electron does not throttle. Only the relay (claiming `acp_*` calls) and the heartbeat run in the
  page, and only they can slip.
- A turn posts a keepalive every 30 s (`KEEPALIVE_MS`) and the backend's reaper window is 3 minutes
  (`HOST_STREAM_IDLE_MS`), so a hidden window delays a remote command, never the output of a running turn.
- A heartbeat that slips past 75 s (`DEVICE_ONLINE_WINDOW_MS`) makes the device look offline to new remote sends
  (slice S4), not to a turn that is already running.

## How to measure it (before S4 ships)

1. Pair a desktop (macOS, then Linux with a tray), start a long agent turn, hide the main window, wait an hour.
2. Every 60 s send an `acp_cancel` for a turn id that does not exist (a harmless, signed call) and record the time
   from `createdAt` to `claimedAt` on its `deviceCalls` row, and the gaps between `devices.lastSeenAt` updates.
3. Budgets: relay claim latency under 10 s at the 95th percentile, and no heartbeat gap over 60 s.
4. If either misses: set `backgroundThrottling: false` on the main window, measure the battery cost, and decide
   whether to keep it. Record the numbers here and in §10 Q4.
