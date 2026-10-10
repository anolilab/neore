# CHAT FEATURES KNOWLEDGE BASE

**Generated:** 2026-01-23 20:32:15
**Updated:** 2026-10-10 (structure re-checked; sidebar tabs: summary, prompts, variables, pins)
**Parent:** ../../AGENTS.md

## OVERVIEW

Core chat functionality with AI-powered conversations, thread management, and real-time messaging.

## STRUCTURE

```text
apps/web/src/features/chat/
├── core/               # Chat logic
│   ├── context/        # chat-context.tsx (chat React context)
│   ├── hooks/          # use-threads.ts, use-current-model.ts, ...
│   ├── utils/          # composer-submit, prompt-queue, mcp, readiness-gate, ...
│   ├── stores/         # chat-ui-store.ts (activeRightSidebarTab), thread-store.ts, ...
│   └── adapters/       # lunora-attachment-adapter.ts (upload + size limits)
├── thread/             # Composer and message UI (message-item.tsx has the pin button)
├── thread-list/        # Sidebar thread list (hierarchical-thread-list.tsx, hooks/, stores/)
├── sidebar/            # thread-sidebar.tsx: right panel tabs summary, prompts, variables, pins
├── pins/               # pins-sidebar-tab.tsx, pin-item.tsx
├── tags/               # Thread tagging system
├── header/             # chat-header.tsx and header actions
├── components/         # Shared chat components (cinema-studio, reference-picker, ...)
├── prompt-improvement/ # AI prompt enhancement
├── sharing/            # Public thread page, share button, use-thread-shard.ts
├── forward/            # Forward selected messages to another thread
├── group/              # Group chats (use-group-chat.ts)
└── link-preview/       # Link preview cards
```

## WHERE TO LOOK

| Task                    | Location                                   | Notes                                         |
| ----------------------- | ------------------------------------------ | --------------------------------------------- |
| Thread management       | core/hooks/use-threads.ts                  | Thread CRUD operations                        |
| AI model integration    | core/hooks/use-current-model.ts            | Model selection and configuration             |
| Message handling        | lib/agent (`toUIMessages`, re-exported)    | Message format conversion                     |
| Prompt improvement      | prompt-improvement/                        | AI-powered prompt enhancement                 |
| Thread tagging          | tags/                                      | Thread categorization                         |
| Chat context            | core/context/chat-context.tsx              | React context for chat state                  |
| **Pin messages**        | **pins/**                                  | **Pin button in message-item.tsx action bar** |
| **Right sidebar tabs**  | **core/stores/chat-ui-store.ts**           | **`activeRightSidebarTab` state + setter**    |
| **Right sidebar panel** | **sidebar/thread-sidebar.tsx**             | **Tabs: summary, prompts, variables, pins**   |

## CONVENTIONS

- **Component hierarchy**: Core logic in core/, UI in components/
- **Hook-driven**: Most functionality via React hooks
- **State management**: Stores for complex state, hooks for simple state
- **Type conversion**: UI message converters for format consistency

## RIGHT SIDEBAR TAB STATE

The `chat-ui-store.ts` manages which tab is active in the right sidebar:

```typescript
// Read current tab
const activeTab = useChatUIStore(selectActiveRightSidebarTab); // default: "summary"

// Switch to pins tab (e.g., after pinning a message)
const setTab = useChatUIStore(selectSetActiveRightSidebarTab);

setTab("pins");
```

Tabs: `"summary"` | `"prompts"` | `"variables"` | `"pins"` (and any future tabs added to thread-sidebar.tsx).

## ANTI-PATTERNS

- Don't bypass thread manager hooks
- Don't directly mutate UI state - use stores/hooks
- Don't mix message formats without converters
- Don't create chat components without proper TypeScript types
