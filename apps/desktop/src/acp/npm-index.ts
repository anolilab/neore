/**
 * What the npm package index says about one exact version of a package: the hash and address of its tarball.
 * The ACP registry carries neither for an `npx` agent, so this is the only integrity there is, and it is the
 * index's word at the moment of the lookup, not the publisher's (trust on first use). It is read BEFORE the person
 * confirms and shown to them; the download is later checked against exactly this value by the core.
 */

import { fetchHttps, readCapped } from "./registry";

export const NPM_REGISTRY = "https://registry.npmjs.org";

const LOOKUP_TIMEOUT_MS = 15_000;
const MAX_METADATA_BYTES = 5 * 1024 * 1024;
/** `sha512-` and 64 bytes of base64 (88 characters with padding), the form npm publishes. */
const INTEGRITY = /^sha512-[\d+/A-Za-z]{86}==$/u;

export interface NpmIndexEntry {
    /** `sha512-&lt;base64>`, from the index's `dist.integrity`. */
    integrity: string;
    tarball: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The index address of one version; a scoped name keeps its `@` and encodes the slash. */
export const npmVersionUrl = (name: string, version: string): string => `${NPM_REGISTRY}/${name.replace("/", "%2F")}/${encodeURIComponent(version)}`;

/**
 * Looks up `name@version`. Refuses an answer for another name or version, a version with no SHA-512 integrity
 * (older packages publish only a SHA-1, which is not enough to pin), and a tarball that is not served over https
 * from the index itself.
 */
export const lookupNpmIntegrity = async (fetchImpl: typeof fetch, name: string, version: string): Promise<NpmIndexEntry> => {
    const response = await fetchHttps(fetchImpl, npmVersionUrl(name, version), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });

    if (!response.ok) {
        await response.body?.cancel();

        throw new Error(response.status === 404 ? `The package index does not list ${name} ${version}.` : `The package index answered ${String(response.status)}.`);
    }

    const body: unknown = JSON.parse(await readCapped(response, MAX_METADATA_BYTES));

    if (!isRecord(body) || body.name !== name || body.version !== version) {
        throw new Error(`The package index answered for a different package or version than ${name} ${version}.`);
    }

    const dist = isRecord(body.dist) ? body.dist : {};
    const { integrity, tarball } = dist;

    if (typeof integrity !== "string" || !INTEGRITY.test(integrity)) {
        throw new Error(`The package index publishes no SHA-512 integrity for ${name} ${version}, so Neore cannot verify the download.`);
    }

    if (typeof tarball !== "string") {
        throw new TypeError(`The package index gives no download for ${name} ${version}.`);
    }

    let url: URL;

    try {
        url = new URL(tarball);
    } catch {
        throw new Error("The package index gave a download address that is not a valid URL.");
    }

    if (url.protocol !== "https:" || url.host !== new URL(NPM_REGISTRY).host) {
        throw new Error("The package index points the download somewhere other than itself over https.");
    }

    return { integrity, tarball: url.href };
};
