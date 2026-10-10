/**
 * Admin Hooks
 *
 * Hooks for admin operations using Lunora queries and mutations.
 * Provides type-safe access to admin functions with TanStack Query integration.
 */
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useAction, useCRPC, useLunoraActionOptions, useLunoraAuth } from "@/lib/lunora/crpc";
import { referenceNow } from "@/lib/reference-time";

/**
 * Check if current user is an admin.
 *
 * `enabled: false` holds the query back (the shortcut rail passes
 * `useAfterFirstPaint()` so an admin link does not join first paint's burst).
 */
export const useIsAdmin = ({ enabled = true }: { enabled?: boolean } = {}) => {
    const crpc = useCRPC();

    return useQuery(crpc.auth.admin.isCurrentUserAdmin.queryOptions(enabled ? {} : skipToken));
};

/**
 * Get admin dashboard statistics.
 */
export const useAdminDashboardStats = () => {
    const crpc = useCRPC();
    // Frozen per mount: a clock read per render would change the query key each minute.
    const [now] = useState(referenceNow);

    return useQuery(crpc.auth.admin.getDashboardStats.queryOptions({ now }));
};

/**
 * Get paginated list of all users (admin only).
 */
export const useAdminUsers = (options: {
    cursor?: string | null;
    limit?: number;
    role?: "all" | "user" | "admin";
    search?: string;
    userType?: "all" | "user" | "anonymous";
}) => {
    const crpc = useCRPC();

    return useQuery(
        crpc.auth.admin.getAllUsers.queryOptions({
            cursor: options.cursor ?? null,
            limit: options.limit ?? 20,
            role: options.role,
            search: options.search,
            userType: options.userType,
        }),
    );
};

/**
 * Search users by email or name.
 */
export const useSearchUsers = (query: string) => {
    const crpc = useCRPC();

    return useQuery({
        ...crpc.auth.admin.searchUsers.queryOptions({ query }),
        enabled: query.length > 0,
    });
};

/**
 * Whether the given user currently holds the admin role, as recorded on the
 * server rather than inferred from the caller's own session.
 */
export const useCheckUserAdminStatus = (userId: Id<"user">) => {
    const crpc = useCRPC();

    return useQuery({
        ...crpc.auth.admin.checkUserAdminStatus.queryOptions({ userId }),
        enabled: !!userId,
    });
};

/**
 * Get user ban status.
 */
export const useUserBanStatus = (userId: Id<"user">) => {
    const crpc = useCRPC();

    return useQuery({
        ...crpc.auth.admin.getUserBanStatus.queryOptions({ userId }),
        enabled: !!userId,
    });
};

/**
 * List user sessions.
 */
export const useUserSessions = (userId: Id<"user">) => {
    const crpc = useCRPC();
    const [now] = useState(referenceNow);

    return useQuery({
        ...crpc.auth.admin.listUserSessions.queryOptions({ now, userId }),
        enabled: !!userId,
    });
};

/**
 * Update user role mutation.
 */
export const useUpdateUserRole = () => {
    const crpc = useCRPC();

    return useMutation(crpc.auth.admin.updateUserRole.mutationOptions());
};

/**
 * Grant admin by email mutation.
 */
export const useGrantAdminByEmail = () => {
    const crpc = useCRPC();

    return useMutation(crpc.auth.admin.grantAdminByEmail.mutationOptions());
};

/**
 * Revoke admin by email mutation.
 */
export const useRevokeAdminByEmail = () => {
    const crpc = useCRPC();

    return useMutation(crpc.auth.admin.revokeAdminByEmail.mutationOptions());
};

/**
 * Ban user mutation.
 */
export const useBanUser = () => {
    const crpc = useCRPC();

    return useMutation(crpc.auth.admin.banUser.mutationOptions());
};

/**
 * Unban user mutation.
 */
export const useUnbanUser = () => {
    const crpc = useCRPC();

    return useMutation(crpc.auth.admin.unbanUser.mutationOptions());
};

/**
 * Revoke all user sessions mutation.
 */
export const useRevokeAllUserSessions = () => {
    const crpc = useCRPC();

    return useMutation(crpc.auth.admin.revokeAllUserSessions.mutationOptions());
};

// =============================================================================
// Impersonation
// =============================================================================

/**
 * Check if current session is impersonated.
 *
 * The banner that consumes this is mounted app-wide, including on the signed-out
 * landing page, and the procedure requires a session — so without the gate every
 * first paint fired a request that could only ever come back 401.
 */
export const useIsImpersonating = () => {
    const crpc = useCRPC();
    // Gated on the RPC client's auth state rather than better-auth's session:
    // the two are not the same instant. The session cookie lands first and the
    // bearer token the client sends is fetched after, so gating on the session
    // still fires this while the client is anonymous — a 401, every load.
    const { isAuthenticated } = useLunoraAuth();
    // A banner for a rare admin session; it can appear a moment after first paint.
    const afterFirstPaint = useAfterFirstPaint();
    const options = crpc.auth.admin.isImpersonating.queryOptions({});

    return useQuery({ ...options, queryFn: isAuthenticated && afterFirstPaint ? options.queryFn : skipToken });
};

