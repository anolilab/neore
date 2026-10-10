# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Email **security@neore.ai** with:

- a description of the issue and its impact,
- steps to reproduce, or a proof of concept,
- the affected component (for example `backend/lunora`, `services/llm-gateway`, `apps/web`) and commit,
- your contact details, if you want credit or follow-up.

We aim to acknowledge reports within 3 working days and to keep you informed while the issue is fixed. Please give us a reasonable window to ship a fix before disclosing publicly.

## Scope

In scope: this repository's code, including the Lunora backend, the LLM gateway, the web app and the browser extension.

Out of scope: denial-of-service testing against the hosted service, social engineering of staff, and findings that require physical access to a user's device.

## Secrets

Never commit real credentials. Local secrets belong in `backend/.dev.vars` and `apps/web/.env`, which are git-ignored. If you find a credential in the repository or its history, report it through the same address so it can be rotated.
