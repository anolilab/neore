import type { Infer } from "lunorash/server";

/**
 * Admin Functions
 *
 * Server-side admin operations for user management, role assignment,
 * banning, and dashboard statistics.
 *
 * These functions complement Better Auth's admin client plugin.
 * Use Better Auth client API for standard operations like:
 * - authClient.admin.banUser / unbanUser
 * - authClient.admin.impersonateUser / stopImpersonating
 * - authClient.admin.revokeUserSession / revokeUserSessions
 *
 * Use these backend functions for:
 * - Custom admin queries (dashboard stats, user lists)
 * - Role management with business logic
 * - Operations requiring Lunora-specific features (pagination, aggregates)
 */
import { LunoraError, v } from "lunorash/server";

import { createAuditLogEntry } from "../admin/audit-log";
import { adminMutation, adminQuery, authQuery, rateLimit } from "../lib/crpc";
import { checkUserBanStatus } from "../lib/crpc-auth-helpers";
import type { Where } from "lunorash/server/data-model";

import type { Doc } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";

/**
 * Ceiling for the admin user-search scan. Admin-only, and the search is a
 * substring match with no index behind it, so the read is deliberately bounded.
 */
const ADMIN_SEARCH_SCAN_LIMIT = 10_000;

/**
 * Ceiling for the seven-day signup rows the growth chart buckets by day. A week
 * of signups is the real bound; this only stops a runaway read.
 */
const GROWTH_WINDOW_USERS = 10_000;

// =============================================================================
// Admin Role Management
// =============================================================================

/**
 * Check if a specific user has admin status.
 * Admin-only query to verify user permissions.
 */
export const checkUserAdminStatus = adminQuery
    .input({
        userId: v.id("user"),
    })
    .output(
        v.object({
            banExpires: v.optional(v.union(v.number(), v.null())),
            banned: v.optional(v.boolean()),
            banReason: v.optional(v.union(v.string(), v.null())),
            email: v.string(),
            isAdmin: v.boolean(),
            name: v.union(v.string(), v.null()),
            role: v.optional(v.union(v.string(), v.null())),
        }),
    )
    .query(async ({ args: input, ctx }) => {
        const user = await ctx.db.user.findFirst({ where: { _id: input.userId } });

        if (!user) {
            throw new LunoraError("NOT_FOUND", "User not found");
        }

        return {
            banExpires: user.banExpires,
            banned: user.banned ?? undefined,
            banReason: user.banReason,
            email: user.email,
            isAdmin: user.role === "admin",
            name: user.name,
            role: user.role,
        };
    });

/**
 * Update a user's role.
 * Only admins can promote users to admin or demote them.
 * Prevents demoting oneself.
 */
export const updateUserRole = adminMutation
    .use(rateLimit("admin/write"))
    .input({
        role: v.union(v.literal("user"), v.literal("admin")),
        userId: v.id("user"),
    })
    .output(v.boolean())
    .mutation(async ({ args: input, ctx }) => {
        // Prevent self-demotion
        if (input.userId === ctx.user.userId && input.role !== "admin") {
            throw new LunoraError("FORBIDDEN", "Cannot demote yourself from admin");
        }

        const targetUser = await ctx.db.user.findFirst({ where: { _id: input.userId } });

        if (!targetUser) {
            throw new LunoraError("NOT_FOUND", "User not found");
        }

        const previousRole = targetUser.role;

        // Update the role
        await ctx.db.patch(input.userId, {
            role: input.role === "admin" ? "admin" : null,
        });

        // Audit log
        await createAuditLogEntry(ctx, {
            action: "user.role.update",
            adminEmail: ctx.user.email,
            adminId: ctx.user.userId,
            details: { newRole: input.role, previousRole },
            targetUserEmail: targetUser.email,
            targetUserId: input.userId,
        });

        ctx.log.event("admin.update_user_role", { role: input.role, targetUserId: input.userId, previousRole: previousRole ?? null });

        return true;
    });

/**
 * Grant admin role to a user by email.
 * Useful for promoting users before they exist in the system (pre-registration).
 */
