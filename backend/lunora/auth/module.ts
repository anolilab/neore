import { defineModule } from "lunorash/server";

export default defineModule({
    description:
        "Better Auth wiring and the per-user settings rows: sessions, organizations, API keys, invitations, BYOK keys, billing tiers, extension grants.",
    tables: [
        "account",
        "aiUserPreferences",
        "apikey",
        "gatewayUsageDeductions",
        "invitation",
        "jwks",
        "member",
        "memberCredits",
        "organization",
        "passkey",
        "rateLimit",
        "session",
        "signUpInvitation",
        "team",
        "teamMember",
        "teamSettings",
        "twoFactor",
        "user",
        "userSettings",
        "verification",
    ],
});
