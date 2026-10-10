const authViewPaths = {
    ACCEPT_INVITATION: "accept-invitation",
    API_KEYS: "apiKeys",
    CALLBACK: "callback",
    CONVERT_ACCOUNT: "convert-account",
    EMAIL_OTP: "email-otp",
    FORGOT_PASSWORD: "forgot-password",
    MAGIC_LINK: "magicLink",
    MEMBERS: "members",
    ORGANIZATION: "organization",
    ORGANIZATIONS: "organizations",
    RECOVER_ACCOUNT: "recover-account",
    RESET_PASSWORD: "resetPassword",
    SECURITY: "security",
    SETTINGS: "settings",
    SIGN_IN: "sign-in",
    SIGN_OUT: "sign-out",
    SIGN_UP: "sign-up",
    TWO_FACTOR: "two-factor",
};

/**
 * The organization list in the dashboard, where the org pages send a user who
 * has no active organization. Not `${basePath}/${SETTINGS}`: this app has no
 * `/auth/settings` route, so that redirect landed on a 404.
 */
export const ORGANIZATIONS_SETTINGS_PATH = "/dashboard/settings/auth/organizations";

export type AuthViewPaths = typeof authViewPaths;
export type AuthView = keyof AuthViewPaths;

export default authViewPaths;
