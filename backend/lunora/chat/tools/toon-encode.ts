/**
 * TOON (Token-Oriented Object Notation) encoding utility for tool outputs.
 *
 * Converts structured JSON tool outputs to TOON format before sending to LLMs.
 * TOON achieves ~40-60% token reduction on arrays of uniform objects by declaring
 * field names once as headers, then using CSV-like rows for data.
 * @see https://github.com/toon-format/toon
 */
import { encode } from "@toon-format/toon";

/**
 * Encode a tool output as TOON text for LLM consumption.
 * Returns a ToolResultOutput with type "text" containing the TOON-encoded string.
 */
const toonEncodeOutput = (output: unknown): { type: "text"; value: string } => {
    return {
        type: "text" as const,
        // `{ keyFolding: "safe" }` was passed here and is not an option this encoder
        // accepts — an unknown key in an options object is silently ignored at
        // runtime, so the setting never did anything.
        value: encode(output),
    };
};

export default toonEncodeOutput;
