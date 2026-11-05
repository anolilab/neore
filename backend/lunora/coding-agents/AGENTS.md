# CODING AGENTS — AGENT NOTES

## INVARIANTS

- **Coding agents** (`backend/lunora/coding-agents/`) — `delegateToCodingAgent`
  (chat tool, built-in that defaults to `ask`) and a task's `codingAgent`
  assignee run Claude Code / Codex in an E2B sandbox on the user's BYOK
  `anthropic`/`openai` key. **No action waits for a run** (up to 20 min): a
  scheduled action is dispatched from the SchedulerDO alarm, and Cloudflare
  caps alarms at 15 min wall time. The sandbox runs a detached script
  (`buildRunScript`: clone, install the PINNED CLI, run the agent, write a
  status file); the backend only starts it, polls its log every 4s, and
  finalizes. The tool returns at once; the result lands as a follow-up
  assistant message (`agentName`) on the active branch, and a task round is
  completed by `finishCodingAgentRound`. **A PR is never pushed from the
  agent's sandbox** — the agent ran untrusted code there — it is rebuilt from
  the stored diff in a fresh sandbox, by a detached script polled the same way
  (`startPullRequest` → `pollPullRequest` → GitHub API). Claude runs with `--bare`: without it,
  `-p` executes the repo's `.claude/settings.json` hooks and `.mcp.json`
  servers. CLI flags are cited in `buildAgentCommand`; re-check them when
  bumping `npmVersion`. E2B itself is unit-tested against a fake only.
