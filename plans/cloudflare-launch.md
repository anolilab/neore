# Cloudflare launch runbook

Status (2026-10-11): set on both `production` and `preview`: the generated
secrets, `ADMIN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (user token
`neore-ci-deploy`, account-scoped plus DNS and routes on `neore.ai`), `R2_ENDPOINT`,
`MAIL_FROM` (`noreply@mail.neore.ai`), the Turnstile pair, and the origins (`VITE_SITE_URL`,
`VITE_LUNORA_URL`, `VITE_LLM_GATEWAY_URL`). Production uses `app.`, `api.`, `llm.`
on `neore.ai`; preview uses `preview.`, `api-preview.`, `llm-preview.`.
**Still open:** `OPENROUTER_API_KEY` is still the `placeholder` value (the smoke
test needs a real provider key). Turnstile is set in both environments: widget
`neore-chat` (site key in `VITE_TURNSTILE_SITE_KEY`, secret in `TURNSTILE_SECRET_KEY`),
domains `app.neore.ai` and `preview.neore.ai`. No `v*` tag
exists, and the deploy has not run. Everything below is what has to be true
before the first deploy.

Deploys are CI's job (`AGENTS.md`). Do not run `pnpm run deploy` locally.

## 1. Verified locally (2026-10-11)

| Gate | Result |
| --- | --- |
| `pnpm build:packages` | passes |
| `pnpm run lint:types:deploy` (`tsconfig.deploy.json`) | passes |
| `pnpm run lint:eslint:deploy` | passes |
| `backend`: `deploy-bindings`, `deploy-bundle`, `deploy-env-bindings` tests | 121 / 121 |
| `services/document-parser/build/` | absent locally; CI builds it (`build:worker`) |

CI setup: `deploy.yml` uses `anolilab/workflows/step/setup@main`, the same
reference lint and test use, and both are green. `release.yml` pushes the
`v<version>` tag when the release PR is merged, with the org secret
`SEMANTIC_RELEASE_GITHUB_TOKEN` (a PAT), so the tag triggers `deploy.yml`. A
`GITHUB_TOKEN` tag would not. Check that the PAT has not expired before relying on it.

## 2. Secrets (GitHub environment secrets, on `production` AND `preview`)

Set them on the environment, not the repo, because `deploy.yml` declares
`environment:`. Values never go in chat, files or stdout.

### 2a. Hard requirements (`REQUIRED_DEPLOY_ENV`, `alchemy.run.ts`)

The deploy refuses to start if any is blank.

| Secret | How to get it |
| --- | --- |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 48` |
| `ENCRYPTION_KEY` | `openssl rand -base64 48` (≥ 32 chars). Treat it as stable: it encrypts stored data. |
| `LLM_GATEWAY_SIGNING_SECRET` | `openssl rand -hex 32` (gateway ↔ backend, shared) |
| `LUNORA_ADMIN_TOKEN` | `openssl rand -hex 32`. Without it no job runs. |
| `STORAGE_SIGNING_SECRET` | `openssl rand -hex 32` |
| `R2_ENDPOINT` | `https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com` (derived) |
| `SITE_URL` | the app origin, e.g. `https://neore.ai` (user decision) |
| `BACKEND_PUBLIC_ORIGIN` ← `VITE_LUNORA_URL` | the backend origin (user decision, see §4) |
| `LLM_GATEWAY_URL` ← `VITE_LLM_GATEWAY_URL` | the gateway origin (user decision, see §4) |

### 2b. Build-time (apps/web `env.ts` requires them, or the build fails)

`VITE_LUNORA_URL`, `VITE_SITE_URL`, `VITE_LLM_GATEWAY_URL`. The first must
equal `PUBLIC_ORIGIN`, or every bearer token verifies as anonymous with no
error. Optional: `VITE_POSTHOG_*`, `VITE_C15T_*`, `VITE_DPO_*`,
`VITE_PRIVACY_POLICY_URL`.

### 2c. Cloudflare access

| Secret | Notes |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | User creates it (see §3). Not set at org level, so set it per environment. |
| `CLOUDFLARE_ACCOUNT_ID` | User provides it. Not set at org level. |

### 2d. Needed to be useful at launch (user decisions)

| Secret | Why |
| --- | --- |
| `ADMIN` | Comma-separated admin emails. Nobody can administer, or register, without it. |
| `MAIL_FROM` | **Required for production** (`alchemy.run.ts` refuses without it). |
| `RESEND_API_KEY` | Sends through Resend. Set it when the sender domain is not on Cloudflare Email Service. With it set, `alchemy.run.ts` does not bind Email Service at all. |
| Provider key (≥ 1) | **Required for the smoke test.** `MOCK_LLM` exists only in the local gateway's `.dev.vars`; nothing in `alchemy.run.ts` or `deploy.yml` binds it, so a deployed stage has no mock model. |

