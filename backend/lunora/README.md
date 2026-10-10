# Lunora Backend API

This directory contains the Lunora backend implementation for the application. It provides a serverless backend with real-time capabilities, authentication, AI chat functionality, file storage, and more.

## Overview

The backend is organized into feature modules, each containing related functions, schemas, and utilities. All modules follow consistent patterns for authentication, validation, rate limiting, and error handling.

## Directory Structure

### Root Files

- `schema.ts` - Main schema definition that aggregates all module schemas
- `../lunora.config.ts` - Lunora project config (service bindings), one level up in `backend/`
- `auth.ts` - Better Auth component configuration and setup
- `http.ts` - HTTP endpoints using Hono router (chat streaming, auth routes, webhooks)
- `init.ts` - Database initialization function (runs on dev server startup)
- `crons.ts` - Scheduled tasks (e.g., cleanup jobs)
- `env.ts` - Environment variable exports
- `file.ts` - File upload action
- `auth.config.ts` - Auth configuration helpers

### Module Directories

#### `auth/` - Authentication and Authorization

Core authentication and user management functionality.

**Files:**

- `functions.ts` - Auth function factories (`createAuthQuery`, `createAuthMutation`, `createAuthAction`, etc.) and session management
- `organization.ts` - Organization management (create, update, delete, invitations, members)
- `permissions.ts` - Permission system and role definitions
- `schema.ts` - Auth-related table schemas
- `fields.ts` - User settings and preferences field definitions
- `lib/helper.ts` - Auth helper functions (`requireUserId`, `getCurrentUserWithOrganization`, etc.)
- `lib/getUserPreferences.ts` - User preference retrieval
- `lib/roleGuard.ts` - Role-based access control guards
- `lib/premiumGuard.ts` - Premium subscription guards

**Key Functions:**

- `createAuthQuery()` - Creates authenticated queries with user context
- `createAuthMutation()` - Creates authenticated mutations with user context
- `createAuthAction()` - Creates authenticated actions with user context
- `createPublicQuery()` - Creates public queries (no auth required)
- `createPublicMutation()` - Creates public mutations (no auth required)
- `getSessionUser()` - Gets current user with organization context

**Usage Example:**

```typescript
export const myQuery = createAuthQuery()({
    args: {
        id: z.string(),
    },
    handler: async (context, args) =>
        // ctx.user is available with userId, email, activeOrganization, etc.
        context.db
            .query("myTable")
            .filter((q) => q.eq("userId", context.user.userId))
            .collect(),
});
```

#### `chat/` - Chat and Messaging

AI-powered chat functionality with thread management and message handling.

**Files:**

- `functions.ts` - Chat functions (create thread, get messages, pin threads, etc.)
- `http.ts` - HTTP endpoints for chat streaming and prompt improvement
- `sharing.ts` - Thread sharing and access control
- `schema.ts` - Chat-related table schemas (threads, messages)
- Thread title generation prompt is now exported from `@neore/ai/prompts`

**Key Functions:**

- `createThread` - Create a new chat thread
- `getThreadMessages` - Get paginated messages for a thread
- `pinThread` - Pin a thread to the top
- `createTitleChat` - Generate thread title from first message (internal action)
- `createSummarizeChat` - Generate thread summary (internal action)

**HTTP Endpoints:**

- `POST /chat/stream` - Stream chat responses
- `POST /chat/improve-prompt` - Improve user prompts

#### `ai/` - AI Agent Configuration

AI agent setup, model configuration, and middleware.

**Files:**

- `functions.ts` - AI-related functions
- `lib/agents.ts` - Agent factory and configuration
- `lib/models.ts` - Model configuration and selection
- `middlewares/cacheMiddleware.ts` - Caching middleware for AI responses
- `prompts/getSystemPrompt.ts` - System prompt generation
- `schema.ts` - AI-related table schemas

**Key Functions:**

- `getAgent()` - Get configured AI agent instance

#### `email/` - Email Functionality

Email sending and template management.

**Files:**

- `functions.tsx` - Email sending functions and Resend integration
- `schema.ts` - Email-related table schemas
- `templates/` - React-based email templates
    - `baseEmail.tsx` - Base email component
    - `welcomeEmail.tsx` - Welcome email
    - `magicLink.tsx` - Magic link authentication
    - `organizationInvite.tsx` - Organization invitation
    - `resetPassword.tsx` - Password reset
    - `verifyEmail.tsx` - Email verification
    - `sendVerificationOtp.tsx` - OTP verification
    - `verifyOtp.tsx` - OTP verification confirmation
    - `subscriptionEmail.tsx` - Subscription notifications

**Key Functions:**

- `queueEmail()` (`mailer.ts`) - Render and queue an email through `@lunora/mail` (Cloudflare Email Service, or Resend)
- `handleResendWebhook()` - Handle Resend webhook events

