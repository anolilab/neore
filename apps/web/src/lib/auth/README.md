# Auth Module File Organization

This module follows TanStack Start file naming conventions for clear separation of server and client code.

## File Conventions

| Suffix          | Purpose                                   | Safe to Import                    | Example             |
| --------------- | ----------------------------------------- | --------------------------------- | ------------------- |
| `.server.ts`    | Server-only code (DB, secrets, sessions)  | ❌ Client (build error)           | `auth.server.ts`    |
| `.functions.ts` | Server function wrappers (RPC endpoints)  | ✅ Client (auto-converted to RPC) | `auth.functions.ts` |
| `.client.ts`    | Client-only code (browser APIs, UI utils) | ❌ Server (runtime error)         | `auth.client.ts`    |
| `.ts`           | Shared types and utilities                | ✅ Anywhere                       | `types.ts`          |

## Current Files

### Server-Only (`*.server.ts`)

- `server.ts` - Better Auth server configuration, token handling
    - Future: Rename to `auth.server.ts` for clarity

### Server Functions (`*.functions.ts`)

- `server-functions.ts` - Server function wrappers for RPC
    - Future: Rename to `auth.functions.ts` for consistency

### Client-Only (`*.client.ts`)

- `client.ts` - Better Auth client configuration
    - Future: Rename to `auth.client.ts` for consistency

## Migration Strategy

To avoid disrupting 17+ import sites, we maintain the current filenames but follow the convention for new files:

```typescript
// ✅ New pattern (for new files)
import { authClient } from "@/lib/auth/auth.client"; // Client-only
import { getCurrentUser } from "@/lib/auth/auth.functions"; // Safe anywhere
import { getUserFromSession } from "@/lib/auth/auth.server"; // Server-only
import { authClient } from "@/lib/auth/client"; // Client-only
// ✅ Current pattern (existing files - gradually migrate)
import { getToken } from "@/lib/auth/server"; // Server-only
import { getSessionToken } from "@/lib/auth/server-functions"; // Safe anywhere
```

## Benefits

1. **Build-time Safety**: Vite prevents bundling `.server.ts` files in client code
2. **Smaller Bundles**: Tree-shaking eliminates server code from client builds
3. **Clear Intent**: File suffix immediately shows where code runs
4. **Type Safety**: Can safely `import type` from `.server.ts` files

## Example: Adding New Auth Functionality

```typescript
// auth.server.ts - Server-only database operations
// auth.functions.ts - Server function wrapper
import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";

// PasswordForm.tsx - Client component
import { checkPasswordStrength } from "@/lib/auth/auth.functions";

import { validatePasswordStrength } from "./auth.server";

export async function validatePasswordStrength(password: string): Promise<boolean> {
    // Complex validation logic, possibly hitting external APIs
    const result = await passwordStrengthAPI.check(password);

    return result.score > 3;
}

const passwordSchema = z.string().min(8);

export const checkPasswordStrength = createServerFn({ method: "POST" })
    .validator(passwordSchema)
    .handler(async ({ data }) => await validatePasswordStrength(data)); // ✅ Safe!
// import { validatePasswordStrength } from '@/lib/auth/auth.server' // ❌ Build error!

function PasswordForm() {
    const handleCheck = async (password: string) => {
        const isStrong = await checkPasswordStrength(password);
        // ...
    };
}
```

## References

- [TanStack Start File Organization](https://tanstack.com/start/latest/docs/file-organization)
- [Skill: TanStack Start - File Organization](/.agents/skills/tanstack-start/SKILL.md#file-organization-for-server-functions)
