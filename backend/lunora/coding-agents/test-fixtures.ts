/**
 * Fake credentials for the coding-agent tests. None of them is real.
 *
 * Built from parts at runtime so no key-shaped literal sits in the source for
 * the secret scanners (`vis secrets`, the codegen advisor) to flag.
 *
 * - `fakeKey("anthropic" | "openai" | "github")` — obviously fake values that
 *   match NO known token shape, so a test redacting one proves the EXACT-value
 *   path did it, not the pattern backstop.
 * - `fakeShapedKey(...)` — values in a real provider's shape, for testing the
 *   pattern backstop itself.
 */

const PARTS = {
    anthropic: ["test", "anthropic", "key", "not", "real", "0001"],
    github: ["test", "github", "token", "not", "real", "0001"],
    openai: ["test", "openai", "key", "not", "real", "0001"],
} as const;

export const fakeKey = (kind: keyof typeof PARTS): string => PARTS[kind].join("-");

const SHAPES = {
    "anthropic-shaped": ["sk", "ant", "api03", "fakefakefakefake"],
    "github-oauth-shaped": ["gho", "fakefakefakefakefakefake"],
    "github-pat-shaped": ["github", "pat", "FAKE0FAKE0FAKE0FAKE0FAKE0"],
    "github-personal-shaped": ["ghp", "fakefakefakefakefakefake"],
    "openai-shaped": ["sk", "proj", "fakefakefakefakefakefake"],
} as const;

const SEPARATOR: Record<keyof typeof SHAPES, string> = {
    "anthropic-shaped": "-",
    "github-oauth-shaped": "_",
    "github-pat-shaped": "_",
    "github-personal-shaped": "_",
    "openai-shaped": "-",
};

export const fakeShapedKey = (shape: keyof typeof SHAPES): string => SHAPES[shape].join(SEPARATOR[shape]);

/** An Authorization header with a fake bearer value. */
export const fakeBearerHeader = (): string => ["Authorization:", "Bearer", ["fake", "bearer", "value"].join(".")].join(" ");
