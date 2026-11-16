// domino ships a declaration file that is not a module, so type its one export here.
// Tests and the bench only: the production code has no domino import.
declare module "@mixmark-io/domino" {
    export function createDocument(html?: string): Document;
}