export const grantAdminByEmail = adminMutation
    .use(rateLimit("admin/write"))
    .input({
        email: v.string().max(MAX_LENGTH.short),
    })
    .output(v.object({ success: v.boolean(), userId: v.optional(v.string()) }))
    .mutation(async ({ args: input, ctx }) => {
        // Find user by email using the index
        const user = await ctx.db.user.findFirst({ where: { email: input.email } });

        if (!user) {
            return { success: false };
        }

        // Update user role to admin
        await ctx.db.patch(user._id, { role: "admin" });

        // Audit log
        await createAuditLogEntry(ctx, {
            action: "admin.grant",
            adminEmail: ctx.user.email,
            adminId: ctx.user.userId,
            details: { grantedByEmail: true },
            targetUserEmail: user.email,
            targetUserId: user._id,
        });

        ctx.log.event("admin.grant_admin_by_email", { adminId: ctx.user.userId, targetUserId: user._id });

        return { success: true, userId: user._id };
    });

/**
 * Revoke admin role from a user by email.
 * Prevents revoking from self.
 */
export const revokeAdminByEmail = adminMutation
    .use(rateLimit("admin/write"))
    .input({
        email: v.string().max(MAX_LENGTH.short),
    })
    .output(v.object({ success: v.boolean(), userId: v.optional(v.string()) }))
    .mutation(async ({ args: input, ctx }) => {
        // Find user by email using the index
        const user = await ctx.db.user.findFirst({ where: { email: input.email } });

        if (!user) {
            return { success: false };
        }

        // Prevent self-demotion
        if (user._id === ctx.user.userId) {
            throw new LunoraError("FORBIDDEN", "Cannot revoke your own admin privileges");
        }

        // Update user role to null (regular user)
        await ctx.db.patch(user._id, { role: null });

        // Audit log
        await createAuditLogEntry(ctx, {
            action: "admin.revoke",
            adminEmail: ctx.user.email,
            adminId: ctx.user.userId,
            details: { revokedByEmail: true },
            targetUserEmail: user.email,
            targetUserId: user._id,
        });

        ctx.log.event("admin.revoke_admin_by_email", { adminId: ctx.user.userId, targetUserId: user._id });

        return { success: true, userId: user._id };
    });

// =============================================================================
// User Listing & Search
// =============================================================================

const UserListItemSchema = v.object({
    _creationTime: v.number(),
    _id: v.string(),
    banExpires: v.optional(v.union(v.number(), v.null())),
    banReason: v.optional(v.union(v.string(), v.null())),
    email: v.string(),
    image: v.optional(v.union(v.string(), v.null())),
    isAdmin: v.boolean(),
    isAnonymous: v.boolean(),
    isBanned: v.boolean(),
    name: v.union(v.string(), v.null()),
    role: v.optional(v.union(v.string(), v.null())),
});

/**
 * List all users with pagination.
 * Admin-only query for user management dashboard.
 */
