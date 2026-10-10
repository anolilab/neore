/**
 * Shared SHA-256 utility for test helpers.
 */
export const sha256Hex = async (data: string): Promise<string> => {
    const buffer = new TextEncoder().encode(data);
    const hash = await crypto.subtle.digest("SHA-256", buffer);

    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
