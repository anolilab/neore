# ACP S4: hidden-window throttling, harness written, not run

Status: 2026-10-28. Part of [acp-agent-host.md](acp-agent-host.md) §4.5, §10 Q4 and S4's second acceptance item.
Continues [acp-s3-throttling.md](acp-s3-throttling.md), which holds the reasoning for why only the page relay and the
heartbeat can slip.

## Result

**Not measured.** The slice that added the remote paths was built in a session with no signed-in desktop and no
running backend, so no hour with the window hidden could be recorded, and the numbers below are empty. §10 Q4 stays
at its recommendation: **keep background throttling on** until a measurement fails its budget.

What S4 changed that makes the measurement matter now: a command for the computer (`acp_send`, `acp_cancel`,
`acp_permission_answer`) is claimed by the page relay, which a hidden window throttles. A claim that arrives late is
no longer a lost command, though: it is a lease (`ACP_CLAIM_LEASE_MS`, 30 s), the page retries a failed claim or
completion until the call's deadline, and a call nobody claims in 60 s ends its turn with "host did not answer". The
30 s lease is a guess; set it from the claim latency this measures.

## The harness

- `apps/desktop/src/acp/throttling.ts`: `summarize(claims, heartbeats)`, with the budgets, and its test.
- `apps/desktop/src/acp/throttling-cli.ts`: `sample` polls the account's own device list and audit list every 10 s and writes JSON
  lines; `report` prints the summary. The audit list now carries `claimedAt` (`listDeviceCalls`), which is what the
  claim latency is read from. The RPC call in `sample` follows the shape of the backend's `/_lunora/rpc` endpoint
  as used elsewhere in this repo and was never run against a backend: check its first line of output before trusting
  an hour of it.

## How to measure

1. Pair a desktop (macOS, then Linux with a tray) and approve an agent for a folder in its local window.
2. Start the agent from the web (Settings → Devices → Start …) and give it a long task.
3. Hide the main window (close it on macOS, or with a tray) and leave it hidden for an hour.
4. From another machine: `NEORE_BACKEND_URL=… NEORE_BEARER=… pnpm --filter @neore/desktop exec tsx src/acp/throttling-cli.ts sample 60 > samples.jsonl`.
5. Once a minute from a browser: send the thread a message while no turn runs, then Stop it. Each makes the backend
   queue a command for the computer. Sixty minutes give about a hundred and twenty.
6. `pnpm --filter @neore/desktop exec tsx src/acp/throttling-cli.ts report samples.jsonl`.

Budgets: claim latency under 10 s at the 95th percentile, and no heartbeat gap over 60 s.

If either misses: set `backgroundThrottling: false` on the main window, measure the battery cost, record both here and
in §10 Q4, and set `ACP_CLAIM_LEASE_MS` above the measured worst claim.

| Platform | Claims | Claim p95 | Heartbeats | Longest gap | Result |
| --- | --- | --- | --- | --- | --- |
| macOS | not run | | | | |
| Linux (tray) | not run | | | | |