export const getAllUsers = adminQuery
    .input({
        cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
        // The bound is applied in the handler, and stays there. Codegen sees
        // through `v.from` since cli@176, so the original reason is gone —
        // but moving the bound to the boundary would change behaviour, not just
        // location: the handler CLAMPS with `Math.min(100, Math.max(1, …))`,
        // whereas a boundary check REJECTS. `limit: 500` would go from returning
        // 100 rows to a validation error for every existing caller.
        limit: v.optional(v.number()),
        role: v.optional(v.union(v.literal("all"), v.literal("user"), v.literal("admin"))),
        search: v.optional(v.string().max(MAX_LENGTH.long)),
        userType: v.optional(v.union(v.literal("all"), v.literal("user"), v.literal("anonymous"))),
    })
    .output(
        v.from(
            v.object({
                continueCursor: v.optional(v.union(v.string(), v.null())),
                isDone: v.boolean(),
                page: v.array(UserListItemSchema),
            }),
        ),
    )
    .query(async ({ args: input, ctx }) => {
        const paginationOptions = {
            cursor: input.cursor ?? null,
            numItems: Math.min(100, Math.max(1, input.limit ?? 20)),
        };

        // Both filters are ANDed server-side. `ne` alone will not do for the
        // negative cases: in SQL a comparison against NULL is NULL, not true, so
        // `role != 'admin'` would drop every user whose role was never set — the
        // exact rows the old `document.role === null ||` disjunct kept.
        const conditions: Where<Doc<"user">>[] = [];

        if (input.role === "admin") {
            conditions.push({ role: "admin" });
        } else if (input.role === "user") {
            conditions.push({ OR: [{ role: { isNull: true } }, { role: { ne: "admin" } }] });
        }

        if (input.userType === "anonymous") {
            conditions.push({ isAnonymous: true });
        } else if (input.userType === "user") {
            conditions.push({ OR: [{ isAnonymous: false }, { isAnonymous: { isNull: true } }] });
        }

        const where: Where<Doc<"user">> = conditions.length > 0 ? { AND: conditions } : {};

        // When searching, bypass pagination to avoid returning empty pages (post-filter after
        // paginate causes pages to appear shorter than the requested limit).
        // A proper fix would be a search index on user.email, but this is admin-only so a
        // bounded full-scan is acceptable.
        if (input.search) {
            const searchLower = input.search.toLowerCase();
            const { page: allUsers } = await ctx.db.user.findMany({ limit: ADMIN_SEARCH_SCAN_LIMIT, orderBy: [{ _creationTime: "desc" }], where });
            const filteredPage = allUsers
                .filter((user) => user.email.toLowerCase().includes(searchLower) || (user.name && user.name.toLowerCase().includes(searchLower)))
                .slice(0, Math.min(100, Math.max(1, input.limit ?? 20)));

            const enrichedPage = filteredPage.map((user) => {
                const banStatus = checkUserBanStatus(user);

                return {
                    _creationTime: user._creationTime,
                    _id: user._id,
                    banExpires: user.banExpires,
                    banReason: user.banReason,
                    email: user.email,
                    image: user.image,
                    isAdmin: user.role === "admin",
                    isAnonymous: user.isAnonymous === true,
                    isBanned: banStatus?.isBanned ?? false,
                    name: user.name,
                    role: user.role,
                };
            });

            return { continueCursor: null, isDone: true, page: enrichedPage };
        }

        const result = await ctx.db.user.findMany({
            cursor: paginationOptions.cursor,
            limit: paginationOptions.numItems,
            orderBy: [{ _creationTime: "desc" }],
            where,
        });

        // Enrich with computed fields
        const enrichedPage = result.page.map((user) => {
            const banStatus = checkUserBanStatus(user);

            return {
                _creationTime: user._creationTime,
                _id: user._id,
                banExpires: user.banExpires,
                banReason: user.banReason,
                email: user.email,
                image: user.image,
                isAdmin: user.role === "admin",
                isAnonymous: user.isAnonymous === true,
                isBanned: banStatus?.isBanned ?? false,
                name: user.name,
                role: user.role,
            };
        });

        return {
            continueCursor: result.continueCursor,
            isDone: result.isDone,
            page: enrichedPage,
        };
    });

/**
 * Search users by email or name.
 * Returns up to 10 matching users for autocomplete/search.
 */
export const searchUsers = adminQuery
    .input({
        query: v.string().max(MAX_LENGTH.long),
    })
    .output(
        v.array(
            v.object({
                _id: v.string(),
                email: v.string(),
                image: v.optional(v.union(v.string(), v.null())),
                isAdmin: v.boolean(),
                name: v.union(v.string(), v.null()),
            }),
        ),
    )
    .query(async ({ args: input, ctx }) => {
        const searchLower = input.query.toLowerCase();

        // Get users and filter in-memory. For better scalability, add a search index
        // on user.email using the search index feature.
        const { page: users } = await ctx.db.user.findMany({ limit: 100, orderBy: [{ _creationTime: "desc" }] });

        const matches = users
            .filter((user) => user.email.toLowerCase().includes(searchLower) || (user.name && user.name.toLowerCase().includes(searchLower)))
            .slice(0, 10);

        return matches.map((user) => {
            return {
                _id: user._id,
                email: user.email,
                image: user.image,
                isAdmin: user.role === "admin",
                name: user.name,
            };
        });
    });

// =============================================================================
// Dashboard Statistics
// =============================================================================

/**
 * Get admin dashboard statistics.
 * Returns user counts, recent activity, and growth data.
 */
const vGetDashboardStatsOutput = v.object({
    recentUsers: v.array(
        v.object({
            _creationTime: v.number(),
            _id: v.string(),
            email: v.string(),
            image: v.optional(v.union(v.string(), v.null())),
            isAnonymous: v.boolean(),
            name: v.union(v.string(), v.null()),
        }),
    ),
    totalAdmins: v.number(),
    totalAnonymousUsers: v.number(),
    totalBannedUsers: v.number(),
    totalRegularUsers: v.number(),
    totalUsers: v.number(),
    userGrowth: v.object({
        all: v.array(v.object({ count: v.number(), date: v.string() })),
        anonymous: v.array(v.object({ count: v.number(), date: v.string() })),
        regular: v.array(v.object({ count: v.number(), date: v.string() })),
    }),
});

