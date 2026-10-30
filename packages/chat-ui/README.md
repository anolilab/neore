# @neore/chat-ui

Presentational chat primitives shared by the web app, the browser extension and
the mobile app: the message list and items, the composer, the thread list, the
model picker, the org switcher and the login form, plus the message/thread
types and a few text utilities they share. Private; it is consumed as
TypeScript source (no build step).

The package takes data and callbacks as props. It has **no backend, auth or
router imports** (no `@lunora/*`, `@neore/backend`, better-auth or TanStack
Router): each app wires its own data layer around these components. Keep it
that way, because the extension and the mobile app cannot carry the web app's
router or generated API. Its only workspace dependencies are `@neore/ai` (the
`GatewayModel` type from `@neore/ai/models` and a little of `@neore/ai/gateway`) and `@neore/ui` (base components).

Used by `apps/web` (most call sites), `apps/browser-extension` and
`apps/mobile`.

## Exports

From `package.json#exports`:

| Path                            | Maps to                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@neore/chat-ui`                | `src/index.ts`: `LoginForm`, `ChatView`, `Composer`, `MessageItem`, `MessageList`, `AutoContinueStatus`, `BrowserPanel`, `ModelPicker`, `ModelPickerButton`, `OrgSwitcher`, `ThreadItem`, `ThreadList`, the model-picker helpers and their types |
| `@neore/chat-ui/auth/*`         | `src/auth/*.tsx` (`login-form`)                                                                                                                                                                                                                  |
| `@neore/chat-ui/chat/*`         | `src/chat/*.tsx`: `chat-view`, `composer`, `message-item`, `message-list`, `message-content`, `document-artifact`, `presentation-artifact`, `mcp-app-view`, `speaker-chip`, `page-context-chip`, `browser-panel`, `auto-continue-status`         |
| `@neore/chat-ui/threads/*`      | `src/threads/*.tsx` (`thread-item`, `thread-list`)                                                                                                                                                                                               |
| `@neore/chat-ui/model-picker/*` | `src/model-picker/*.tsx`; `model-picker/utils` is the `.ts` helpers (`groupModelsByCreator`, `filterModelsByQuery`, `findModelById`, `getModelCapabilities`, …)                                                                                  |
| `@neore/chat-ui/org-switcher/*` | `src/org-switcher/*.tsx`                                                                                                                                                                                                                         |
| `@neore/chat-ui/types`          | `src/types/index.ts`: message, sandbox and thread types, `GatewayModel`                                                                                                                                                                          |
| `@neore/chat-ui/utils/*`        | `src/utils/*.ts`: `cn`, `citation-marker`, `markdown-text`, `page-context`, `stream-line`, `sandbox-files`, `mcp-tool-name`, `device-tool-name`                                                                                                  |

```tsx
// apps/web/src/features/chat/sharing/shared-thread-page.tsx
import MessageItem from "@neore/chat-ui/chat/message-item";

// apps/web/src/features/devices/components/device-tool-call.tsx
import { resolveDeviceToolName } from "@neore/chat-ui/utils/device-tool-name";
```

`resolveDeviceToolName` recognises the `device_<tag>__<tool>` runtime name of a
tool that runs on the user's own computer; the chat renders those rows
differently (`plans/device-execution.md`).

## Things to know

- Strings go through Lingui (`@lingui/react`); the catalogs live in the apps,
  not here.
- `MessageItem` and `MessageList` are `memo`-wrapped and rows are memoised on
  message identity. A prop that changes on every live push re-renders every row of a
  long thread (root `CLAUDE.md`, "Chat rows are memoized on message IDENTITY").
- KaTeX and Mermaid must stay off the startup path: reach them only through
  `@neore/ui/hooks/use-streamdown-plugins`, never a static import here.
- Components that use destructuring defaults are skipped by the React Compiler
  in this repo's current setup; see root `CLAUDE.md` before "fixing" that.

## Development

```bash
pnpm --filter @neore/chat-ui run lint:types   # tsc --noEmit
pnpm --filter @neore/chat-ui run test         # vitest run (the utils have tests)
pnpm --filter @neore/chat-ui run lint:eslint
pnpm --filter @neore/chat-ui run lint:prettier
```

With `vis`, target the project by its `package.json` name:
`pnpm vis run lint:types --projects=@neore/chat-ui`.
