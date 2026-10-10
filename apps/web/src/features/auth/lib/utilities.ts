import type { useLingui } from "@lingui/react/macro";

type TranslateFunction = ReturnType<typeof useLingui>["t"];

/**
 * Maps error codes to Lingui translations.
 *
 * A lookup table rather than a `switch`: at 150+ arms the switch was control flow
 * in name only, and every arm is the same shape.
 */
const ERROR_TRANSLATIONS: Record<string, (t: TranslateFunction) => string> = {
    ACCOUNT_LOCKED: (t) => t`Account locked`,
    ACCOUNT_NOT_FOUND: (t) => t`Account not found`,
    ALREADY_SUBSCRIBED_PLAN: (t) => t`You're already subscribed to this plan`,
    ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY: (t) => t`Anonymous users cannot sign in again anonymously`,
    AUTHENTICATION_FAILED: (t) => t`Authentication failed`,
    BACKUP_CODE_ALREADY_USED: (t) => t`Backup code already used`,
    BACKUP_CODES_NOT_ENABLED: (t) => t`Backup codes are not enabled`,
    BANNED_USER: (t) => t`You have been banned from this application`,
    CHALLENGE_NOT_FOUND: (t) => t`Challenge not found`,
    COULD_NOT_CREATE_SESSION: (t) => t`Could not create session`,
    CREDENTIAL_ACCOUNT_NOT_FOUND: (t) => t`Credential account not found`,
    EMAIL_CAN_NOT_BE_UPDATED: (t) => t`Email cannot be updated`,
    EMAIL_IS_ALREADY_TAKEN: (t) => t`Email is already taken`,
    EMAIL_NOT_VERIFIED: (t) => t`Email not verified`,
    EMAIL_VERIFICATION_REQUIRED: (t) => t`Email verification is required before you can subscribe to a plan`,
    EXPIRES_IN_IS_TOO_LARGE: (t) => t`The expires in is larger than the predefined maximum value`,
    EXPIRES_IN_IS_TOO_SMALL: (t) => t`The expires in is smaller than the predefined minimum value`,
    FAILED_TO_CREATE_SESSION: (t) => t`Failed to create session`,
    FAILED_TO_CREATE_USER: (t) => t`Failed to create user`,
    FAILED_TO_FETCH_PLANS: (t) => t`Failed to fetch plans`,
    FAILED_TO_GET_SESSION: (t) => t`Failed to get session`,
    FAILED_TO_GET_USER_INFO: (t) => t`Failed to get user info`,
    FAILED_TO_RETRIEVE_INVITATION: (t) => t`Failed to retrieve invitation`,
    FAILED_TO_UNLINK_LAST_ACCOUNT: (t) => t`You can't unlink your last account`,
    FAILED_TO_UPDATE_PASSKEY: (t) => t`Failed to update passkey`,
    FAILED_TO_UPDATE_USER: (t) => t`Failed to update user`,
    FAILED_TO_VERIFY_REGISTRATION: (t) => t`Failed to verify registration`,
    FORBIDDEN: (t) => t`Forbidden`,
    ID_TOKEN_NOT_SUPPORTED: (t) => t`ID token not supported`,
    INTERNAL_SERVER_ERROR: (t) => t`Internal server error`,
    INVALID_API_KEY: (t) => t`Invalid API key`,
    INVALID_API_KEY_GETTER_RETURN_TYPE: (t) => t`API Key getter returned an invalid key type. Expected string.`,
    INVALID_BACKUP_CODE: (t) => t`Invalid backup code`,
    INVALID_CODE: (t) => t`Invalid code`,
    INVALID_EMAIL: (t) => t`Invalid email`,
    INVALID_EMAIL_OR_PASSWORD: (t) => t`Invalid email or password`,
    INVALID_METADATA_TYPE: (t) => t`Metadata must be an object or undefined`,
    INVALID_NAME_LENGTH: (t) => t`The name length is either too large or too small`,
    INVALID_OAUTH_CONFIGURATION: (t) => t`Invalid OAuth configuration`,
    INVALID_OTP: (t) => t`Invalid OTP`,
    INVALID_PASSWORD: (t) => t`Invalid password`,
    INVALID_PHONE_NUMBER: (t) => t`Invalid phone number`,
    INVALID_PHONE_NUMBER_OR_PASSWORD: (t) => t`Invalid phone number or password`,
    INVALID_PREFIX_LENGTH: (t) => t`The prefix length is either too large or too small`,
    INVALID_REMAINING: (t) => t`The remaining count is either too large or too small`,
    INVALID_SESSION_TOKEN: (t) => t`Invalid session token`,
    INVALID_TOKEN: (t) => t`Invalid token`,
    INVALID_TWO_FACTOR_CODE: (t) => t`Invalid two-factor code`,
    INVALID_TWO_FACTOR_COOKIE: (t) => t`Invalid two factor cookie`,
    INVALID_USER_ID_FROM_API_KEY: (t) => t`The user ID from the API key is invalid`,
    INVALID_USERNAME: (t) => t`Invalid username`,
    INVALID_USERNAME_OR_PASSWORD: (t) => t`Invalid email or password`,
    INVITATION_LIMIT_REACHED: (t) => t`Invitation limit reached`,
    INVITATION_NOT_FOUND: (t) => t`Invitation not found`,
    INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION: (t) => t`Inviter is no longer a member of the organization`,
    KEY_DISABLED: (t) => t`API Key is disabled`,
    KEY_DISABLED_EXPIRATION: (t) => t`Custom key expiration values are disabled`,
    KEY_EXPIRED: (t) => t`API Key has expired`,
    KEY_NOT_FOUND: (t) => t`API Key not found`,
    KEY_NOT_RECOVERABLE: (t) => t`API Key is not recoverable`,
    MEMBER_NOT_FOUND: (t) => t`Member not found`,
    METADATA_DISABLED: (t) => t`Metadata is disabled`,
    MISSING_RESPONSE: (t) => t`Missing CAPTCHA response`,
    MISSING_SECRET_KEY: (t) => t`Missing secret key`,
    NETWORK_ERROR: (t) => t`Network error`,
    NO_ACTIVE_ORGANIZATION: (t) => t`No active organization`,
    NO_VALUES_TO_UPDATE: (t) => t`No values to update`,
    NOT_FOUND: (t) => t`Not found`,
    ORGANIZATION_ALREADY_EXISTS: (t) => t`Organization already exists`,
    ORGANIZATION_MEMBERSHIP_LIMIT_REACHED: (t) => t`Organization membership limit reached`,
    ORGANIZATION_NOT_FOUND: (t) => t`Organization not found`,
    OTP_EXPIRED: (t) => t`OTP expired`,
    OTP_HAS_EXPIRED: (t) => t`OTP has expired`,
    OTP_NOT_ENABLED: (t) => t`OTP not enabled`,
    OTP_NOT_FOUND: (t) => t`OTP not found`,
    OAUTH_EMAIL_UNVERIFIED: (t) => t`Your sign-in provider did not confirm this email address, so it cannot redeem an invitation.`,
    PASSKEY_NOT_FOUND: (t) => t`Passkey not found`,
    PASSKEY_REQUIRES_ACCOUNT: (t) => t`Create an account before adding a passkey.`,
    PASSWORD_COMPROMISED: (t) => t`The password you entered has been compromised. Please choose a different password.`,
    PASSWORD_TOO_LONG: (t) => t`Password is too long`,
    PASSWORD_TOO_SHORT: (t) => t`Password is too short`,
    PASSWORDS_DO_NOT_MATCH: (t) => t`Passwords do not match`,
    PHONE_NUMBER_EXIST: (t) => t`Phone number already exists`,
    PHONE_NUMBER_NOT_VERIFIED: (t) => t`Phone number not verified`,
    PROVIDER_NOT_FOUND: (t) => t`Provider not found`,
    RATE_LIMIT_EXCEEDED: (t) => t`Rate limit exceeded`,
    REFILL_AMOUNT_AND_INTERVAL_REQUIRED: (t) => t`Refill amount is required when refill interval is provided`,
    REFILL_INTERVAL_AND_AMOUNT_REQUIRED: (t) => t`Refill interval is required when refill amount is provided`,
    REQUEST_FAILED: (t) => t`Request failed`,
    ROLE_NOT_FOUND: (t) => t`Role not found`,
    SERVER_ONLY_PROPERTY: (t) => t`The property you're trying to set can only be set from the server auth instance only`,
    SERVICE_UNAVAILABLE: (t) => t`Service unavailable`,
    SESSION_EXPIRED: (t) => t`Session expired. Re-authenticate to perform this action.`,
    SOCIAL_ACCOUNT_ALREADY_LINKED: (t) => t`Social account already linked`,
    SUBSCRIPTION_NOT_ACTIVE: (t) => t`Subscription is not active`,
    SUBSCRIPTION_NOT_FOUND: (t) => t`Subscription not found`,
    SUBSCRIPTION_NOT_SCHEDULED_FOR_CANCELLATION: (t) => t`Subscription is not scheduled for cancellation`,
    SUBSCRIPTION_PLAN_NOT_FOUND: (t) => t`Subscription plan not found`,
    TEAM_ALREADY_EXISTS: (t) => t`Team already exists`,
    TEAM_NOT_FOUND: (t) => t`Team not found`,
    TOKEN_EXPIRED: (t) => t`Token expired`,
    TOO_MANY_ATTEMPTS: (t) => t`Too many attempts`,
    TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: (t) => t`Too many attempts. Please request a new code.`,
    TOO_MANY_REQUESTS: (t) => t`Too many requests`,
    TOTP_NOT_ENABLED: (t) => t`TOTP not enabled`,
    TWO_FACTOR_CODE_EXPIRED: (t) => t`Two-factor code expired`,
    TWO_FACTOR_NOT_ENABLED: (t) => t`Two factor authentication is not enabled`,
    UNABLE_TO_CREATE_CUSTOMER: (t) => t`Unable to create customer`,
    UNABLE_TO_CREATE_SESSION: (t) => t`Unable to create session`,
    UNABLE_TO_REMOVE_LAST_TEAM: (t) => t`Unable to remove last team`,
    UNAUTHORIZED: (t) => t`Unauthorized`,
    UNAUTHORIZED_SESSION: (t) => t`Unauthorized or invalid session`,
    UNEXPECTED_ERROR: (t) => t`Unexpected error`,
    UNKNOWN_ERROR: (t) => t`Something went wrong`,
    USAGE_EXCEEDED: (t) => t`API Key has reached its usage limit`,
    USER_ALREADY_EXISTS: (t) => t`User already exists`,
    USER_ALREADY_HAS_PASSWORD: (t) => t`User already has a password. Provide that to delete the account.`,
    USER_BANNED: (t) => t`User is banned`,
    USER_EMAIL_NOT_FOUND: (t) => t`User email not found`,
    USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: (t) => t`User is already a member of this organization`,
    USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: (t) => t`User is already invited to this organization`,
    USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION: (t) => t`User is not a member of the organization`,
    USER_NOT_FOUND: (t) => t`User not found`,
    USERNAME_IS_ALREADY_TAKEN: (t) => t`Username is already taken`,
    USERNAME_TOO_LONG: (t) => t`Username is too long`,
    USERNAME_TOO_SHORT: (t) => t`Username is too short`,
    VERIFICATION_FAILED: (t) => t`Captcha verification failed`,
    YOU_ARE_NOT_ALLOWED_TO_BAN_USERS: (t) => t`You are not allowed to ban users`,
    YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION: (t) => t`You are not allowed to cancel this invitation`,
    YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE: (t) => t`You are not allowed to change users role`,
    YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION: (t) => t`You are not allowed to create a new organization`,
    YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_TEAM: (t) => t`You are not allowed to create a new team`,
    YOU_ARE_NOT_ALLOWED_TO_CREATE_TEAMS_IN_THIS_ORGANIZATION: (t) => t`You are not allowed to create teams in this organization`,
    YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS: (t) => t`You are not allowed to create users`,
    YOU_ARE_NOT_ALLOWED_TO_DELETE_TEAMS_IN_THIS_ORGANIZATION: (t) => t`You are not allowed to delete teams in this organization`,
    YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER: (t) => t`You are not allowed to delete this member`,
    YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_ORGANIZATION: (t) => t`You are not allowed to delete this organization`,
    YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_TEAM: (t) => t`You are not allowed to delete this team`,
    YOU_ARE_NOT_ALLOWED_TO_DELETE_USERS: (t) => t`You are not allowed to delete users`,
    YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS: (t) => t`You are not allowed to impersonate users`,
    YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE: (t) => t`You are not allowed to invite user with this role`,
    YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION: (t) => t`You are not allowed to invite users to this organization`,
    YOU_ARE_NOT_ALLOWED_TO_LIST_USERS: (t) => t`You are not allowed to list users`,
    YOU_ARE_NOT_ALLOWED_TO_LIST_USERS_SESSIONS: (t) => t`You are not allowed to list users sessions`,
    YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY: (t) => t`You are not allowed to register this passkey`,
    YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS: (t) => t`You are not allowed to revoke users sessions`,
    YOU_ARE_NOT_ALLOWED_TO_SET_USERS_PASSWORD: (t) => t`You are not allowed to set users password`,
    YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER: (t) => t`You are not allowed to update this member`,
    YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION: (t) => t`You are not allowed to update this organization`,
    YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_TEAM: (t) => t`You are not allowed to update this team`,
    YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: (t) => t`You are not the recipient of the invitation`,
    YOU_CANNOT_BAN_YOURSELF: (t) => t`You cannot ban yourself`,
    YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER: (t) => t`You cannot leave the organization as the only owner`,
    YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS: (t) => t`You have reached the maximum number of organizations`,
    YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_TEAMS: (t) => t`You have reached the maximum number of teams`,
};

