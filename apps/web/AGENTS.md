# APP PACKAGE KNOWLEDGE BASE

**Generated:** 2026-02-17
**Updated:** 2026-10-10 (script locations and type-helper path re-checked)
**Parent:** ../../AGENTS.md

## OVERVIEW

Main React application using TanStack Start + Cloudflare Workers.
For detailed docs (cRPC patterns, TanStack Start patterns, feature structure), see `src/AGENTS.md`.

## COMMANDS

```bash
# From the repo root (vis tasks; apps/web's package.json has no dev:* scripts)
pnpm dev:backend          # Start the Lunora backend (run alongside dev:app)
pnpm dev:app              # Start main app
pnpm build:chat           # Build chat application
pnpm lint:types           # TypeScript check (NOT pnpm typecheck); inside apps/web it is `tsc --noEmit`
```

## KEY ENTRY POINTS

| File                                   | Purpose                          |
| -------------------------------------- | -------------------------------- |
| `src/routes/__root.tsx`                | App root with provider hierarchy |
| `src/lib/lunora/crpc.tsx`              | cRPC context (useCRPC hook)      |
| `src/routes/(chat)/chat/$threadId.tsx` | Thread route entry               |
| `src/features/chat/`                   | All chat UI features             |

## CONVENTIONS

**Backend data comes only through `@/lib/lunora/crpc` (over `@lunora/react`).**
The env var is **`VITE_LUNORA_URL`** (see `src/lib/env.ts` and `src/router.tsx`),
and there is no separate `*_SITE_URL`: one Lunora Worker serves both
`/_lunora/rpc` and `/api/auth/*`. The browser extension uses the same name.

- **cRPC for all backend data**: `useCRPC()` + TanStack Query
- **Actions**: `useAction` from `@/lib/lunora/crpc` (not cRPC query options)
- **skipToken not "skip"**: Use `skipToken` from `@tanstack/react-query` for conditional queries
- **Feature folders**: `src/features/<domain>/` for all domain code
- **TypeScript strict**: Explicit types on all callback params

## ANTI-PATTERNS

- Don't import a second data-client library. The generic helpers `assert`,
  `BetterOmit`, `Expand` and `ErrorMessage` live in
  `src/lib/agent/type-utilities.ts`.
- Don't use `"skip"` string with cRPC queryOptions — use `skipToken` from `@tanstack/react-query`
- Don't bypass authentication hooks
