/**
 * The organization policy document: what an organization's owner may lock or
 * cap for every member.
 *
 * `v.object` strips unknown keys, so a validator would accept a typo and drop
 * it silently. The document therefore arrives as raw JSON text and is checked
 * here, key by key, and a write is refused unless every key is known. What is
 * stored is the canonical re-serialisation of the parsed result, so code that
 * reads it back can assume a valid document.
 */
import { compareStrings } from "../../lib/collections";
import { MAX_LENGTH } from "../../lib/validators";

export const POLICY_SCHEMA_VERSION = 1;

/** The policy is small by design; every write is also snapshotted into the audit history. */
export const MAX_POLICY_CHARS = 64_000;

export const MAX_ALLOWED_MODELS = 200;

export const PERMISSION_CAPS = ["off", "ask", "auto"] as const;

export type PermissionCap = (typeof PERMISSION_CAPS)[number];

/**
 * The settings an owner may default or lock, and the type of each value. A key
 * is added here only together with the write path that enforces it.
 */
export const MANAGED_SETTINGS = {
    autoApproveLowRisk: "boolean",
    dailyBriefEnabled: "boolean",
    memoryEnabled: "boolean",
    resumeInterruptedRuns: "boolean",
    threadSummariesEnabled: "boolean",
} as const satisfies Record<string, "boolean">;

export type ManagedSettingKey = keyof typeof MANAGED_SETTINGS;

export type SettingPolicy = {
    /** `false`: a default members may change. `true`: a value they may not change. */
    locked: boolean;
    value: boolean;
};

export type OrganizationPolicy = {
    models?: { allowed: string[] };
    permissionCap?: PermissionCap;
    schemaVersion: typeof POLICY_SCHEMA_VERSION;
    settings?: Record<string, SettingPolicy>;
};

export type PolicyParseResult = { error: string; ok: false } | { ok: true; policy: OrganizationPolicy };

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["models", "permissionCap", "schemaVersion", "settings"]);
const MODELS_KEYS: ReadonlySet<string> = new Set(["allowed"]);
const SETTING_KEYS: ReadonlySet<string> = new Set(["locked", "value"]);

const fail = (error: string): PolicyParseResult => {
    return { error, ok: false };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A key name from the document, shortened so an error never repeats a long string. */
const show = (key: string): string => JSON.stringify(key.length > 40 ? `${key.slice(0, 40)}…` : key);

const unknownKey = (keys: ReadonlyArray<string>, allowed: ReadonlySet<string>): string | undefined => keys.find((key) => !allowed.has(key));

const isManagedSetting = (key: string): key is ManagedSettingKey => Object.hasOwn(MANAGED_SETTINGS, key);

const parseModels = (value: unknown): { error: string } | { models: { allowed: string[] } } => {
    if (!isRecord(value)) {
        return { error: "models must be an object" };
    }

    const stray = unknownKey(Object.keys(value), MODELS_KEYS);

    if (stray !== undefined) {
        return { error: `models has an unknown key ${show(stray)}` };
    }

    const { allowed } = value;

    if (!Array.isArray(allowed)) {
        return { error: "models.allowed must be a list of model ids" };
    }

    if (allowed.length === 0) {
        return { error: "models.allowed must not be empty; leave out models to lift the lock" };
    }

    if (allowed.length > MAX_ALLOWED_MODELS) {
        return { error: `models.allowed holds more than ${String(MAX_ALLOWED_MODELS)} model ids` };
    }

    const seen = new Set<string>();

    for (const entry of allowed) {
        if (typeof entry !== "string" || entry === "" || entry.trim() !== entry || entry.length > MAX_LENGTH.short) {
            return { error: "models.allowed must hold non-empty model ids without surrounding spaces" };
        }

        if (seen.has(entry)) {
            return { error: `models.allowed lists ${show(entry)} twice` };
        }

        seen.add(entry);
    }

    return { models: { allowed: [...allowed] as string[] } };
};

const parseSettings = (value: unknown): { error: string } | { settings: Record<string, SettingPolicy> } => {
    if (!isRecord(value)) {
        return { error: "settings must be an object" };
    }

    const settings: Record<string, SettingPolicy> = {};

    for (const key of Object.keys(value).toSorted(compareStrings)) {
        if (!isManagedSetting(key)) {
            return { error: `settings.${show(key)} is not a managed setting` };
        }

        const entry = value[key];

        if (!isRecord(entry)) {
            return { error: `settings.${key} must be an object` };
        }

        const stray = unknownKey(Object.keys(entry), SETTING_KEYS);

        if (stray !== undefined) {
            return { error: `settings.${key} has an unknown key ${show(stray)}` };
        }

        const { locked, value: settingValue } = entry;

        if (typeof locked !== "boolean") {
            return { error: `settings.${key}.locked must be true or false` };
        }

        if (typeof settingValue !== MANAGED_SETTINGS[key]) {
            return { error: `settings.${key}.value must be a ${MANAGED_SETTINGS[key]}` };
        }

        settings[key] = { locked, value: settingValue as boolean };
    }

    return { settings };
};

/** Parse and validate a policy document. Nothing is stored unless the result is `ok`. */
export const parseOrganizationPolicy = (text: string): PolicyParseResult => {
    if (text.length > MAX_POLICY_CHARS) {
        return fail(`The policy is larger than ${String(MAX_POLICY_CHARS)} characters`);
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch {
        return fail("The policy is not valid JSON");
    }

    if (!isRecord(parsed)) {
        return fail("The policy must be a JSON object");
    }

    const stray = unknownKey(Object.keys(parsed), TOP_LEVEL_KEYS);

    if (stray !== undefined) {
        return fail(`The policy has an unknown key ${show(stray)}`);
    }

    if (!Object.hasOwn(parsed, "schemaVersion")) {
        return fail("schemaVersion is required");
    }

    if (parsed["schemaVersion"] !== POLICY_SCHEMA_VERSION) {
        return fail(`schemaVersion must be ${String(POLICY_SCHEMA_VERSION)}`);
    }

    const policy: OrganizationPolicy = { schemaVersion: POLICY_SCHEMA_VERSION };

    if (Object.hasOwn(parsed, "models")) {
        const models = parseModels(parsed["models"]);

        if ("error" in models) {
            return fail(models.error);
        }

        policy.models = models.models;
    }

    if (Object.hasOwn(parsed, "settings")) {
        const settings = parseSettings(parsed["settings"]);

        if ("error" in settings) {
            return fail(settings.error);
        }

        policy.settings = settings.settings;
    }

    if (Object.hasOwn(parsed, "permissionCap")) {
        const cap = parsed["permissionCap"];

        if (typeof cap !== "string" || !(PERMISSION_CAPS as ReadonlyArray<string>).includes(cap)) {
            return fail(`permissionCap must be one of ${PERMISSION_CAPS.join(", ")}`);
        }

        policy.permissionCap = cap as PermissionCap;
    }

    return { ok: true, policy };
};

/** The text a valid policy is stored as. Key order is fixed by the parser, so equal policies store equal text. */
export const serializeOrganizationPolicy = (policy: OrganizationPolicy): string => JSON.stringify(policy);
