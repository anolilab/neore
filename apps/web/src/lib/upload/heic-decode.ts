/**
 * Re-encodes a HEIC photo as a JPEG blob with the browser's own decoder. Safari reads HEIC natively: an image element
 * loads the photo, and a canvas draws it and writes the JPEG. Only called where `canConvertHeic` says the browser decodes
 * HEIC, so this module needs no decoder library.
 */
export const heicToJpegBlob = async (file: File, quality: number): Promise<Blob> => {
    const url = URL.createObjectURL(file);

    try {
        const image = new Image();

        image.src = url;
        await image.decode();

        const canvas = document.createElement("canvas");

        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;

        const context = canvas.getContext("2d");

        if (!context) {
            throw new Error("A canvas is not available to draw the photo on.");
        }

        context.drawImage(image, 0, 0);

        const blob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob(resolve, "image/jpeg", quality);
        });

        if (!blob) {
            throw new Error("The photo could not be encoded as JPEG.");
        }

        return blob;
    } finally {
        URL.revokeObjectURL(url);
    }
};
