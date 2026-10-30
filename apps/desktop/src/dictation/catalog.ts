/**
 * The speech models the desktop can download, pinned. The checksum ships in the build and is never
 * fetched: a model is used only if its bytes hash to the value here (plans/desktop-dictation.md §3, §5).
 * Sizes and checksums are from the benchmark in the plan's Appendix A.
 */
export interface ModelSpec {
    /** Exact size in bytes; a download that passes it is aborted. */
    bytes: number;
    /** The file name under the model folder. */
    file: string;
    id: string;
    /** For a person: "Large v3 turbo (quantised)". */
    label: string;
    sha256: string;
    url: string;
    /** The upstream repository revision the URL and checksum were taken at. */
    version: string;
}

// ggerganov/whisper.cpp on Hugging Face at one commit, so `main` moving cannot change what is fetched.
const MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const modelUrl = (file: string): string => `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/${file}`;

export const LARGE_V3_TURBO_Q5: ModelSpec = {
    bytes: 574_041_195,
    file: "ggml-large-v3-turbo-q5_0.bin",
    id: "large-v3-turbo-q5_0",
    label: "Large v3 turbo (quantised)",
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    url: modelUrl("ggml-large-v3-turbo-q5_0.bin"),
    version: MODEL_REVISION,
};

export const SMALL: ModelSpec = {
    bytes: 487_601_967,
    file: "ggml-small.bin",
    id: "small",
    label: "Small",
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    url: modelUrl("ggml-small.bin"),
    version: MODEL_REVISION,
};

/**
 * Apple Silicon runs the large model on the GPU in seconds; every other machine runs the CPU and
 * gets the small one (Appendix A). Choosing a model is a settings matter (S3); until then this decides.
 */
export const modelFor = (platform: NodeJS.Platform, arch: string): ModelSpec => platform === "darwin" && arch === "arm64" ? LARGE_V3_TURBO_Q5 : SMALL;
