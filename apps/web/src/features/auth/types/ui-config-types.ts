import type { SocialProvider } from "better-auth/social-providers";

import type { AuthClient } from "@/lib/auth/client";

import type { AuthCardClassNames } from "../components/auth/auth-card";
import type { Provider } from "../lib/social-providers";
import type { CaptchaProvider, PasswordValidation } from "./form-validation-types";

// Avatar Configuration Types (from avatar-options.ts)
export type AvatarOptions = {
    /**
     * File extension for avatar uploads
     * @default "png"
     */
    extension: string;

    /**
     * Avatar size for resizing
     * @default 128 (or 256 if upload is provided)
     */
    size: number;

    /**
     * Upload an avatar image and return the URL string
     * @remarks `(file: File) => Promise&lt;string>`
     */
    upload?: (file: File) => Promise<string | undefined | null>;
};

// Settings Configuration Types (from settings-options.ts)
export type SettingsOptions = {
    /**
     * Base path for settings views
     */
    basePath?: string;

    /**
     * Array of fields to show in `&lt;SettingsCards />`
     * @default ["image", "name"]
     */
    fields: string[];

    /**
     * Custom Settings URL
     */
    url?: string;
};

// Captcha Configuration Types (from captcha-options.ts)
export type CaptchaOptions = {
    /**
     * Overrides the default array of paths where captcha validation is enforced
     * @default ["/sign-up/email", "/sign-in/email", "/forget-password"]
     */
    endpoints?: string[];

    /**
     * Enable enterprise mode for Google reCAPTCHA
     * @default false
     */
    enterprise?: boolean;

    /**
     * Hide the captcha badge
     * @default false
     */
    hideBadge?: boolean;

    /**
     * Captcha provider type
     */
    provider: CaptchaProvider;

    /**
     * Use recaptcha.net domain instead of google.com
     * @default false
     */
    recaptchaNet?: boolean;

    /**
     * Captcha site key
     */
    siteKey: string;
};

// Social Configuration Types (from social-options.ts)
export type SocialOptions = {
    /**
     * Array of Social Providers to enable
     * @remarks `SocialProvider[]`
     */
    providers: SocialProvider[];

    /**
     * Custom social sign in function
     */
    signIn?: (parameters: Parameters<AuthClient["signIn"]["social"]>[0]) => Promise<unknown>;
};

// Sign Up Configuration Types (from sign-up-options.ts)
export type SignUpOptions = {
    /**
     * Array of fields to show in Sign Up form
     * @default ["name"]
     */
    fields?: string[];
};

// Organization Configuration Types (from organization-options.ts)
export type OrganizationLogoOptions = {
    /**
     * File extension for logo uploads
     * @default "png"
     */
    extension: string;

    /**
     * Logo size for resizing
     * @default 256 if upload is provided, 128 otherwise
     */
    size: number;

    /**
     * Upload a logo image and return the URL string
     * @remarks `(file: File) => Promise&lt;string>`
     */
    upload?: (file: File) => Promise<string | undefined | null>;
};

export type OrganizationOptions = {
    /**
     * Custom roles to add to the built-in roles (owner, admin, member). Empty unless set.
     */
    customRoles?: { label: string; role: string }[];

    /**
     * Logo configuration
     * @default undefined
     */
    logo?: boolean | Partial<OrganizationLogoOptions>;
};

export type OrganizationOptionsContext = {
    /**
     * Custom roles to add to the built-in roles (owner, admin, member). Empty unless set.
     */
    customRoles: { label: string; role: string }[];

    /**
     * Logo configuration
     * @default undefined
     */
    logo?: OrganizationLogoOptions;
};

// Gravatar Configuration Types (from gravatar-options.ts)
export type GravatarOptions = {
    /**
     * Default image type or URL
     * Options: '404', 'mp', 'identicon', 'monsterid', 'wavatar', 'retro', 'robohash', 'blank', or custom URL
     */
    d?: string;

    /**
     * Force default image even if user has Gravatar
     * @default false
     */
    forceDefault?: boolean;

    /**
     * Whether to append .jpg extension to the hash
     * @default false
     */
    jpg?: boolean;

    /**
     * Image size in pixels (1-2048)
     */
    size?: number;
};

// Generic OAuth Configuration Types (from generic-oauth-options.ts)
export type GenericOAuthOptions = {
    /**
     * Custom OAuth Providers. Empty unless set.
     */
    providers: Provider[];

    /**
     * Custom generic OAuth sign in function
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signIn?: (parameters: Parameters<any>[0]) => Promise<unknown>;
};

// Credentials Configuration Types (from credentials-options.ts)
export type CredentialsOptions = {
    /**
     * Enable or disable the Confirm Password input
     * @default false
     */
    confirmPassword?: boolean;

    /**
     * Enable or disable Forgot Password flow
     * @default true
     */
    forgotPassword?: boolean;

    /**
     * Customize the password validation
     */
    passwordValidation?: PasswordValidation;

    /**
     * Enable or disable Remember Me checkbox
     * @default false
     */
    rememberMe?: boolean;

    /**
     * Enable or disable Username support
     * @default false
     */
    username?: boolean;
};

// Delete User Configuration Types (from delete-user-options.ts)
export type DeleteUserOptions = {
    /**
     * Enable or disable email verification for account deletion
     * @default undefined
     */
    verification?: boolean;
};

export type AuthCardProps = { className?: string; classNames?: AuthCardClassNames };