/** UTC calendar day (`YYYY-MM-DD`) of an epoch-ms instant. Pure: the caller supplies the clock. */
const utcDayKey = (epochMs: number): string => new Date(epochMs).toISOString().split("T", 1)[0]!;

/**
 * `now` is the caller's clock (the client floors it to the minute), so a live
 * re-run of this query cannot answer with a different time.
 */
export const getDashboardStats = adminQuery
    .input({ now: v.number() })
    .output(v.from(vGetDashboardStatsOutput))
    .query(async ({ args, ctx }): Promise<Infer<typeof vGetDashboardStatsOutput>> => {
        const { now } = args;
        const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

        // OPTIMIZED: Use separate indexed queries instead of fetching all 50k users
        // Each query is targeted and fast, preventing timeout and memory issues
        // These are counts, so ask for counts. Materialising rows to read `.length`
        // reports a number that silently stops growing at the read limit — a
        // dashboard that says "10,000 admins" whether there are 10,000 or 400,000.
        const [recentUsers, totalAdmins, totalAnonymousUsers, totalBannedUsers, recentUsersForGrowth] = await Promise.all([
            // Recent users (last 5)
            ctx.db.user.findMany({ limit: 5, orderBy: [{ _creationTime: "desc" }] }).then((result) => result.page),

            ctx.db.user.count({ role: "admin" }),

            ctx.db.user.count({ isAnonymous: true }),

            // Banned users (active bans only)
            ctx.db.user.count({ AND: [{ banned: true }, { OR: [{ banExpires: { isNull: true } }, { banExpires: { gt: now } }] }] }),

            // Rows, not a count: each one is bucketed by signup day below. Bounded by
            // the seven-day window rather than by the limit in practice.
            ctx.db.user.findMany({ limit: GROWTH_WINDOW_USERS, where: { _creationTime: { gte: sevenDaysAgo } } }).then((result) => result.page),
        ]);

        // `ctx.db.user.count()`, the ORM facade — NOT `ctx.db.query("user").count()`.
        // `TableReader` has no `count` at all, so the cast was hiding
        // `TypeError: ….count is not a function` on every call to this query.
        // Same bug was in `gdpr/functions.ts`, where it took the whole data-access
        // summary down.
        const totalUsers = await ctx.db.user.count();

        const totalRegularUsers = totalUsers - totalAnonymousUsers;

        // Calculate 7-day growth by day (only process recent users, not all 50k!)
        const growthAll = new Map<string, number>();
        const growthRegular = new Map<string, number>();
        const growthAnonymous = new Map<string, number>();

        // Initialize with zeros for last 7 days
        for (let i = 6; i >= 0; i -= 1) {
            const dateString = utcDayKey(now - i * 24 * 60 * 60 * 1000);

            growthAll.set(dateString!, 0);
            growthRegular.set(dateString!, 0);
            growthAnonymous.set(dateString!, 0);
        }

        // Count signups per day
        for (const user of recentUsersForGrowth) {
            const dateString = utcDayKey(user._creationTime);

            if (growthAll.has(dateString!)) {
                growthAll.set(dateString!, (growthAll.get(dateString!) || 0) + 1);

                if (user.isAnonymous === true) {
                    growthAnonymous.set(dateString!, (growthAnonymous.get(dateString!) || 0) + 1);
                } else {
                    growthRegular.set(dateString!, (growthRegular.get(dateString!) || 0) + 1);
                }
            }
        }

        const mapToArray = (map: Map<string, number>) =>
            [...map].map(([date, count]) => {
                return { count, date };
            });

        const userGrowth = {
            all: mapToArray(growthAll),
            anonymous: mapToArray(growthAnonymous),
            regular: mapToArray(growthRegular),
        };

        return {
            recentUsers: recentUsers.map((u) => {
                return {
                    _creationTime: u._creationTime,
                    _id: u._id,
                    email: u.email,
                    image: u.image,
                    isAnonymous: u.isAnonymous === true,
                    name: u.name,
                };
            }),
            totalAdmins,
            totalAnonymousUsers,
            totalBannedUsers,
            totalRegularUsers,
            totalUsers,
            userGrowth,
        };
    });

// =============================================================================
// Session Management
// =============================================================================

/**
 * List all active sessions for a user.
 * Admin-only query for session management.
 */
