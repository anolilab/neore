/**
 * HEIC and HEIF photos, which most browsers cannot decode, are re-encoded as JPEG before upload: the upload route
 * takes JPEG, not HEIC. The decoder is imported only when a HEIC file is picked, so it stays out of the main bundle.
 */
const HEIC_TYPES: ReadonlySet<string> = new Set(["image/heic", "image/heic-sequence", "image/heif", "image/heif-sequence"]);
const HEIC_NAME_RE = /\.(?:heic|heif)$/iu;
const JPEG_QUALITY = 0.92;

/** A HEIC or HEIF file, by its declared type or, where the browser gives none, by its name. */
export const isHeicFile = (file: Pick<File, "name" | "type">): boolean => HEIC_TYPES.has(file.type.toLowerCase()) || HEIC_NAME_RE.test(file.name);

/** The name a converted photo is uploaded under: the same name with a `.jpg` extension. */
export const jpegNameFor = (name: string): string => `${name.replace(HEIC_NAME_RE, "")}.jpg`;

/**
 * The file as JPEG. A HEIC or HEIF file is converted; any other file comes back as it is. A file the decoder
 * cannot read rejects, so the caller can refuse it with a message.
 */
export const convertHeicToJpeg = async (file: File): Promise<File> => {
    if (!isHeicFile(file)) {
        return file;
    }

    const { heicTo } = await import("heic-to");
    const blob = await heicTo({ blob: file, quality: JPEG_QUALITY, type: "image/jpeg" });

    return new File([blob], jpegNameFor(file.name), { lastModified: file.lastModified, type: "image/jpeg" });
};
