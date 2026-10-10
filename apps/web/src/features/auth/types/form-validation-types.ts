import type { ReactNode } from "react";

// Password Validation Configuration (from password-validation.ts)
export type PasswordValidation = {
    /**
     * Maximum password length
     */
    maxLength?: number;

    /**
     * Minimum password length
     */
    minLength?: number;

    /**
     * Password validation regex
     */
    regex?: RegExp;
};

// Additional Form Fields Configuration (from additional-fields.ts)
export type FieldType = "string" | "number" | "boolean";

export interface AdditionalField {
    description?: ReactNode;
    instructions?: ReactNode;
    label: ReactNode;
    placeholder?: string;
    required?: boolean;
    type: FieldType;
    validate?: (value: string) => Promise<boolean>;
}

export interface AdditionalFields {
    [key: string]: AdditionalField;
}

// Captcha Provider Configuration (from captcha-provider.ts)
export type CaptchaProvider = "cloudflare-turnstile" | "hcaptcha";
