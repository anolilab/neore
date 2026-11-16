/**
 * Enough for one key per machine/integration; a runaway script cannot fill the table.
 * Its own module so `cli-device-auth.ts` can share it without importing `api-keys.ts`
 * (which imports the auth instance that installs the CLI plugin).
 */
export const MAX_API_KEYS_PER_USER = 25;
