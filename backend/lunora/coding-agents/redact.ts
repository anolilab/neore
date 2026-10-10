/**
 * Secret redaction for everything a coding-agent run persists or returns.
 *
 * The agent runs untrusted code with the user's provider key in its environment,
 * so its output can contain that key — `env`, a debug print, an error echoing a
 * header. Every byte leaving the sandbox (log, summary, diff, error) passes
 * through {@link redactSecrets} before it is written anywhere.
 *
 * Two layers: the exact secrets this run was given (and their derived forms,
 * such as git's Basic credential), and well-known token shapes as a backstop
 * for keys we did not hand in ourselves.
 */
import { githubBasicCredential } from "./commands";

export const REDACTED = "[REDACTED]";

/** Shorter values are not treated as secrets: redacting them would mangle ordinary text. */
const MIN_SECRET_LENGTH = 8;

const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
    /sk-ant-[\w-]{10,}/gu,
    /sk-[\w-]{20,}/gu,
    /gh[pousr]_[A-Za-z0-9]{20,}/gu,
    /github_pat_\w{20,}/gu,
    /(authorization:\s*(?:basic|bearer)\s+)[\w+/=.-]{8,}/giu,
];

/** The run's secrets plus every form in which they can surface. */
export const expandSecrets = (secrets: ReadonlyArray<string | undefined>): string[] => {
    const forms = new Set<string>();

    for (const secret of secrets) {
        if (!secret || secret.length < MIN_SECRET_LENGTH) {
            continue;
        }

        forms.add(secret);
        forms.add(githubBasicCredential(secret));
        forms.add(encodeURIComponent(secret));
    }

    // Longest first, so a secret containing another is replaced whole.
    return [...forms].filter((form) => form.length >= MIN_SECRET_LENGTH).toSorted((a, b) => b.length - a.length);
};

export const redactSecrets = (text: string, secrets: ReadonlyArray<string>): string => {
    let result = text;

    for (const secret of secrets) {
        // split/join, not replaceAll: a secret is data, and `$&`-style patterns in it must stay literal.
        if (result.includes(secret)) {
            result = result.split(secret).join(REDACTED);
        }
    }

    for (const pattern of TOKEN_PATTERNS) {
        result = result.replace(pattern, (match, prefix?: string) =>
            typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED,
        );
    }

    return result;
};