/**
 * Log impersonation start mutation.
 */
export const useLogImpersonationStart = () => {
    const crpc = useCRPC();

    return useMutation(crpc.auth.admin.logImpersonationStart.mutationOptions());
};

/**
 * Log impersonation stop mutation.
 */
export const useLogImpersonationStop = () => {
    const crpc = useCRPC();

    return useMutation(crpc.auth.admin.logImpersonationStop.mutationOptions());
};

// =============================================================================
// Audit Logs
// =============================================================================

/**
 * Get audit logs with pagination and filtering.
 */
export type AuditLogQueryArgs = NonNullable<Parameters<ReturnType<typeof useCRPC>["admin"]["audit_log"]["getAuditLogs"]["queryOptions"]>[0]>;
export type AuditLogAction = AuditLogQueryArgs extends { action: infer Action } ? Action : never;

// `action` is the API's literal union, not `string`. Codegen now inlines that
// union (it used to emit an unresolvable `AuditAction` name), so a plain
// `string` no longer assigns — which is the point: the filter UI can only send
// values the backend accepts.
export const useAuditLogs = (options?: { action?: AuditLogAction; adminId?: string; cursor?: string | null; limit?: number; targetUserId?: string }) => {
    const crpc = useCRPC();

    return useQuery(
        crpc.admin.audit_log.getAuditLogs.queryOptions({
            // Values come from AuditActionSchema enum via UI filter; validated by Zod at runtime
            action: options?.action,
            adminId: options?.adminId,
            cursor: options?.cursor ?? null,
            limit: options?.limit ?? 50,
            targetUserId: options?.targetUserId,
        }),
    );
};

/**
 * Get audit log statistics for dashboard.
 */
export const useAuditLogStats = () => {
    const crpc = useCRPC();
    const [now] = useState(referenceNow);

    return useQuery(crpc.admin.audit_log.getAuditLogStats.queryOptions({ now }));
};

// =============================================================================
// Cleanup Hooks
// =============================================================================

/**
 * Get cleanup configuration.
 */
export const useCleanupConfig = () => {
    const crpc = useCRPC();

    return useQuery(crpc.admin.cleanup.getCleanupConfig.queryOptions({}));
};

/**
 * Get cleanup logs with optional limit.
 */
export const useCleanupLogs = (options?: { cursor?: string | null; limit?: number }) => {
    const crpc = useCRPC();

    return useQuery(
        crpc.admin.cleanup.listCleanupLogs.queryOptions({
            cursor: options?.cursor ?? null,
            limit: options?.limit ?? 20,
        }),
    );
};

/**
 * Preview cleanup (how many users would be deleted).
 */
export const usePreviewCleanup = () => {
    const crpc = useCRPC();
    const [now] = useState(referenceNow);

    return useQuery(crpc.admin.cleanup.previewCleanup.queryOptions({ now }));
};

/**
 * Update cleanup configuration mutation.
 */
export const useUpdateCleanupConfig = () => {
    const crpc = useCRPC();

    return useMutation(crpc.admin.cleanup.updateCleanupConfig.mutationOptions());
};

/**
 * Execute cleanup action.
 */
export const useExecuteCleanup = () => useMutation(useLunoraActionOptions(api.admin.cleanup.executeCleanup));

// =============================================================================
// Gateway Analytics
// =============================================================================

/**
 * Fetch smart routing analytics from the LLM Gateway.
 * Returns model breakdown, tier distribution, provider health, and cost trend.
 */
export const useGatewayAnalytics = (period: "24h" | "7d" = "24h") => {
    const fetchAnalytics = useAction(api.admin.gateway_analytics.getGatewayAnalytics);

    return useQuery({
        queryFn: () => fetchAnalytics({ period }),
        queryKey: ["admin", "gatewayAnalytics", period],
        refetchInterval: 60_000,
        retry: 1,
        staleTime: 30_000,
    });
};

/**
 * List virtual API keys for a user (admin view).
 */
export const useGatewayKeys = (userId: string) => {
    const listKeys = useAction(api.admin.gateway_analytics.listGatewayKeysAction);

    return useQuery({
        enabled: !!userId,
        queryFn: () => listKeys({ userId }),
        queryKey: ["admin", "gateway-keys", userId],
        retry: 1,
        staleTime: 30_000,
    });
};

/**
 * Create a new virtual API key.
 */
export const useCreateGatewayKey = () => {
    const createKey = useAction(api.admin.gateway_analytics.createGatewayKeyAction);
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (params: {
            expiresAt?: string;
            maxBudgetUsd?: number;
            name?: string;
            orgId?: string;
            rpmLimit?: number;
            tier?: "free" | "pro" | "enterprise";
            tpmLimit?: number;
            userId: string;
        }) => createKey(params),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "gateway-keys"] });
        },
    });
};

/**
 * Revoke a virtual API key.
 */
export const useRevokeGatewayKey = () => {
    const revokeKey = useAction(api.admin.gateway_analytics.revokeGatewayKeyAction);
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (keyId: string) => revokeKey({ keyId }),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "gateway-keys"] });
        },
    });
};
