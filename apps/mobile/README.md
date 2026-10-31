# Neore mobile

`@neore/mobile` is the Expo (React Native 0.88, Expo Router) client for iOS and
Android. It is early: sign-in, a thread list, reading a thread and streaming a
reply. Scope and status are tracked in
[`plans/desktop-and-mobile-apps.md`](../../plans/desktop-and-mobile-apps.md) and
[`plans/mobile-phase-4-slices.md`](../../plans/mobile-phase-4-slices.md).

## How it talks to the stack

| Concern | Path                                                                                               |
| ------- | -------------------------------------------------------------------------------------------------- |
| Data    | `@lunora/client` against the backend (`EXPO_PUBLIC_LUNORA_URL`), through `src/lib/lunora.ts`       |
| Sign-in | The web app's `/auth/extension` page in the system browser, PKCE, then the extension grant         |
| Chat    | `POST /v1/chat` on the gateway starts a reply, `POST /v1/stream` relays it as NDJSON (`src/chat/`) |
| Storage | The grant lives in the OS secure store (`expo-secure-store`); the Lunora cache is in memory only   |

Streaming goes through `expo/fetch` (`src/lib/streaming-fetch.ts`): React
Native's global `fetch` exposes no readable body.

The workspace packages (`@neore/client-runtime`, `@neore/backend`, `@neore/chat-ui`)
are TypeScript source, so `metro.config.js` watches the monorepo root.

## Configuration

Create `apps/mobile/.env` (nothing writes it for you; `scripts/dev-setup.js`
does not cover this app). All three are required, and a missing one shows an
error screen at startup instead of calling `undefined`:

| Variable                      | Value                                                     |
| ----------------------------- | --------------------------------------------------------- |
| `EXPO_PUBLIC_APP_URL`         | The web app origin (serves the sign-in page)              |
| `EXPO_PUBLIC_LUNORA_URL`      | The backend origin (the web app's `VITE_LUNORA_URL`)      |
| `EXPO_PUBLIC_LLM_GATEWAY_URL` | The gateway origin (the web app's `VITE_LLM_GATEWAY_URL`) |

`localhost` works in the iOS Simulator, which shares the host's loopback. An
Android emulator reaches the host at `10.0.2.2`, and a physical device needs a
LAN address.

### Backend side of sign-in

The app redirects to `neore-mobile://auth/callback` (`src/lib/auth-config.ts`).
The backend admits it only when it is listed, and drops it with a warning
otherwise, so sign-in fails. A set list replaces the Firefox extension
default rather than adding to it, so keep that entry if you use it:

```dotenv
# backend/.dev.vars
TRUSTED_EXTENSION_REDIRECT_URIS=https://c64d88ed4645bb5915bc267506fbc3dcd4a1da90.extensions.allizom.org/,neore-mobile://auth/callback
```

The URI must match `MOBILE_REDIRECT_URI` in
`backend/lunora/lib/extension-origins.ts` exactly.

## Run

```bash
pnpm --filter @neore/mobile start       # expo start (Metro)
pnpm --filter @neore/mobile ios         # expo run:ios, needs Xcode
pnpm --filter @neore/mobile android     # expo run:android, needs the Android SDK
```

Start the backend first (`pnpm dev`; the port map is in the root `CLAUDE.md`).
`expo run:*` generates the native `ios/` and `android/` projects, which are not in the tree.

## Test, lint, build

```bash
pnpm --filter @neore/mobile test        # vitest: auth grant, stream relay, chat API
pnpm --filter @neore/mobile lint:types
pnpm --filter @neore/mobile lint:eslint     # there is no prettier script in this package
pnpm --filter @neore/mobile build       # expo export for both platforms -> dist/
```

`eas.json` defines the `development`, `preview` and `production` EAS build
profiles (each with an update channel of the same name); there is no CI job for
them yet.
