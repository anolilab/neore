/**
 * Anonymous sign-in must survive the invite-only gate.
 *
 * `inviteOnly()` rejects a user-create whose email has no unspent invitation —
 * and it used to reject a row with NO email too, because the check is "an
 * invitation was found", not "an email was supplied". `anonymous()` creates its
 * users through that same path with a generated `temp-…@…` address, so
 * installing the two together silently turned anonymous sign-in off. We carried
 * a wrapper for it; `@lunora/auth@127` fixed it upstream and the wrapper is
 * gone.
 *
 * This drives the REAL plugin, so it fails if that exemption is ever dropped —
 * which is what the wrapper existed to prevent and is not something our own
 * code can guard any more.
 */
import { inviteOnly } from "@lunora/auth/plugins";
import { describe, expect, it, vi } from "vitest";

/** The two hooks the gate registers; both take the row being created. */
type UserCreateHooks = {
    after?: (user: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
    before?: (user: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
};

/** The slice of better-auth's init context the plugin destructures. */
const initContext = (findOne: unknown = null) => {
    const adapter = { count: vi.fn(async () => 1), findOne: vi.fn(async () => findOne), update: vi.fn(async () => undefined) };

    return {
        adapter,
        context: { adapter },
        // `anonymous` must be in the plugin list — the exemption is conditional on it.
        options: { emailAndPassword: { enabled: true, requireEmailVerification: true }, plugins: [{ id: "anonymous" }] },
    };
};

const userCreateHooks = (context: ReturnType<typeof initContext>): UserCreateHooks => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the init context is better-auth's, far wider than the slice used here
    const result = inviteOnly().init?.(context as any) as { options?: { databaseHooks?: { user?: { create?: UserCreateHooks } } } };
    const create = result?.options?.databaseHooks?.user?.create;

    if (!create) {
        throw new Error("inviteOnly() no longer registers a user.create hook — this test is asserting nothing");
    }

    return create;
};

describe("inviteOnly + anonymous", () => {
    it("lets an anonymous user through without consulting the invitation table", async () => {
        const context = initContext();

        await expect(userCreateHooks(context).before!({ email: "temp-abc@anonymous.local", isAnonymous: true })).resolves.toBeUndefined();
        // Not merely "did not throw": the gate never ran.
        expect(context.adapter.findOne).not.toHaveBeenCalled();
    });

    it("does not mark an invitation spent for an anonymous user", async () => {
        const context = initContext();

        await userCreateHooks(context).after!({ email: "temp-abc@anonymous.local", isAnonymous: true });

        expect(context.adapter.update).not.toHaveBeenCalled();
    });

    it("still rejects a normal sign-up with no invitation", async () => {
        await expect(userCreateHooks(initContext(null)).before!({ email: "someone@example.com" })).rejects.toThrow();
    });

    it("admits a normal sign-up holding an unspent, unexpired invitation", async () => {
        const invitation = { acceptedAt: null, email: "invited@example.com", expiresAt: new Date(Date.now() + 60_000) };

        await expect(userCreateHooks(initContext(invitation)).before!({ email: "invited@example.com" })).resolves.toBeUndefined();
    });
});
