/**
 * Guardrail pipeline — PII masking and prompt injection detection.
 *
 * Workers-compatible (no Node.js APIs). Regex-only, no ML models.
 * Target scan latency: < 2ms on typical messages.
 */
import type { ModelMessage } from "ai";

export type GuardrailAction = "allow" | "mask" | "block";

export type GuardrailViolation = {
    detail: string;
    position?: number;
    type: "pii" | "injection" | "sensitive";
};

export interface GuardrailResult {
    action: GuardrailAction;
    /** Only present when action === 'mask' */
    maskedContent?: string;
    passed: boolean;
    violations: GuardrailViolation[];
}

export interface GuardrailConfig {
    injection: "allow" | "block";
    pii: GuardrailAction;
}

export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
    injection: "block",
    pii: "mask",
};

// PII patterns

type PiiRule = {
    flags: string;
    label: string;
    /** Pattern source — recreated as /g per call to avoid shared-lastIndex bugs */
    source: string;
    type: string;
};

// Rules ordered by specificity — API_KEY first so its replacement prevents
// phone/credit-card regexes from matching digit-heavy key substrings.
const PII_RULES: PiiRule[] = [
    {
        flags: "g",
        label: "API key",
        source: "(sk-|gk_|AIza|AKIA)[A-Za-z0-9]{16,}",
        type: "API_KEY",
    },
    {
        flags: "g",
        label: "email address",
        source: String.raw`[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}`,
        type: "EMAIL",
    },
    {
        flags: "g",
        label: "social security number",
        source: String.raw`\b\d{3}-\d{2}-\d{4}\b`,
        type: "SSN",
    },
    {
        flags: "g",
        label: "phone number",
        // Requires separator characters between groups to reduce false-positives
        // on contiguous digit strings (e.g. inside API keys).
        source: String.raw`(\+?1[\s.\-])?(\(?[0-9]{3}\)?[\s.\-])[0-9]{3}[\s.\-][0-9]{4}|\b(\+?1)?\(?[0-9]{3}\)?[\s.\-][0-9]{3}[\s.\-][0-9]{4}\b`,
        type: "PHONE",
    },
    {
        flags: "g",
        label: "credit card number",
        source: String.raw`\b(?:\d[ \-]?){13,16}\b`,
        type: "CREDIT_CARD",
    },
];

// Injection patterns

const INJECTION_PATTERNS: { detail: string; flags: string; source: string }[] = [
    {
        detail: "instruction override attempt",
        flags: "gi",
        source: String.raw`ignore\s+(all\s+|previous\s+|above\s+)?(instructions?|prompts?|rules?)`,
    },
    {
        detail: "persona override attempt",
        flags: "gi",
        source: String.raw`you\s+are\s+now\b|you\s+must\s+now\b`,
    },
    {
        detail: "context wipe attempt",
        flags: "gi",
        source: String.raw`forget\s+(everything|all|your)`,
    },
    {
        detail: "jailbreak attempt",
        flags: "gi",
        source: String.raw`system\s+prompt\s+override|jailbreak|DAN\s+mode`,
    },
    {
        detail: "XML injection attempt",
        flags: "gi",
        source: String.raw`<\/?(system|instructions?|prompt)>`,
    },
];

// PII scanning

const scanPiiText = (text: string, action: GuardrailAction): { masked: string; violations: GuardrailViolation[] } => {
    const violations: GuardrailViolation[] = [];
    let masked = text;

    for (const rule of PII_RULES) {
        // Only the first hit is reported; the mask pass below replaces every occurrence.
        const match = new RegExp(rule.source, rule.flags).exec(text);

        if (match === null) {
            continue;
        }

        violations.push({ detail: `${rule.label} detected`, position: match.index, type: "pii" });

        if (action === "mask") {
            const placeholder = `[REDACTED:${rule.type}]`;

            masked = masked.replace(new RegExp(rule.source, rule.flags), () => placeholder);
        }
    }

    return { masked, violations };
};

// Injection scanning

const scanInjectionText = (text: string): GuardrailViolation[] => {
    const violations: GuardrailViolation[] = [];

    for (const pattern of INJECTION_PATTERNS) {
        const re = new RegExp(pattern.source, pattern.flags);
        const match = re.exec(text);

        if (match) {
            violations.push({ detail: pattern.detail, position: match.index, type: "injection" });
        }
    }

    return violations;
};

