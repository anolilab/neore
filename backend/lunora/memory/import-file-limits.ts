/**
 * The limits a memory file is imported under, shared with the web app (`@neore/backend/memory/import-file-limits`), so the
 * settings page refuses an oversized file before sending it, by the number `importMemoryFile` checks. This file imports
 * nothing: the web app bundles it. The rules that use them are in `./import-file-logic.ts`.
 */

/**
 * Largest file accepted, in UTF-8 bytes. The file travels as a JSON string in a request body the runtime reads with a
 * 1,048,576-byte cap (a 413 before the action runs). JSON escaping grows a quote, a backslash or a line break to two
 * bytes, so a file near the runtime's own size can be refused by the transport; half of it leaves room for those. A
 * file made mostly of control characters (six bytes each once escaped) can still exceed the cap and be refused there.
 */
export const MEMORY_FILE_MAX_BYTES = 500_000;

/** Most entries (non-empty lines, or array items) one file may hold; a file with more is refused, not cut. */
export const MEMORY_FILE_MAX_ENTRIES = 5000;
