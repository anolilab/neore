# Changelog

## 0.1.0
<sub>2026-11-07</sub>

- fix(agent): store large inline media from tool results instead of saving it in the message row (#572)
- chore(tooling): type-check affected projects in the pre-push hook with a fast compiler (#568)
- docs: split the root AGENTS.md into scoped files next to the code (#541)
- feat(ai): run the default models on Cloudflare Workers AI (#539)
- docs: remove the two finished plans and their links (#483)
- feat(chat): let a quick check approve low-risk tool calls (opt-in) (#435)
- feat: combine the open UI and coding-agent PRs, with their review threads fixed (#426)
- feat(chat): show an MCP tool's progress while it runs (#424)
- docs: add READMEs for the shared packages and the backend (#416)
- feat(chat): preview JSON Lines and Mermaid attachments (#337)
- feat(desktop): Electron shell, thread windows and offline screen (#296)
- feat(chat): steer a running reply (#321)
- feat(web): chat text size setting (#313)
- fix: audit 2026-10-20 — gateway pricing, workflow media quotas, cancelled-stream billing, backend correctness, gateway hardening, chat perf, Lunora alpha bump (#298)
- perf(web,backend): first-load and chat hot-path fixes (#311)
- feat(ai): mark, label and screen AI-generated output (EU AI Act Art. 50) (#268)
- feat(chat): locked threads, reply editing, display settings, navigation (#286)
- feat: workflow undo/redo, stored workflow images, and audit fixes (#279)
- feat: session import, task outcome email, resume latest chat, eval comparison, Telegram formatting, document preview, chemistry formulas (#278)
- feat(chat): highlight code blocks with TanStack Highlight instead of Shiki (#251)
- ci: fix startup failures, gate merges on lint and tests, cover Rust, add a full test run (#237)
- fix: cost guards for triggers, sweeps, render retries, rate limits and presence (#233)
- chore(lint): disable jsdoc/text-escaping in the remaining project configs (#232)
