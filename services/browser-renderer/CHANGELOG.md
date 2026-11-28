# Changelog

## 0.1.0

<sub>2026-11-28</sub>

- feat(browser): a still frame of the thread's browser, and a claim that never takes over another view (#983)
- feat(chat): a browser click that pays asks first, in every mode (#888)
- fix(browser-renderer): bound a sign-in's scrub, confirm a quick close at the deadline, refuse forms with a file input (#897)
- feat(vault): the agent signs in with a saved login, and the password never reaches the model (#891)
- fix(browser-renderer): open and reconnect browsers through the Playwright launcher (#889)
- feat(browser): sign in with a saved login in one renderer call, never returning the password (#876)
- chore(deps): refresh dependencies, dedupe tailwind-merge, prune stale audit ignores (#880)
- feat(browser): watch the agent's cloud browser live, read-only (#845)
- chore(lint): format with oxfmt from the root, gate on an ESLint-aligned oxlint (#576)
- chore(tooling): type-check affected projects in the pre-push hook with a fast compiler (#568)
- feat: combine the open UI and coding-agent PRs, with their review threads fixed (#426)
- feat: workflow undo/redo, stored workflow images, and audit fixes (#279)
- fix: cost guards for triggers, sweeps, render retries, rate limits and presence (#233)
- chore(lint): disable jsdoc/text-escaping in the remaining project configs (#232)
