/**
 * Shared types for the multi-reference image picker.
 *
 * Lives in a standalone file so the store, composer, and dialog can import
 * without pulling the dialog's React tree.
 */

export type ReferenceSelection = {
    id: string;
    mimeType: string;
    url: string;
};