// Extract text from AI SDK ModelMessage

const extractMessageText = (message: ModelMessage): string[] => {
    const texts: string[] = [];

    if (message.role === "user" || message.role === "system") {
        const { content } = message;

        if (typeof content === "string") {
            texts.push(content);
        } else if (Array.isArray(content)) {
            for (const part of content) {
                if (typeof part === "object" && part !== null && "type" in part && (part as { type: string }).type === "text") {
                    texts.push((part as { text: string; type: "text" }).text);
                }
            }
        }
    }

    return texts;
};

// Public API

/**
 * Scan all user/system message content before forwarding to LLM provider.
 *
 * Returns maskedMessages when any text was masked (only differs from input when
 * config.pii === 'mask' and PII was found).
 */
export const scanInput = (
    messages: ModelMessage[],
    config: GuardrailConfig = DEFAULT_GUARDRAIL_CONFIG,
): GuardrailResult & { maskedMessages?: ModelMessage[] } => {
    const allViolations: GuardrailViolation[] = [];
    const maskedMessages: ModelMessage[] = [];
    let isAnyMasked = false;

    for (const message of messages) {
        const texts = extractMessageText(message);

        if (texts.length === 0) {
            maskedMessages.push(message);
            continue;
        }

        // Injection check (higher severity — block immediately)
        if (config.injection === "block") {
            for (const text of texts) {
                const injViolations = scanInjectionText(text);

                if (injViolations.length > 0) {
                    return { action: "block", passed: false, violations: injViolations };
                }
            }
        }

        // PII check
        if (config.pii === "allow") {
            maskedMessages.push(message);
        } else {
            let maskedMessage: ModelMessage = message;

            for (const text of texts) {
                const { masked, violations } = scanPiiText(text, config.pii);

                if (violations.length > 0) {
                    allViolations.push(...violations);

                    if (config.pii === "block") {
                        return { action: "block", passed: false, violations: allViolations };
                    }

                    // Mask: rebuild message content with redacted text
                    if (masked !== text) {
                        isAnyMasked = true;
                        const { content } = message;

                        if (typeof content === "string") {
                            maskedMessage = { ...message, content: masked } as ModelMessage;
                        } else if (Array.isArray(content)) {
                            const newContent = content.map((part) => {
                                if (
                                    typeof part === "object" &&
                                    part !== null &&
                                    "type" in part &&
                                    (part as { type: string }).type === "text" &&
                                    (part as { text: string; type: "text" }).text === text
                                ) {
                                    return { ...(part as { text: string; type: "text" }), text: masked };
                                }

                                return part;
                            });

                            maskedMessage = { ...message, content: newContent } as ModelMessage;
                        }
                    }
                }
            }

            maskedMessages.push(maskedMessage);
        }
    }

    if (allViolations.length > 0 && config.pii === "mask") {
        return {
            action: "mask",
            maskedMessages: isAnyMasked ? maskedMessages : undefined,
            passed: true,
            violations: allViolations,
        };
    }

    return { action: "allow", passed: true, violations: allViolations };
};

/**
 * Scan LLM output text for PII before returning to client.
 */
export const scanOutput = (text: string, config: GuardrailConfig = DEFAULT_GUARDRAIL_CONFIG): GuardrailResult => {
    if (config.pii === "allow") {
        return { action: "allow", passed: true, violations: [] };
    }

    const { masked, violations } = scanPiiText(text, config.pii);

    if (violations.length === 0) {
        return { action: "allow", passed: true, violations: [] };
    }

    if (config.pii === "block") {
        return { action: "block", passed: false, violations };
    }

    return { action: "mask", maskedContent: masked, passed: true, violations };
};

/**
 * Parse `guardrails` field from request body.
 * Returns null to disable guardrails (allowed only for HMAC-authenticated internal requests).
 */
export const parseGuardrailsConfig = (raw: unknown): GuardrailConfig | null => {
    if (raw === false) return null;

    if (raw === undefined || raw === null) return DEFAULT_GUARDRAIL_CONFIG;

    const object = raw as Partial<GuardrailConfig>;

    return {
        injection: object["injection"] ?? DEFAULT_GUARDRAIL_CONFIG.injection,
        pii: object["pii"] ?? DEFAULT_GUARDRAIL_CONFIG.pii,
    };
};
