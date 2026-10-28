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
 * Where on-device dictation is offered: the platforms whose speech helper is built, packaged and tested in CI (S2 to S4).
 * Anywhere else settings says so and dictation stays off, whatever else is on the machine. Windows on ARM is not here until the
 * clang-cl build's measured speed on the default model is inside the budget in plans/desktop-dictation.md (S4); then it is one line.
 */
const SUPPORTED = new Set(["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"]);

const UNSUPPORTED_REASONS: Record<string, string> = {
    "darwin-x64": "On-device dictation is not available on Intel Macs yet.",
    "win32-arm64": "On-device dictation is not available on Windows on ARM yet: it is still being tested there.",
};

/** Why this platform is not offered on-device dictation, or `undefined` where it is. */
export const unsupportedReason = (platform: NodeJS.Platform, arch: string): string | undefined =>
    SUPPORTED.has(`${platform}-${arch}`) ? undefined : UNSUPPORTED_REASONS[`${platform}-${arch}`] ?? "On-device dictation is not available on this system.";

/** One model as settings offers it on this machine. */
export interface OfferedModel {
    isDefault: boolean;
    /** What a person should know before choosing it; shown beside the choice. */
    note: string;
    spec: ModelSpec;
}

/**
 * Apple Silicon runs the large model on the GPU in seconds, so it is the default there and the only choice that matters.
 * Every other machine runs the CPU: small is the default (about 7 s for a 10 s clip on four cores), and the large model
 * is offered as the slower, more accurate one (Appendix A).
 */
export const offeredModels = (platform: NodeJS.Platform, arch: string): OfferedModel[] =>
    platform === "darwin" && arch === "arm64"
        ? [
            { isDefault: true, note: "Fast and accurate in all supported languages on this Mac.", spec: LARGE_V3_TURBO_Q5 },
            { isDefault: false, note: "Smaller and faster to download, but weaker on Chinese and Italian.", spec: SMALL },
        ]
        : [
            { isDefault: true, note: "Weaker on Chinese and Italian.", spec: SMALL },
            { isDefault: false, note: "More accurate, but several times slower on a computer without a supported GPU.", spec: LARGE_V3_TURBO_Q5 },
        ];

/** The model to use: the chosen one when this machine offers it, otherwise the machine's default. */
export const resolveModel = (chosen: string | undefined, platform: NodeJS.Platform, arch: string): ModelSpec => {
    const offered = offeredModels(platform, arch);

    return (offered.find(({ spec }) => spec.id === chosen) ?? offered.find(({ isDefault }) => isDefault) ?? offered[0]).spec;
};
