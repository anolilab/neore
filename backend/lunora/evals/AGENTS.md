# EVALS — AGENT NOTES

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## INVARIANTS

- **Evals** (`backend/lunora/evals/`, `/evals`) — datasets of cases run against
  a skill, a model + system prompt, or knowledge retrieval, one case at a time
  on the jobs queue (claim → `runEvalCase` → complete, like tasks). No cron: each
  claim schedules its own `reapCase`. Every case is charged via
  `tasks/account.ts:chargeRound`, and the per-run cost cap is checked BEFORE
  each case, so a run can overshoot by one case. Cost comes from
  `runHeadlessAgent`'s `costMicrodollars` (gateway pricing summed over steps) —
  absent without the gateway or on an unpriced BYOK key, in which case the cost cap
  never trips (its tokens count against the run's token budget instead, `nextCaseBudget`) and a `max_cost_usd` check reads "not measured", not failed.
  RAG expected sources are matched by knowledge file id, else by file NAME (an
  imported dataset cannot know the ids). Case threads are marked temporary (7 days).
