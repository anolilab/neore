# STORYBOOK

Storybook 10 (`@storybook/react-vite`) for the web app, `packages/ui` and `packages/chat-ui`. Config in
`apps/web/.storybook/`, the mock backend and fixtures here. `pnpm storybook` (port 6006) and `pnpm test:storybook`
from the root; CI runs the second (`test.yml`, job `storybook`).

## HOW A STORY GETS ITS DATA

- **Everything goes over the network to MSW; nothing in the app is stubbed for a story.** `lunora.ts` answers
  `POST /_lunora/rpc` by `functionPath`: `lunora(api.x.y.fn, value | (args) => value)` is typed against the generated
  API, so a backend change breaks `lint:types` here. `lunoraError` / `lunoraPending` give the error and loading states.
- Handlers go in `parameters.msw.handlers` as NAMED groups (`lunora`, `gateway`, `apiKeys`, …); a story replaces a
  group by name. One `lunoraHandlers(...)` per story: spread the shared sets first, the story's own after (later
  wins). Shared sets: `fixtures/user.ts` (preferences, settings, admin flag, paid access; the two settings rows are
  STATEFUL, a write shows on the next read), `fixtures/shell.ts` (header chrome), `fixtures/models.ts` (the gateway's
  `/v1/models`), `fixtures/api-keys.ts`.
- A missing fixture answers `NOT_FOUND` and logs `[storybook] no Lunora fixture for "<path>"`: read the console.
- **Persona** (`session.ts`): `pro` / `free` / `guest` / `signed-out`, from the toolbar or `parameters.persona`.
  `get-session` is a handler, so a persona is only a different answer. A loader waits until better-auth's session
  atom holds the persona before the story renders (`settleSession`); without it a `play` acts as nobody.
- A `play` that edits must wait for the data the edit builds on: `await lunoraAnswered(api.x.y.fn)`.
- Server-only modules are swapped by `.storybook/vite.config.ts` (`@tanstack/react-start`, `lib/auth/server-functions`,
  `lib/posthog/client-state` → `.storybook/mocks/`). Add a module there when a story pulls in Start's server entry
  (the symptom is `Could not resolve '#tanstack-router-entry'` and every story failing at once).

## PAGES

- `pages/*.stories.tsx`, not next to the route: the router generator would read a story in `src/routes` as a route.
- `StoryPage` (`page.tsx`) mounts the REAL route components (`Route.options.component`) as a chain of levels at a URL;
  loaders and `beforeLoad` are left out, the components fetch through `crpc` like everywhere else.

## A11Y

- `a11y.test: "error"` is global: an axe violation fails the story in CI, in light, dark and dark + violet (three
  Vitest projects, `vitest.storybook.config.ts`). A story that cannot pass yet sets `a11y: { test: "todo" }` with a
  comment naming the violation — never relax the global setting.

## GOTCHAS

- Run `pnpm build:packages` in a fresh checkout first: stories import `@neore/ai`, whose `dist` is gitignored.
- Vite re-optimizing mid-run ("dependencies optimized: <name>" then "reloading") fails every test in flight, in
  all four projects. The crawl (`optimizeDeps.entries`) misses packages reached only through a lazy import: add
  `<name>` to `optimizeDeps.include` in `.storybook/vite.config.ts`. On a warm cache a new story can trigger it
  once more; run again, or `rm -rf apps/web/node_modules/.cache/storybook`.
- `.storybook/public/mockServiceWorker.js` is written by `msw` on install (`package.json#msw.workerDirectory`).
