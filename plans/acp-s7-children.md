# ACP S7: the child buffer's byte budget, harness written, not measured

Status: 2026-10-28. Part of [acp-agent-host.md](acp-agent-host.md) §4.7 and S7's last item.

## Result

**Not measured.** The slice was built in a session with no signed-in desktop and no way to run a real agent through a
child-heavy task, so no session could be recorded. The budget in the code is a provisional figure:

`CHILD_BUFFER_BUDGET_BYTES = 512 * 1024` (`apps/desktop/src/acp/children.ts`), per session.

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

- The live path: every session logs `child output buffered before its parent: peak <bytes> bytes, <n> dropped` when it ends,
  and `child output arrived before its parent and passed the <bytes>-byte buffer` on the first drop (`session.ts`,
  `children.ts`). Running a child-heavy task with the desktop open is a measurement; read the line in the app's log.
- The offline path: `apps/desktop/src/acp/child-buffer.ts` replays a log of an agent's output through the same ledger and
  reports the child events seen, the peak bytes held and what a given budget would drop. `child-buffer-cli.ts` runs it:

  ```
  pnpm --filter @neore/desktop exec tsx src/acp/child-buffer-cli.ts agent-output.jsonl [budgetBytes]
  ```

  The log is the agent's stdout (one JSON-RPC frame per line), captured by starting the agent through a wrapper that `tee`s it.

## How to measure

1. Use an agent that reports its children (none does yet: see the S7 section of the plan). Until then, replay a recorded log
   from an adapter that stamps children with `_meta.claudeCode.parentToolUseId` and flatten-forwards them, which the offline
   path reads whether or not the host would show them.
2. Give it a task that starts several children at once, each with long output and many tool calls.
3. Repeat three times. The budget is the largest peak with headroom, rounded to a power of two; record the runs here.