#### `vault/` - File Vault

Secure file storage and management.

**Files:**

- `functions.ts` - Vault file operations
- `schema.ts` - Vault table schemas
- `lib/file_constants.ts` - File-related constants
- `lib/filename.ts` - Filename utilities

#### `betterAuth/` - Better Auth Integration

Better Auth component configuration and schema definitions.

**Files:**

- `schema.ts` - Better Auth table schemas
- `generatedSchema.ts` - Auto-generated schema from Better Auth
- `adapter.ts` - Database adapter configuration
- `auth.ts` - Better Auth client setup

#### `lib/` - Shared Utilities

Common utilities used across modules.

**Files:**

- `rateLimiter.ts` - Rate limiting configuration and guards
- `encryption.ts` - Encryption utilities
- `errors.ts` - Custom error classes
- `errorCodes.ts` - Error code constants
- `systemFields.ts` - System field definitions
- `polyfills.ts` - Polyfills for compatibility

**Rate Limiting:**
The rate limiter supports tiered limits (free, premium, public) and specific limits for various operations. Use `rateLimitGuard` in function factories or `rateLimiter.limit()` directly.

## API Patterns

### Function Factories

The codebase uses function factories to create consistent, type-safe Lunora functions with built-in authentication, validation, and rate limiting.

**Available Factories:**

- `createAuthQuery()` - Authenticated queries (requires user)
- `createAuthMutation()` - Authenticated mutations (requires user)
- `createAuthAction()` - Authenticated actions (requires user)
- `createPublicQuery()` - Public queries (no auth required)
- `createPublicMutation()` - Public mutations (no auth required)
- `createPublicAction()` - Public actions (no auth required)
- `createInternalQuery()` - Internal queries (server-only)
- `createInternalMutation()` - Internal mutations (server-only)
- `createInternalAction()` - Internal actions (server-only)
- `createAuthPaginatedQuery()` - Authenticated paginated queries
- `createPublicPaginatedQuery()` - Public paginated queries

**Factory Options:**

```typescript
createAuthMutation({
    devOnly: false, // Only run in dev environment
    rateLimit: "organization/create", // Rate limit key
    role: "admin", // Require admin role
})();
```

### Validation

All functions use Zod schemas for input validation. Import from `zod/v4`:

```typescript
import z from "zod/v4";

args: {
    id: z.string(),
    count: z.number().min(0),
    tags: z.array(z.string()).optional(),
}
```

For table IDs, use `v.id("threads")` from `lunorash/server` (see `schema.ts`).

### Return Types

Always define return types using Zod schemas:

```typescript
returns: z.object({
    createdAt: z.number(),
    id: z.string(),
    name: z.string(),
}).strict();
```

### Error Handling

Use `LunoraError` for application errors:

```typescript
import { LunoraError } from "lunorash/server";

throw new LunoraError("NOT_FOUND", "Resource not found");
```

### Context Access

In authenticated functions, access user data via `ctx.user`:

```typescript
handler: async (context, args) => {
    const { userId } = context.user;
    const { email } = context.user;
    const activeOrg = context.user.activeOrganization;
    // ...
};
```

## Schema Organization

Schemas are organized by feature module. Each module has its own `schema.ts` file that exports table definitions. The main `schema.ts` aggregates all module schemas.

**Adding a New Table:**

1. Add table definition to the appropriate module's `schema.ts`:

```typescript
// chat/schema.ts
export default {
    myTable: defineTable({
        field1: v.string(),
        field2: v.number(),
    })
        .index("by_field1", ["field1"])
        .searchIndex("field1", { searchField: "field1" }),
};
```

2. Import and include in main `schema.ts`:

```typescript
import chatTables from "./chat/schema";

const schema = defineSchema({
    ...chatTables,
    // ... other modules
});
```

## Authentication

Authentication is handled by Better Auth via the `authComponent`. The system supports:

- Email/password authentication
- Anonymous users
- Magic links
- Email OTP
- Google OAuth
- Two-factor authentication
- Organization-based access control

**Getting Current User:**

```typescript
import { getSessionUser } from "./auth/functions";

const user = await getSessionUser(ctx);

if (!user) {
    // Not authenticated
}
```

**Requiring Authentication:**

```typescript
import { requireUserId } from "./auth/lib/helper";

const userId = await requireUserId(ctx);
// Throws if not authenticated
```

### Static JWKS (Optional Performance Optimization)

Static JWKS is an experimental feature that speeds up token validation by avoiding HTTP requests to fetch the JWKS. This is **optional** - the system will work fine without it, but it provides better performance.

**How it works:**

- **Without static JWKS**: The system makes two HTTP requests per token validation (OIDC discovery + JWKS fetch)
- **With static JWKS**: Token validation is faster as it uses the cached JWKS from the environment variable
- **Automatic rotation**: The system has `jwksRotateOnTokenGenerationError: true` configured, which automatically rotates keys in the database when needed