Mail is not needed to sign up: `requireEmailVerification` is `false`
(`backend/lunora/auth.ts`), and invitations return their link without mailing
it. Mail is needed for password reset, magic links, OTP and org invites.
**Unverified:** whether an `EmailSender` binding fails to create when
`MAIL_FROM`'s domain is not verified. Check that on the preview run.
| `TURNSTILE_SECRET_KEY` + `VITE_TURNSTILE_SITE_KEY` | Set both or neither (the deploy refuses a mismatch). Neither = no captcha. |
| Provider keys (`OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `FAL_API_KEY`, …) | Optional. Without them the matching models are missing. |
| Google / GitHub / OIDC sign-in (`GOOGLE_CLIENT_ID`, `AUTH_GITHUB_*`, `OIDC_*`, …) | Optional. |
| `CREEM_*` | Optional. Billing reports "not configured" without them. |
| `VAPID_*` | Optional. Push is off without them. |

Everything else that `deploy.yml` passes through can stay unset. An unset
GitHub secret expands to `""`, which the schema accepts.

**`JWKS` can stay unset.** The schema reads it as a plain string and nothing
in `backend/lunora` consumes it.

### 2e. Setting them without the value touching the transcript

```bash
# generated secret — the value goes straight into gh, never to stdout
for env in production preview; do
  openssl rand -hex 32 | gh secret set LUNORA_ADMIN_TOKEN --env "$env" --repo anolilab/neore
done

# user-supplied secret — gh prompts for it
gh secret set MAIL_FROM --env production --repo anolilab/neore
```

Generate a fresh value per environment for each generated secret in §2a. The
only pairing that matters is inside one environment: the gateway and the
backend must hold the same `LLM_GATEWAY_SIGNING_SECRET`, and that is what the
deploy sends to both. Preview and production values may differ.

## 3. Cloudflare account prerequisites

Resources Alchemy creates (from `alchemy.run.ts`): Workers (`neore-chat`,
`neore-chat-preview`, backend, llm-gateway, document-parser, browser-renderer,
nsfw-checker), D1 (2), R2 (3 buckets), KV (3 namespaces), Queues (6,
incl. dead-letter), Vectorize indexes (plus a metadata index), Durable Objects
(shard, scheduler, shard registry, ...), a Workflow, AI binding, Email sender,
and custom domains.

Before the first deploy:

1. **Workers Paid plan**: Queues and Vectorize require it.
2. **R2 activated** in the dashboard.
3. **State store.** Alchemy 2 keeps state in a Worker + Durable Object in this
   account (`Cloudflare.state()`), created by the first `alchemy deploy --yes` in CI,
   with its key in the account's Secrets Store. Nothing to create up front, but the
   token needs Secrets Store access (step 4). Run `Deploy` with `dry_run` on `preview`
   first: it creates only the state store.
4. **API token** with: Workers Scripts (Edit), Workers KV (Edit), D1 (Edit),
   R2 (Edit), Queues (Edit), Vectorize (Edit), Workers AI (Edit), Email Sending
   (Edit), Secrets Store (Edit; the state store), Workers Routes / Custom Domains (Edit) on the zone, Zone (Read).
   Scopes are from the resource list above, not from Alchemy's docs. Confirm
   them on the preview run and widen only if the error names one.
5. **Zone** (only if using a custom domain): it must be ACTIVE in this account.
   A `pending` zone fails the deploy. See §4.
6. **Email**: if `RESEND_API_KEY` stays empty, `MAIL_FROM` must be on a
   verified Cloudflare Email Service sending domain.

## 4. Origin decision (blocks the first deploy)

The three origins are compiled into the app and checked by the backend (JWT
`iss`/`aud`). They must be set before the build, and the Workers do not exist
yet, so the URLs have to be written down first. The Worker names are fixed by
`alchemy.run.ts`:

| Worker | production | preview | public? |
| --- | --- | --- | --- |
| web (`SITE_URL`) | `neore-chat` | `neore-chat-preview` | yes |
| backend (`BACKEND_PUBLIC_ORIGIN`) | `neore-backend` | `neore-backend-preview` | yes |
| gateway (`LLM_GATEWAY_URL`) | `llm-gateway` | `llm-gateway-preview` | yes |
| document-parser, nsfw-checker, browser-renderer | — | — | **private** (`url: false`) |

Two options:

- **workers.dev first.** No zone needed. Each origin is
  `https://<name>.<account-subdomain>.workers.dev`, so claim the account's
  workers.dev subdomain first. `customDomain()` returns nothing for these.
  Mail cannot be verified on workers.dev, so use Resend (§2d) for this option.
- **Custom zone** (e.g. `neore.ai`). The zone must be ACTIVE. The cutover is:
  deploy on workers.dev, move the zone, flip the three secrets, redeploy.

## 5. Runbook

1. **Confirm §2 and §3** (every §2a secret set on `preview`; §3 steps 1–4 done).
2. **Preview deploy**:
   `gh workflow run deploy.yml -f environment=preview`, then watch it with
   `gh run watch`. Read the Alchemy output for the website URL.
3. **Smoke test** the preview origin:
   `curl -fsS https://<backend-origin>/api/health`
4. **Seed invitations** (sign-up needs an invitation, and nobody can get one
   without this):
   ```bash
   curl -fsS -X POST "$BACKEND_PUBLIC_ORIGIN/admin/seed-invitations" \
        -H "Authorization: Bearer $LUNORA_ADMIN_TOKEN"
   ```
   It is idempotent. It returns a `signUpUrl` for each `ADMIN` address.
5. **Sign up** with an `ADMIN` address through the preview site. Chat end to end.
   This needs a provider key on the preview stage: `MOCK_LLM` is read only from a
   local `.dev.vars`, so a deployed stage cannot use the mock model.
6. **Production**: set the §2 secrets on `production`, then either let
   the release PR merge push a `v<version>` tag (it uses the org PAT, §1) or run
   `gh workflow run deploy.yml -f environment=production`. Repeat step 4 once
   after the production deploy.

## 6. Known risks

- **Changing `ENCRYPTION_KEY` breaks stored data.** Set it once.
- **The deploy job uses `setup@main`.** A workflows-repo change can break it
  without a change here. Pin it once the first deploy is green.
- **Custom domain + pending zone** fails the whole deploy late. Check the zone
  before starting.
- **First deploy writes to production state** if `environment=production` is
  chosen. Do the preview run first.
- **`production` is protected**: a required reviewer, and only `main` and `v*` tags may
  deploy to it. `preview` has neither, so its secrets are reachable by anyone who can
  dispatch a workflow on any branch.