export const listUserSessions = adminQuery
    .input({
        now: v.number(),
        userId: v.id("user"),
    })
    .output(
        v.array(
            v.object({
                _id: v.string(),
                createdAt: v.number(),
                expiresAt: v.number(),
                impersonatedBy: v.optional(v.union(v.string(), v.null())),
                ipAddress: v.optional(v.union(v.string(), v.null())),
                isExpired: v.boolean(),
                userAgent: v.optional(v.union(v.string(), v.null())),
            }),
        ),
    )
    .query(async ({ args: input, ctx }) => {
        const { page: sessions } = await ctx.db.session.findMany({ where: { userId: input.userId } });

        return sessions.map((session) => {
            return {
                _id: session._id,
                createdAt: session.createdAt,
                expiresAt: session.expiresAt,
                impersonatedBy: session.impersonatedBy,
                ipAddress: session.ipAddress,
                isExpired: session.expiresAt < input.now,
                userAgent: session.userAgent,
            };
        });
    });

/**
 * Revoke all sessions for a user.
 * Admin-only mutation for security incidents.
 */
export const revokeAllUserSessions = adminMutation
    .use(rateLimit("admin/write"))
    .input({
        userId: v.id("user"),
    })
    .output(v.object({ revokedCount: v.number() }))
    .mutation(async ({ args: input, ctx }) => {
        // Prevent revoking own sessions
        if (input.userId === ctx.user.userId) {
            throw new LunoraError("FORBIDDEN", "Cannot revoke your own sessions. Use the client API to sign out.");
        }

        const targetUser = await ctx.db.user.findFirst({ where: { _id: input.userId } });

        // Unbounded deliberately: a capped read would leave sessions alive past
        // the cap and under-report `sessionCount` in the audit entry below.
        const { page: sessions } = await ctx.db.session.findMany({ where: { userId: input.userId } });

        // Delete all sessions
        for (const session of sessions) {
            await ctx.db.delete(session._id);
        }

        // Audit log
        await createAuditLogEntry(ctx, {
            action: "user.sessions.revoke",
            adminEmail: ctx.user.email,
            adminId: ctx.user.userId,
            details: { sessionCount: sessions.length },
            targetUserEmail: targetUser?.email,
            targetUserId: input.userId,
        });

        ctx.log.event("admin.revoke_all_user_sessions", { revokedCount: sessions.length, targetUserId: input.userId });

        return { revokedCount: sessions.length };
    });

// =============================================================================
// Ban Management Helpers
// =============================================================================

/**
 * Get ban status for a user.
 * Admin-only query to check if a user is banned.
 */
export const getUserBanStatus = adminQuery
    .input({
        userId: v.id("user"),
    })
    .output(v.object({ banExpires: v.optional(v.union(v.number(), v.null())), banReason: v.optional(v.union(v.string(), v.null())), isBanned: v.boolean() }))
    .query(async ({ args: input, ctx }) => {
        const user = await ctx.db.user.findFirst({ where: { _id: input.userId } });

        if (!user) {
            throw new LunoraError("NOT_FOUND", "User not found");
        }

        const banStatus = checkUserBanStatus(user);

        return {
            banExpires: user.banExpires,
            banReason: user.banReason,
            isBanned: banStatus?.isBanned ?? false,
        };
    });

/**
 * Ban a user (server-side helper).
 * Note: Prefer using authClient.admin.banUser for standard banning.
 * This function is for custom ban logic or batch operations.
 */
export const banUser = adminMutation
    .use(rateLimit("admin/write"))
    .input({
        banExpiresIn: v.optional(v.number()),
        banReason: v.optional(v.string().max(MAX_LENGTH.long)),
        userId: v.id("user"),
    })
    .output(v.boolean())
    .mutation(async ({ args: input, ctx }) => {
        // Prevent banning self
        if (input.userId === ctx.user.userId) {
            throw new LunoraError("FORBIDDEN", "Cannot ban yourself");
        }

        const targetUser = await ctx.db.user.findFirst({ where: { _id: input.userId } });

        if (!targetUser) {
            throw new LunoraError("NOT_FOUND", "User not found");
        }

        // Cannot ban another admin
        if (targetUser.role === "admin") {
            throw new LunoraError("FORBIDDEN", "Cannot ban an admin user");
        }

        // Calculate ban expiration
        const banExpires = input.banExpiresIn ? ctx.now + input.banExpiresIn * 1000 : null;

        await ctx.db.patch(input.userId, {
            banExpires,
            banned: true,
            banReason: input.banReason || "No reason provided",
        });

        // Audit log
        await createAuditLogEntry(ctx, {
            action: "user.ban",
            adminEmail: ctx.user.email,
            adminId: ctx.user.userId,
            details: {
                banExpires,
                banReason: input.banReason || "No reason provided",
                duration: input.banExpiresIn ? `${input.banExpiresIn} seconds` : "permanent",
            },
            targetUserEmail: targetUser.email,
            targetUserId: input.userId,
        });

        ctx.log.event("admin.ban_user", { hasExpiry: banExpires !== null, targetUserId: input.userId });

        return true;
    });