const getErrorTranslation = (errorCode: string, t: TranslateFunction): string => ERROR_TRANSLATIONS[errorCode]?.(t) ?? t`Request failed`;

const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;

export const isValidEmail = (email: string) => EMAIL_ADDRESS_RE.test(email);

/**
 * Converts error codes from SNAKE_CASE to camelCase
 * Example: INVALID_TWO_FACTOR_COOKIE -> invalidTwoFactorCookie.
 */
export const errorCodeToCamelCase = (errorCode: string): string => errorCode.toLowerCase().replaceAll(/_([a-z])/g, (_, char) => char.toUpperCase());

/**
 * Gets a localized error message from an error object.
 */
export const getLocalizedError = ({ error, t }: { error: unknown; t: ReturnType<typeof useLingui>["t"] }): string => {
    // Handle string error codes directly
    if (typeof error === "string") {
        return getErrorTranslation(error, t);
    }

    const errorRecord = error as Record<string, unknown> | null | undefined;

    // Handle error objects with nested error property
    if (errorRecord?.error && typeof errorRecord.error === "object") {
        const nested = errorRecord.error as Record<string, unknown>;

        if (typeof nested.code === "string") {
            return getErrorTranslation(nested.code, t);
        }

        return (nested.message as string) || (nested.statusText as string) || t`Request failed`;
    }

    if (errorRecord && typeof errorRecord.message === "string") {
        return errorRecord.message;
    }

    return t`Request failed`;
};

export const getKeyByValue = <T extends Record<string, unknown>>(object: T, value?: T[keyof T]): keyof T | undefined =>
    (Object.keys(object) as (keyof T)[]).find((key) => object[key] === value);
