# AUTH FEATURES KNOWLEDGE BASE

**Generated:** 2026-01-23 20:32:15
**Updated:** 2026-10-10 (structure re-checked)
**Parent:** ../../AGENTS.md

## OVERVIEW

Authentication system with Better Auth integration, organization management, and security features.

## STRUCTURE

```text
apps/web/src/features/auth/
├── components/           # Authentication UI components
│   ├── auth/          # Login/signup forms
│   ├── anonymous/      # Anonymous user flows
│   ├── organization/   # Organization management
│   ├── team/           # Team management
│   ├── captcha/        # Captcha widgets
│   └── settings/       # User settings and preferences
│       ├── passkey/   # Passkey authentication
│       ├── two-factor/ # 2FA setup/management
│       ├── api-key/   # API key management
│       ├── account/   # Account settings
│       ├── providers/ # Linked social/OAuth providers
│       └── security/  # Security settings
├── hooks/             # Auth hooks
├── validators/        # Form validation schemas
├── types/             # TypeScript type definitions
└── lib/               # Client auth plumbing (auth-query-provider, auth-ui-provider, guest-session, invite-token)
```

## WHERE TO LOOK

| Task                    | Location                                                 | Notes                          |
| ----------------------- | -------------------------------------------------------- | ------------------------------ |
| Login/signup forms      | components/auth/                                         | Better Auth integration        |
| Organization management | components/organization/                                 | Org CRUD, invitations, members |
| User settings           | components/settings/                                     | Profile, preferences, security |
| Passkey auth            | components/settings/passkey/ # WebAuthn implementation   |
| Two-factor auth         | components/settings/two-factor/ # 2FA setup/verification |
| API key management      | components/settings/api-key/ # Generate/revoke API keys  |
| Form validation         | validators/ # Zod schemas for auth forms                 |
| Type definitions        | types/ # Auth-related TypeScript types                   |

## CONVENTIONS

- **Better Auth integration**: Use Better Auth factories and patterns
- **Route guards**: Use `requireSession` from `@/lib/auth/route-guard` in `beforeLoad`, not a hand-written `isAuthenticated` check — only an answered "no session" may redirect (a failed session read must not sign the user out)
- **Component isolation**: Separate auth flows by feature (login, settings, orgs)
- **Security first**: All settings components follow security best practices
- **Form-driven**: All auth inputs use proper validation schemas

## ANTI-PATTERNS

- Don't bypass Better Auth functions
- Don't store credentials in local storage
- Don't create auth components without proper validation
- Don't mix organization and user auth concerns
- Don't disable security features without user consent

## Session reads (moved from the root AGENTS.md)

- **`<Unauthenticated>` means "no token", not "no session".** The RPC token is
  fetched after the session cookie lands, so a just-signed-in user reads as
  logged-out for a window. Two bugs lived in that gap (auto guest sign-in minting
  a guest over a real session; nothing ever fetching a token for an existing
  session). Both are fixed at the source — never widen a gate to paper over it.
- **A FAILED session read is "unknown", never "signed out".** better-auth
  rate-limits `/api/auth/*` per client IP + path (100 per window, 3 for
  sign-in/up), and its window only resets after a 10 s QUIET gap — sustained
  traffic from one office NAT never gets one. Lunora's identity probe read a
  429 as "nobody" (hiding `<Authenticated>`), and a 429 on `/api/auth/token`
  made the root route redirect to sign-in. Now: `get-session` is exempt
  (`AUTH_RATE_LIMIT_CUSTOM_RULES`, `auth.rate-limit.test.ts`); session reads
  retry through `apps/web/src/lib/auth/session-read.ts` (the probe THROWS when
  exhausted, which Lunora settles as `unreachable` — gate open); the root route
  carries `authStatus`, and guards use `requireSession` (`lib/auth/route-guard.ts`),
  which redirects only on an ANSWERED "no session". A new guard must use it.
- **The browser reads the session ONCE per page load.** Three readers each
  made their own `GET get-session` — better-auth's session atom
  (`authClient.useSession`), the TanStack `["session"]` query
  (`features/auth/hooks/session-user-management.ts`) and Lunora's identity
  probe (`getCurrentUser`, to the BACKEND origin). Both clients' `fetch` now
  answer a plain session read from one shared read on the app origin
  (`lib/auth/shared-session.ts`, `createSharedSessionRead`): joined while in
  flight, reused 10 s, never cached when it failed. Any auth request that may
  change the session (`isSessionChangingRequest`: every non-GET except
  `has-permission`/`check-slug`, plus the verify GETs) drops it when it starts
  and ends, and so does better-auth's cross-tab `storage` broadcast — whose
  listener must stay registered BEFORE better-auth's (client.ts creates it at
  module load). A new way of changing the session outside `authClient` must
  call `getSharedSessionRead()?.invalidate()`. Browser only: on the server the
  module is shared across requests. `session-single-read.test.ts` counts.
