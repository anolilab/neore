# Changelog

## 0.1.0
<sub>2026-11-07</sub>

- chore(tooling): type-check affected projects in the pre-push hook with a fast compiler (#568)
- feat(keyboard): F6 moves focus between screen areas, and F2 renames the selected thread (#513)
- feat(tasks): choose where a recurring run goes, its reasoning effort and project (#562)
- feat(auth,web): invite-only sign-in gate for chat; follow-ups to #542 (#543)
- docs: split the root AGENTS.md into scoped files next to the code (#541)
- feat(ai): run the default models on Cloudflare Workers AI (#539)
- feat: combine the open UI and coding-agent PRs, with their review threads fixed (#426)
- docs: add READMEs for the shared packages and the backend (#416)
- fix: work through the #297 audit backlog (#341)
- feat(chat): preview JSON Lines and Mermaid attachments (#337)
- feat(desktop): Electron shell, thread windows and offline screen (#296)
- feat(chat): zoom and pan image previews (#336)
- fix(a11y): respect reduced motion in shimmers, announce completed replies, and trap focus in full-screen viewers (#330)
- perf(web,backend): first-load and chat hot-path fixes (#311)
- feat(chat): timestamps, reasoning copy/collapse, completion sound, text direction, Word export (#290)
- feat(chat): locked threads, reply editing, display settings, navigation (#286)
- feat(workflow): video frames, reference uploads, trim, billing and plan gating for workflow media (#283)
- feat: workflow undo/redo, stored workflow images, and audit fixes (#279)
- feat: session import, task outcome email, resume latest chat, eval comparison, Telegram formatting, document preview, chemistry formulas (#278)
- chore(deps): update dependencies to their latest versions (#253)
- feat(chat): highlight code blocks with TanStack Highlight instead of Shiki (#251)
- ci: fix startup failures, gate merges on lint and tests, cover Rust, add a full test run (#237)
- fix: cost guards for triggers, sweeps, render retries, rate limits and presence (#233)
