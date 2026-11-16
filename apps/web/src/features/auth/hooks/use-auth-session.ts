import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import type { AuthHooks } from "@/features/auth/types/hook-integration-types";

// Read the session and organizations through these, never `useAuth().hooks.useX()` in a component: the React Compiler
// skips a component that calls a hook taken from a value (it may be another hook next render), so the busiest chat
// components ran uncompiled. These keep that call in one place: the provider memoizes `hooks` on the auth client, so
// the hook stays the same, and the provider's hooks (and tests that mock `useAuth`) still decide what is read. The
// compiler skips these three, which have nothing to memoize. `scripts/react-compiler-bailouts.test.ts` guards callers.

/** The current session, as the auth provider's `useSession` reads it. */
export const useAuthSession = (): ReturnType<AuthHooks["useSession"]> => useAuth().hooks.useSession();

/** The active organization, as the auth provider's `useActiveOrganization` reads it. */
export const useAuthActiveOrganization = (): ReturnType<AuthHooks["useActiveOrganization"]> => useAuth().hooks.useActiveOrganization();

/** The signed-in user's organizations, as the auth provider's `useListOrganizations` reads them. */
export const useAuthOrganizationList = (): ReturnType<AuthHooks["useListOrganizations"]> => useAuth().hooks.useListOrganizations();
