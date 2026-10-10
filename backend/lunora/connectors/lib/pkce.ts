/**
 * PKCE (RFC 7636) and OAuth `state` primitives for the connector flow.
 *
 * Only `S256` is ever produced: the MCP authorization spec requires it, and
 * `plain` offers nothing over no PKCE at all against an attacker who can read
 * the authorization request.
 *
 * The `state` is a bearer secret for the few minutes the flow is open, so the
 * database stores its SHA-256 ({@link hashOAuthState}), never the value itself —
 * a leaked `oauthStates` row cannot be replayed into `completeConnectorOAuth`.
 */
import { sha256Hex } from "../../lib/crypto";

const toBase64Url = (bytes: Uint8Array): string => {
    const base64 = btoa(String.fromCodePoint(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_");
    let end = base64.length;

    while (end > 0 && base64[end - 1] === "=") {
        end -= 1;
    }

    return base64.slice(0, end);
};

const randomToken = (byteLength: number): string => toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));

/** 32 random bytes → 43 base64url characters, inside RFC 7636's 43..128 range. */
export const generateCodeVerifier = (): string => randomToken(32);

/** `BASE64URL(SHA256(verifier))`, the `S256` challenge. */
export const codeChallengeS256 = async (verifier: string): Promise<string> =>
    toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

/** 256 bits of entropy; unguessable, and single-use once stored. */
export const generateOAuthState = (): string => randomToken(32);

/** Hex SHA-256 of a state value — what `oauthStates.state` holds. */
export const hashOAuthState = async (state: string): Promise<string> => await sha256Hex(state);
