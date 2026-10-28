# ACP S7: the child buffer's byte budget, harness written, not measured

Status: 2026-10-28. Part of [acp-agent-host.md](acp-agent-host.md) §4.7 and S7's last item.

## Result

**One real session was measured; the budget is still provisional.** On 2026-10-28 the Claude Code ACP adapter
(`@agentclientprotocol/claude-agent-acp` 0.98.0, installed in a scratch folder, driven over stdio as the desktop drives
an agent: no subagent capability declared) ran one prompt that started three subagents in parallel in an empty folder.
Replayed through `child-buffer-cli.ts`:

```
{"updates":68,"childEvents":18,"dropped":0,"peakBytes":0}
```

- 18 of the 68 updates were stamped with a parent tool call (6 `tool_call`, 12 `tool_call_update`, all tool events:
  no child text reached the feed from a client that declares nothing).
- The spawn call of each child was announced before any of its children's events, so the buffer was never used: peak 0.
- What a child event costs in the ledger's own terms: 2,082 bytes for all 18, at most 127 bytes each.

That is one run of three short children with the parent first every time. It shows the ordering the buffer guards
against did not occur and that real events are small; it does not set a number, and it says nothing about long children
with streamed text (which this adapter only forwards to a client that declares support, and no agent reports yet).
`CHILD_BUFFER_BUDGET_BYTES` stays at the provisional `512 * 1024` (`apps/desktop/src/acp/children.ts`), per session, with
at most 8 sessions at once. **S7's acceptance item "budget measured on a real child-heavy session" is pending**: it needs
several runs, children that stream text, and an agent that reports its children.

## Why that figure

The buffer holds child events that arrive before the tool call that spawned them. The two ordering facts that bound it:

- The agent starts a child from a tool call it has already announced, so the spawn call normally comes first and the buffer
  holds a handful of events, or none. The only observed source of the other order is the agent's own buffer for the same
  problem (a child's update that comes before its parent is announced): in the Claude Code adapter (0.98.0) it keeps at most 32
  updates per parent, 256 in all and 64 parents (`MAX_PENDING_UPDATES_PER_PARENT`, `MAX_PENDING_UPDATES`, `MAX_PENDING_PARENTS`).
- What this host keeps of an update is small: text deltas of tens to hundreds of bytes, and a tool event of id, status,
  title (500 characters) and kind, about 0.7 KB at most.

256 updates at about 2 KB each is 512 KiB. The budget sits well under the caps that already bound a turn: one post carries
200 KB (`MAX_BATCH_BYTES`) and a turn holds 4 MB of unsent output (`MAX_PENDING_JSON`), so a full buffer is about 2.6 posts
and an eighth of one turn's own pending cap. It is a ceiling for a pathological ordering, not a size anything is expected to
reach. If a real session shows a peak far below it, lower it; if one drops events, raise it and record the session.

## The harness

- **Offline, the only path that measures today.** `apps/desktop/src/acp/child-buffer.ts` replays a log of an agent's
  output through the same ledger and reports the child events seen, the peak bytes held and what a given budget would
  drop. `child-buffer-cli.ts` runs it:

  ```
  pnpm --filter @neore/desktop exec tsx src/acp/child-buffer-cli.ts agent-output.jsonl [budgetBytes]
  ```

  The log is the agent's stdout (one JSON-RPC frame per line). It reads children whether or not the host would show them.
- **Live, not yet.** A session logs `child output buffered before its parent: peak <bytes> bytes, <n> dropped` when it
  ends, but only for an agent that reports its children: `session.ts` drops a child's update before the ledger when
  `subagents.ownChildren` is unsupported, and every real agent is unsupported until something reports it. So running the
  desktop on a real agent logs nothing about children today.

## How to measure

1. Install the adapter in a scratch folder (`npm install @agentclientprotocol/claude-agent-acp`), start it with an empty
   working folder, speak ACP to it over stdio as the host does (`initialize`, `session/new`, `session/prompt`; answer
   `session/request_permission` with the first allow-once option; the folder is empty and the prompt read-only), and
   save its stdout.
2. Give it a task that starts several children at once, each with long output and many tool calls. Repeat three times.
3. Feed each log to the offline path. The budget is the largest peak with headroom, rounded to a power of two; record
   the runs here.
