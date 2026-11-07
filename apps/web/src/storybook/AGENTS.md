# STORYBOOK

Storybook 10 (`@storybook/react-vite`) for the web app, `packages/ui` and `packages/chat-ui`. Config in
`apps/web/.storybook/`, the mock backend and fixtures here. `pnpm storybook` (port 6006) and `pnpm test:storybook`
from the root (the vis target `test:storybook`); CI runs it, and the preview deploy publishes the static build.

## HOW A STORY GETS ITS DATA

- **Everything goes over the network to MSW; nothing in the app is stubbed for a story.** `lunora.ts` answers
  `/_lunora/rpc` and `/_lunora/rpc-batch` by `functionPath`: `lunora(api.x.y.fn, value | (args) => value)` is typed
  against the generated API, so a backend change breaks `lint:types` here. `lunoraError` / `lunoraPending` give the
  error and loading states.
- Live subscriptions (`useQuery` from `@lunora/react`) work too: the story client's socket never opens, so Lunora
  polls the same fixtures every 500 ms. A resolver function is called on every poll, so a stateful one updates the
  page live (`fixtures/chat.ts#streamingBody`). `parameters.connection` sets the connection banner.
- Handlers go in `parameters.msw.handlers` as NAMED groups (`lunora`, `gateway`, `stream`, `apiKeys`, `uploads`…); a
  story replaces a group by name. One `lunoraHandlers(...)` per story: spread the shared sets first, the story's own
  after (later wins). Shared sets: `fixtures/user.ts` (preferences, settings, admin flag, paid access, following the
  persona; the settings rows are STATEFUL), `fixtures/shell.ts` (header chrome), `fixtures/chat.ts` (threads,
  messages, everything a thread page reads), `fixtures/models.ts` (the gateway's `/v1/models`), `fixtures/gateway.ts`
  (`/v1/chat`, `/v1/stream`), `fixtures/uploads.ts` (TUS), `fixtures/api-keys.ts`. A new domain gets its own
  `fixtures/<domain>.ts` exporting `<domain>Fixtures(options)`; dates come from `clock.ts` (`ago(2 * DAY)`).
- A missing fixture answers `NOT_FOUND` and logs `[storybook] no Lunora fixture for "<path>"`; an unmocked request
  logs an MSW warning. Read the console: a story is done when neither appears.
- **Persona** (`session.ts`): `pro`, `free`, `guest`, `admin`, `org-member`, `signed-out`, from the toolbar or
  `parameters.persona`. A loader waits until better-auth's session holds it (`settleSession`).
- A `play` that edits must wait for the data the edit builds on: `await lunoraAnswered(api.x.y.fn)`. axe runs after
  the mock backend has gone quiet (`lunoraIdle`), so it sees the page with its data.
- The clock is pinned to `STORY_NOW` (5 Nov 2026, 12:00 UTC); `parameters.now` moves it.
- Server-only modules are swapped by `.storybook/vite.config.ts` (`@tanstack/react-start`, `lib/auth/server-functions`,
  `lib/posthog/client-state`, `next-themes` → `.storybook/mocks/`). Add one there when a story pulls in Start's server
  entry (symptom: `Could not resolve '#tanstack-router-entry'`, every story failing at once).

## WRITING STORIES

- CSF 3, next to the component (`foo.stories.tsx`), `satisfies Meta<typeof Foo>`. Titles by area: `UI/…`, `Chat/…`,
  `Settings/…`, `Auth/…`, `Pages/…`. One story per state that looks or behaves differently: default, empty, loading,
  error, long content, disabled, each persona that changes it. A `play` asserts the state is what the name says.
- Query by role and accessible name (`findByRole("button", { name: … })`); a missing name is an a11y bug to fix.

## PAGES

- `pages/*.stories.tsx`, not next to the route: the router generator would read a story in `src/routes` as a route.
- `StoryPage` (`page.tsx`) mounts the REAL routes as a chain of levels at a URL: `{ path: "chat/$threadId", route:
ThreadRoute }`, `{ id: "(chat)", route: ChatLayoutRoute }` for a pathless group. Their component, search validation
  and loader run, with the story's clients in the router context; `beforeLoad` guards do not.

## A11Y

- `a11y.test: "error"` is global: an axe violation fails the story in CI, in light, dark + violet, a 390 px phone and
  RTL (four Vitest projects, `vitest.storybook.config.ts`). Fix small ones (a missing `aria-label`); otherwise mark
  the story `a11y: { test: "todo" }` with a comment naming the rule and an issue (#546 `text-primary`, #547 sidebar,
  #548 chat) — never relax the global setting.

## GOTCHAS

- Run `pnpm build:packages` in a fresh checkout first: stories import `@neore/ai`, whose `dist` is gitignored.
- Vite re-optimizing mid-run ("dependencies optimized: <name>" then "reloading") fails every test in flight. The crawl
  (`optimizeDeps.entries`) misses packages reached only through a lazy import: add `<name>` to `optimizeDeps.include`
  in `.storybook/vite.config.ts`. On a warm cache a new story can trigger it once; run again.
- New UI strings need `pnpm --filter @neore/web run translate:extract` and `translate:compile`.
- `.storybook/public/mockServiceWorker.js` is written by `msw` on install (`package.json#msw.workerDirectory`).
