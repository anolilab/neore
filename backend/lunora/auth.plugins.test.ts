/**
 * Which plugins `buildAuthOptions` installs is a security property, and the
 * invite-only gate is the one that would fail open: drop it from the list and
 * registration silently reopens to anyone, with every other test still passing.
 *
 * Nothing else observes the list without a live worker — `buildAuth` needs real
 * D1 and shard bindings — which is why this reaches for the options builder.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Plugin ids are how better-auth identifies them; `inviteOnly()` sets this one. */
const INVITE_ONLY_ID = "lunora-invite-only";

const pluginIds = async (): Promise<string[]> => {
    const { buildAuthOptions } = await import("./auth");

    return (buildAuthOptions().plugins ?? []).map((plugin) => plugin.id);
};

// `vi.resetModules()` makes every test re-import `./auth` cold — the whole auth,
// connector and plugin graph — which crosses the 5s default under full-suite load.
describe("buildAuthOptions plugins", { timeout: 30_000 }, () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllEnvs();
    });

    it("installs the invite-only gate by default, including when SIGNUP_INVITE_ONLY is unset", async () => {
        // Unset must mean ON: the failure direction of this flag is "anyone can register".
        expect(await pluginIds()).toContain(INVITE_ONLY_ID);
    });

    it("keeps anonymous sign-in installed alongside it", async () => {
        expect(await pluginIds()).toContain("anonymous");
    });

    it.each(["false", "0"])("omits the gate when SIGNUP_INVITE_ONLY is %o", async (value) => {
        vi.stubEnv("SIGNUP_INVITE_ONLY", value);

        const ids = await pluginIds();

        expect(ids).not.toContain(INVITE_ONLY_ID);
        // Turning registration back open must not take anonymous with it.
        expect(ids).toContain("anonymous");
    });

    it("treats any other value as on, rather than as off", async () => {
        vi.stubEnv("SIGNUP_INVITE_ONLY", "no");

        expect(await pluginIds()).toContain(INVITE_ONLY_ID);
    });
});

describe("buildAuthOptions account deletion", () => {
    // better-auth's `/delete-user` removes only its own rows, so turning it on
    // would let a user "delete" their account and leave all app data behind.
    // Account deletion goes through `gdpr.requestAccountDeletion` instead.
    it("keeps better-auth's own delete-user endpoint disabled", async () => {
        vi.resetModules();

        const { buildAuthOptions } = await import("./auth");

        expect(buildAuthOptions().user?.deleteUser?.enabled).toBe(false);
    });
});