**When to update:**

- **Initially**: Set it up once for the performance benefit
- **Periodically**: Update it occasionally (e.g., monthly) to keep it fresh
- **On errors**: If you notice authentication errors related to token validation, update it

**Note**: The automatic rotation handles key rotation in the database, but the `JWKS` environment variable won't update itself automatically. You only need to manually update it if you want to maintain the performance benefit after rotation occurs.

## Rate Limiting

Rate limiting is configured in `lib/rateLimiter.ts` and applied via function factories or manually.

**Using in Function Factory:**

```typescript
export const myMutation = createAuthMutation({
    rateLimit: "myFeature/create",
})({
    // ...
});
```

**Manual Rate Limiting:**

```typescript
import { rateLimiter } from "./lib/rateLimiter";

await rateLimiter.limit(ctx, "myFeature/action", {
    count: 1,
    key: ctx.user.userId,
    throws: true,
});
```

## HTTP Endpoints

HTTP endpoints are defined in `http.ts` using Hono router. They handle:

- Authentication routes (`/api/auth/*`)
- Chat streaming (`POST /chat/stream`)
- Prompt improvement (`POST /chat/improve-prompt`)
- Email webhooks (`POST /email/resend/webhook`)

**Adding a New HTTP Endpoint:**

1. Create handler function in appropriate module:

```typescript
// chat/http.ts
export const myHttpAction = async (context: ActionContext, request: Request) =>
    // Handle request
    Response.json({ success: true });
```

2. Register in `http.ts`:

```typescript
import { myHttpAction } from "./chat/http";

app.post("/my-endpoint", async (c) => myHttpAction(c.env, c.req.raw));
```

## Scheduled Tasks

Scheduled tasks are defined in `crons.ts`:

```typescript
crons.interval("taskName", { hours: 1 }, internal.module.function, {});
```

## Environment Variables

Environment variables are exported from `env.ts`. Required variables include:

- `SITE_URL` - Application site URL
- `PUBLIC_ORIGIN` - this Worker's own public origin
- `RESEND_API_KEY` - Resend API key for emails
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - Google OAuth credentials
- API keys for AI providers (OpenAI, Anthropic, Google, Groq, FAL)
- R2 storage credentials (if using R2)

## Adding New Functionality

### 1. Create a New Module

Create a new directory with:

- `functions.ts` - Public functions
- `schema.ts` - Table schemas
- `lib/` - Module-specific utilities (optional)

### 2. Define Schema

```typescript
// myModule/schema.ts
import { defineTable, v } from "lunorash/server";

export default {
    myTable: defineTable({
        createdAt: v.number(),
        name: v.string(),
    }).index("by_name", ["name"]),
};
```

### 3. Export Functions

```typescript
// myModule/functions.ts
import z from "zod/v4";

import { createAuthMutation } from "../auth/functions";

export const createItem = createAuthMutation()({
    args: {
        name: z.string(),
    },
    handler: async (context, args) => {
        const id = await context.db.insert("myTable", {
            createdAt: Date.now(),
            name: args.name,
        });

        return id;
    },
    returns: z.string(),
});
```

### 4. Update Main Schema

```typescript
// schema.ts
import myModuleTables from "./myModule/schema";

const schema = defineSchema({
    ...myModuleTables,
    // ... existing modules
});
```

## Best Practices

1. **Always use function factories** - They provide consistent authentication, validation, and error handling
2. **Define return types** - Always specify `returns` schema for type safety
3. **Use Zod for validation** - Consistent validation across all functions
4. **Handle errors gracefully** - Use `LunoraError` with appropriate error codes
5. **Index your queries** - Add appropriate indexes in schema definitions
6. **Rate limit public endpoints** - Protect against abuse
7. **Use internal functions** - For server-only operations that shouldn't be exposed
8. **Document complex logic** - Add comments for non-obvious implementations
9. **Follow naming conventions** - Use camelCase for functions, PascalCase for types
10. **Keep functions focused** - Each function should do one thing well

## Testing

Test files should be placed alongside the code they test (e.g., `sharing.test.ts`). Use `lunoraTest` from `@lunora/testing` for function testing.

## Type Safety

The codebase uses TypeScript with strict type checking. Types are generated automatically from schemas in `_generated/`. Always import types from `_generated/dataModel`:

```typescript
import type { Id } from "./_generated/dataModel";

const threadId: Id<"threads"> = "...";
```

## Migration Notes

- The codebase uses Better Auth for authentication
- User IDs come from Better Auth's `_id` field (not a separate `userId` field)
- Organization management is handled via Better Auth's organization plugin
- Rate limiting uses `lunorash/ratelimit` (see `lib/rate-limiter.ts`)
- AI functionality calls the `ai` SDK directly (no agent component)
