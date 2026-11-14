# Changelog

## 0.1.0

<sub>2026-11-14</sub>

- fix(auth): CLI sign-in refuses without a terminal and URL; withdraws a key when the follow-up count fails (#652)
- feat(cli): sign in by device code with neore login --device (#646)
- feat(cli): thread start and thread send, with a blocking --wait and exit codes (#512)
- chore(lint): format with oxfmt from the root, gate on an ESLint-aligned oxlint (#576)
- chore(tooling): type-check affected projects in the pre-push hook with a fast compiler (#568)
- feat: combine the open UI and coding-agent PRs, with their review threads fixed (#426)
- feat(chat): steer a running reply (#321)
- ci: fix startup failures, gate merges on lint and tests, cover Rust, add a full test run (#237)
- fix: cost guards for triggers, sweeps, render retries, rate limits and presence (#233)
