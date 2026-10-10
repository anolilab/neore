/**
 * Non-table exports from the original `admin/schema.ts`.
 *
 * The table definitions moved to the generated top-level `lunora/schema.ts`;
 * these types and validators are still referenced by handlers, so they stay here.
 */
import { v } from "lunorash/server";

export const auditActionTypes = v.union(
    // User management
    v.literal("user.create"),
    v.literal("user.update"),
    v.literal("user.delete"),
    v.literal("user.role.update"),
    v.literal("user.ban"),
    v.literal("user.unban"),
    v.literal("user.sessions.revoke"),
    v.literal("user.impersonate.start"),
    v.literal("user.impersonate.stop"),
    // Admin actions
    v.literal("admin.grant"),
    v.literal("admin.revoke"),
    // Authentication events
    v.literal("auth.login"),
    v.literal("auth.logout"),
    v.literal("auth.password.reset.request"),
    v.literal("auth.password.reset.complete"),
    v.literal("auth.email.verify"),
    v.literal("auth.two-factor.enable"),
    v.literal("auth.two-factor.disable"),
    v.literal("auth.account.link"),
    v.literal("auth.account.unlink"),
    // Session management
    v.literal("session.create"),
    v.literal("session.update"),
    v.literal("session.delete"),
    // Organization actions
    v.literal("organization.create"),
    v.literal("organization.update"),
    v.literal("organization.delete"),
    v.literal("organization.member.add"),
    v.literal("organization.member.remove"),
    v.literal("organization.member.role.update"),
    v.literal("organization.invitation.send"),
    v.literal("organization.invitation.accept"),
    v.literal("organization.invitation.revoke"),
    // Team actions
    v.literal("team.create"),
    v.literal("team.update"),
    v.literal("team.delete"),
    v.literal("team.member.add"),
    v.literal("team.member.remove"),
);
