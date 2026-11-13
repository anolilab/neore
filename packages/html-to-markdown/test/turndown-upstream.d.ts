// The upstream package ships no types; only the constructor and `turndown` are used here.
declare module "turndown" {
    export default class TurndownUpstream {
        constructor(options?: { readonly [option: string]: unknown });

        turndown(input: string | Node): string;
    }
}
