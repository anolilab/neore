/** Text that is handed out only once no masked value can still reach into it. */
/** What one child may say in text or reasoning, each. The backend keeps the same cap. */
export const MAX_CHILD_TEXT = 64_000;

/** A text stream that hands out only what no masked value can still reach into. */
export class MaskedStream {
    private full = "";

    private sent = 0;

    public constructor(private readonly options: { scrub: (text: string) => string; secretLength: number }) {}

    /** Whether the child streamed anything at all, shown yet or held back. */
    public get isEmpty(): boolean {
        return this.full === "";
    }

    /** The newly safe part of the text, or "" when nothing is. `final` releases what was held back. */
    public take(chunk: string, final = false): string {
        if (this.full.length < MAX_CHILD_TEXT) {
            this.full = (this.full + chunk).slice(0, MAX_CHILD_TEXT);
        }

        const { scrub, secretLength } = this.options;
        const masked = secretLength === 0 ? this.full : scrub(this.full);
        const end = final || secretLength === 0 ? masked.length : Math.max(0, masked.length - (secretLength - 1));

        if (end <= this.sent) {
            return "";
        }

        const delta = masked.slice(this.sent, end);

        this.sent = end;

        return delta;
    }
}
