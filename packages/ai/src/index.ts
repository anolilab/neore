/**
 * Intentionally empty.
 *
 * `@neore/ai` is consumed only through its subpath exports (`./models`,
 * `./prompts`, `./design`, …). This module exists solely to keep the `"."`
 * export in `package.json` resolvable; re-exporting the subpaths from here
 * would drag every provider SDK into any consumer that touches the package.
 */
export {};
