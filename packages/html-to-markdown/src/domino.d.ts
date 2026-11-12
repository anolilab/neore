// domino ships a declaration file that is not a module, so type its one export here.
// TEMPORARY with domino itself (see html-parser.ts).
declare module "@mixmark-io/domino" {
    export function createDocument(html?: string): Document;
}
