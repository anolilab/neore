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