/**
 * Unban a user (server-side helper).
 * Note: Prefer using authClient.admin.unbanUser for standard unbanning.
 */
export const unbanUser = adminMutation
    .use(rateLimit("admin/write"))
    .input({
        userId: v.id("user"),
    })
    .output(v.boolean())
    .mutation(async ({ args: input, ctx }) => {
        const targetUser = await ctx.db.user.findFirst({ where: { _id: input.userId } });

        if (!targetUser) {
            throw new LunoraError("NOT_FOUND", "User not found");
        }

        await ctx.db.patch(input.userId, {
            banExpires: null,
            banned: false,
            banReason: null,
        });

        // Audit log
        await createAuditLogEntry(ctx, {
            action: "user.unban",
            adminEmail: ctx.user.email,
            adminId: ctx.user.userId,
            details: { previousBanReason: targetUser.banReason },
            targetUserEmail: targetUser.email,
            targetUserId: input.userId,
        });

        ctx.log.event("admin.unban_user", { targetUserId: input.userId });

        return true;
    });

// =============================================================================
// Impersonation Logging
// =============================================================================

/**
 * Log impersonation start event.
 * Called from the frontend after successful impersonation via Better Auth client.
 */
export const logImpersonationStart = adminMutation
    .use(rateLimit("admin/write"))
    .input({
        targetUserId: v.id("user"),
    })
    .output(v.boolean())
    .mutation(async ({ args: input, ctx }) => {
        const targetUser = await ctx.db.user.findFirst({ where: { _id: input.targetUserId } });

        if (!targetUser) {
            throw new LunoraError("NOT_FOUND", "User not found");
        }

        // Audit log
        await createAuditLogEntry(ctx, {
            action: "user.impersonate.start",
            adminEmail: ctx.user.email,
            adminId: ctx.user.userId,
            targetUserEmail: targetUser.email,
            targetUserId: input.targetUserId,
        });

        ctx.log.event("admin.log_impersonation_start", { adminId: ctx.user.userId, targetUserId: input.targetUserId });

        return true;
    });

/**
 * Log impersonation stop event.
 * Called from the frontend after stopping impersonation via Better Auth client.
 */
export const logImpersonationStop = adminMutation
    .use(rateLimit("admin/write"))
    .input({
        targetUserId: v.optional(v.id("user")),
    })
    .output(v.boolean())
    .mutation(async ({ args: input, ctx }) => {
        let targetUserEmail: string | undefined;

        if (input.targetUserId) {
            const targetUser = await ctx.db.user.findFirst({ where: { _id: input.targetUserId } });

            targetUserEmail = targetUser?.email;
        }

        // Audit log
        await createAuditLogEntry(ctx, {
            action: "user.impersonate.stop",
            adminEmail: ctx.user.email,
            adminId: ctx.user.userId,
            targetUserEmail,
            targetUserId: input.targetUserId,
        });

        ctx.log.event("admin.log_impersonation_stop", { adminId: ctx.user.userId, hasTargetUser: input.targetUserId !== undefined });

        return true;
    });

// =============================================================================
// User Information (Non-Admin)
// =============================================================================

/**
 * Check if current user is an admin.
 * Available to all authenticated users.
 */
export const isCurrentUserAdmin = authQuery.output(v.object({ isAdmin: v.boolean() })).query(async ({ ctx }) => {
    return {
        isAdmin: ctx.user.isAdmin,
    };
});

/**
 * Check if current session is impersonated.
 * Available to all authenticated users.
 */
export const isImpersonating = authQuery
    .output(v.object({ impersonatedBy: v.optional(v.union(v.string(), v.null())), isImpersonating: v.boolean() }))
    .query(async ({ ctx }) => {
        return {
            impersonatedBy: ctx.user.impersonatedBy,
            isImpersonating: !!ctx.user.impersonatedBy,
        };
    });
