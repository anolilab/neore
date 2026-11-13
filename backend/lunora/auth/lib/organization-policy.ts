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

export const isManagedSetting = (key: string): key is ManagedSettingKey => Object.hasOwn(MANAGED_SETTINGS, key);

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

/**
 * Whether any JSON object in `text` repeats a key. `JSON.parse` keeps only the
 * last of a repeated key, so every check on the parsed value would miss what the
 * earlier occurrences said.
 *
 * Only call this on text `JSON.parse` has accepted: it relies on the text being
 * well-formed. Guarantees, at any depth:
 *  - a key is a string token directly followed by `:`, so a string value or an
 *    array item that merely contains `"x":` is never read as one (the pattern
 *    consumes each string whole, escapes included);
 *  - keys are compared after decoding, so `"a"` and `"\u0061"` are one key;
 *  - each object has its own key set, so the same key in two objects is fine.
 */
const hasRepeatedKey = (text: string): boolean => {
    // One entry per open container: a key set for an object, `undefined` for an array.
    const open: (Set<string> | undefined)[] = [];
    let previous = "";

    for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[[\]{}:]/g)) {
        switch (token) {
            case ":": {
                const keys = open.at(-1);
                const key = JSON.parse(previous) as string;

                if (keys?.has(key)) {
                    return true;
                }

                keys?.add(key);
                break;
            }
            case "[": {
                open.push(undefined);
                break;
            }
            case "]":
            case "}": {
                open.pop();
                break;
            }
            case "{": {
                open.push(new Set());
                break;
            }
            default:
        }

        previous = token;
    }

    return false;
};

/** `JSON.parse` that also refuses a document repeating a key; the error never quotes the text. */
const readJson = (text: string): { error: string } | { value: unknown } => {
    let value: unknown;

    try {
        value = JSON.parse(text);
    } catch {
        return { error: "The policy is not valid JSON" };
    }

    return hasRepeatedKey(text) ? { error: "The policy repeats a key within one object" } : { value };
};

/** Parse and validate a policy document. Nothing is stored unless the result is `ok`. */
export const parseOrganizationPolicy = (text: string): PolicyParseResult => {
    if (text.length > MAX_POLICY_CHARS) {
        return fail(`The policy is larger than ${String(MAX_POLICY_CHARS)} characters`);
    }

    const json = readJson(text);

    if ("error" in json) {
        return fail(json.error);
    }

    const parsed = json.value;

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

/**
 * What the organization policy says for one caller: no policy row, a parsed
 * policy, or a stored document that no longer parses. The three are decided
 * apart because they fail in different directions: a write fails closed and a
 * read falls back to the user's own value (plans/org-policy.md, decision 2).
 */
export type PolicyState = { kind: "none" } | { kind: "policy"; policy: OrganizationPolicy } | { kind: "unreadable" };

export const NO_POLICY: PolicyState = { kind: "none" };

/** The state for a stored document, or for no row at all (`null` / `undefined`). */
export const readPolicyState = (document: string | null | undefined): PolicyState => {
    if (document === null || document === undefined) {
        return NO_POLICY;
    }

    const parsed = parseOrganizationPolicy(document);

    return parsed.ok ? { kind: "policy", policy: parsed.policy } : { kind: "unreadable" };
};

/**
 * The managed settings a patch would write that the policy locks. `undefined`
 * means "leave unchanged" (`withoutUndefined`), so it writes nothing; a key that
 * is not managed is never refused, so a corrupt policy cannot block a timezone
 * save. When the policy cannot be read, every managed key in the patch is
 * refused: the write fails closed.
 */
export const lockedKeysInPatch = (fields: Readonly<Record<string, unknown>>, state: PolicyState): ManagedSettingKey[] => {
    if (state.kind === "none") {
        return [];
    }

    return Object.keys(fields)
        .filter((key): key is ManagedSettingKey => fields[key] !== undefined && isManagedSetting(key))
        .filter((key) => state.kind === "unreadable" || state.policy.settings?.[key]?.locked === true)
        .toSorted(compareStrings);
};

/**
 * The value a read should see: the locked value when the policy locks the key;
 * otherwise the user's own value, falling back to the policy's default when the
 * user never chose one. A policy that cannot be read keeps the user's value.
 * Callers keep their own meaning for `undefined` (`?? false`, `!== false`).
 */
export const effectiveSetting = (key: ManagedSettingKey, userValue: boolean | undefined, state: PolicyState): boolean | undefined => {
    if (state.kind !== "policy") {
        return userValue;
    }

    const entry = state.policy.settings?.[key];

    if (entry === undefined) {
        return userValue;
    }

    return entry.locked ? entry.value : (userValue ?? entry.value);
};

/**
 * The broadest tool mode an organization's runs may use (`org-policy.md` §6a). No row, or a policy that sets no
 * `permissionCap`, allows `auto`. A stored document that no longer parses allows only `ask`: a policy that cannot be
 * read must not lift the cap, and `ask` keeps the run usable with a person approving each tool.
 */
export const permissionCapOf = (state: PolicyState): PermissionCap => {
    if (state.kind === "unreadable") {
        return "ask";
    }

    return state.kind === "policy" ? (state.policy.permissionCap ?? "auto") : "auto";
};

/** The owner-facing reason a run of an organization's trigger, task or worker is refused after its owner left that organization. */
export const LEFT_ORGANIZATION_MESSAGE =
    "You are no longer a member of the organization this was created in, so it has been stopped. Create it again in your personal space to keep it running.";
