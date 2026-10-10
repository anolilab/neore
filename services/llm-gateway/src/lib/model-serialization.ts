/**
 * Serialization helpers for LanguageModelV3 call options and results.
 *
 * Handles non-JSON-safe types (Uint8Array, URL) that appear in file parts
 * of prompts and results. Both the backend (serialize) and Gateway (deserialize)
 * use the same tagged format.
 */

// ── Tagged wire format for binary/URL data ──────────────────────────────────

interface TaggedBase64 {
    __gwType: "uint8array";
    data: string; // base64
}

interface TaggedURL {
    __gwType: "url";
    href: string;
}

interface TaggedDate {
    __gwType: "date";
    iso: string;
}

type TaggedData = TaggedBase64 | TaggedURL | TaggedDate;

const isTagged = (value: unknown): value is TaggedData => typeof value === "object" && value !== null && "__gwType" in value;

// ── Serialize (backend side or shared) ───────────────────────────────────────

/**
 * Deep-walk an object and convert Uint8Array/URL values to tagged JSON form.
 * Also strips `abortSignal` since it can't cross HTTP boundaries.
 */
export const serializeForWire = <T>(object: T): T => {
    if (object === null || object === undefined) return object;

    if (object instanceof Uint8Array) {
        return { __gwType: "uint8array", data: uint8ArrayToBase64(object) } as unknown as T;
    }

    if (object instanceof Date) {
        return { __gwType: "date", iso: object.toISOString() } as unknown as T;
    }

    if (object instanceof URL) {
        return { __gwType: "url", href: object.toString() } as unknown as T;
    }

    if (Array.isArray(object)) {
        return object.map((item) => serializeForWire(item)) as unknown as T;
    }

    if (typeof object === "object") {
        // `abortSignal` is stripped — it cannot cross an HTTP boundary.
        return Object.fromEntries(
            Object.entries(object)
                .filter(([key]) => key !== "abortSignal")
                .map(([key, value]) => [key, serializeForWire(value)]),
        ) as T;
    }

    return object;
};

// ── Deserialize (Gateway side) ───────────────────────────────────────────────

/**
 * Deep-walk a deserialized JSON object and restore Uint8Array/URL values.
 */
export const deserializeFromWire = <T>(object: T): T => {
    if (object === null || object === undefined) return object;

    if (isTagged(object)) {
        if (object.__gwType === "uint8array") {
            return base64ToUint8Array(object.data) as unknown as T;
        }

        if (object.__gwType === "date") {
            return new Date(object.iso) as unknown as T;
        }

        if (object.__gwType === "url") {
            return new URL(object.href) as unknown as T;
        }
    }

    if (Array.isArray(object)) {
        return object.map((item) => deserializeFromWire(item)) as unknown as T;
    }

    if (typeof object === "object") {
        return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, deserializeFromWire(value)])) as T;
    }

    return object;
};

// ── Base64 helpers ───────────────────────────────────────────────────────────

const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
    let binary = "";

    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCodePoint(bytes[i]!);
    }

    return btoa(binary);
};

const base64ToUint8Array = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.codePointAt(i) ?? 0;
    }

    return bytes;
};
