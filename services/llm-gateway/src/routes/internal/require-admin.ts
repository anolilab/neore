/**
 * The second check on the gateway's admin endpoints, after HMAC: the caller's `adminUserId` must be in the
 * `GATEWAY_ADMIN_USER_IDS` allowlist. An empty allowlist turns the endpoints off.
 */
export const requireAdmin = (env: { GATEWAY_ADMIN_USER_IDS?: string }, adminUserId: string | undefined): { ok: true } | { ok: false; reason: string } => {
    const allowlist = (env.GATEWAY_ADMIN_USER_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    if (allowlist.length === 0) {
        return { ok: false, reason: "Admin endpoints are disabled (GATEWAY_ADMIN_USER_IDS not configured)" };
    }

    if (!adminUserId) {
        return { ok: false, reason: "Missing adminUserId" };
    }

    if (!allowlist.includes(adminUserId)) {
        return { ok: false, reason: "User is not in admin allowlist" };
    }

    return { ok: true };
};
