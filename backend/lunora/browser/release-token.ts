/**
 * The hand back a closing page sends (`POST /browser/release`). A page that unloads can only send a beacon, and a beacon
 * carries no `Authorization` header, so the request names no person. The token stands in for one: `takeControl` hands it
 * to the holder of a claim alone, next to the interactive view URL, and it is a keyed hash (the backend's signing
 * secret) over the shard, the thread and that claim. Only that claim's lease can be ended with it, and only while it is
 * still that claim's: a later claim (another of the person's tabs, or anyone else) is never touched.
 *
 * `claimIdOf` is the claim's public name, which the live status shows the holder: a hash of the claim, never the claim.
 */
import { bytesToHex, hmacSha256Hex, sha256Hex, timingSafeEqual } from "../lib/crypto";

const VERSION = "b1";

type Released = { claim: string; shardKey: string; threadId: string };

const signingSecret = (): string => process.env.STORAGE_SIGNING_SECRET ?? "";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEX = /^(?:[\da-f]{2})*$/u;
const HEX_BYTE = /../gu;

/** The fields, as hex: a token is one plain string, safe in any body or form field. */
const encodeFields = (fields: string[]): string => bytesToHex(encoder.encode(JSON.stringify(fields)));

const decodeFields = (hex: string): unknown => {
    if (!HEX.test(hex)) {
        return undefined;
    }

    return JSON.parse(decoder.decode(Uint8Array.from(hex.match(HEX_BYTE) ?? [], (byte: string) => Number.parseInt(byte, 16))));
};

const mac = async (secret: string, payload: string): Promise<string> => await hmacSha256Hex(secret, `browser-release\n${payload}`);

/** `undefined` on a deploy without the signing secret, where no lease is taken either. */
export const releaseTokenFor = async (release: Released): Promise<string | undefined> => {
    const secret = signingSecret();

    if (secret === "") {
        return undefined;
    }

    const payload = encodeFields([release.shardKey, release.threadId, release.claim]);

    return `${VERSION}.${payload}.${await mac(secret, payload)}`;
};

/** The release a token names, or `undefined` for one this backend did not sign. */
export const verifyReleaseToken = async (token: string): Promise<Released | undefined> => {
    const secret = signingSecret();
    const [version, payload, signature, ...rest] = token.split(".");

    if (secret === "" || version !== VERSION || payload === undefined || signature === undefined || rest.length > 0) {
        return undefined;
    }

    if (!timingSafeEqual(await mac(secret, payload), signature)) {
        return undefined;
    }

    try {
        const fields: unknown = decodeFields(payload);

        if (!Array.isArray(fields) || fields.length !== 3 || fields.some((field: unknown) => typeof field !== "string" || field === "")) {
            return undefined;
        }

        const [shardKey, threadId, claim] = fields as [string, string, string];

        return { claim, shardKey, threadId };
    } catch {
        return undefined;
    }
};

/** A claim's public name: the live status shows it so a tab can tell its own lease from a newer tab's. */
export const claimIdOf = async (claim: string): Promise<string> => {
    const digest = await sha256Hex(`browser-claim\n${claim}`);

    return digest.slice(0, 32);
};
