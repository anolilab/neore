/**
 * Messenger pairing: who a bot answers.
 *
 * A bot's webhook signature proves the PLATFORM sent a message, not that the
 * sender may spend the owner's BYOK key. The connection used to lock onto the
 * first sender it saw, so whoever found the bot first owned it. Now a new (or
 * re-paired) connection answers nobody until someone sends `/pair <code>`
 * with the one-time code the owner sees in settings; that sender becomes the
 * connection's contact. The code is stored only as a SHA-256 hash and expires.
 *
 * Pure helpers here; the gate that uses them is `messenger/pairing.ts`.
 */
import { sha256Hex } from "../../lib/crypto";

/** How long a pairing code stays valid. */
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

/** No 0/O, 1/I/L: the code is read off a screen and typed into a chat. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

/** A fresh code, e.g. `K7QM-2XPA` (~39 bits). */
export const generatePairingCode = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    const chars = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length] as string);

    return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
};

/** Case, spaces and the dash do not matter when the code is typed back. */
export const normalizePairingCode = (code: string): string => code.toUpperCase().replaceAll(/[^0-9A-Z]/gu, "");

export const hashPairingCode = async (code: string): Promise<string> => await sha256Hex(`messenger-pairing:${normalizePairingCode(code)}`);

/** `/pair K7QM-2XPA`, `pair k7qm2xpa`, or Telegram's `/pair@my_bot K7QM-2XPA`. */
const PAIR_COMMAND = /^\s*\/?pair(?:@\S+)?\s+([\w-]{4,32})\s*$/iu;

/** The code in a pairing command, or `null` when the text is not one. */
export const parsePairCommand = (text: string | undefined): string | null => {
    const match = text ? PAIR_COMMAND.exec(text) : null;

    return match?.[1] ?? null;
};

export const PRIVATE_BOT_NOTICE = "This bot is private. If it is yours, send /pair followed by the code shown in your Neore messenger settings.";
export const PAIRED_NOTICE = "Paired. This chat is now connected to your Neore account — send a message to start.";
