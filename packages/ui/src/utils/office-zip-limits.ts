/**
 * Size guard for office files (PPTX, DOCX, XLSX), which are ZIP archives. A small
 * download can expand to gigabytes once parsed in the browser, so the central
 * directory is read first and the file is refused before any parser sees it.
 *
 * JSZip does not expose entry sizes publicly (they sit on the private `_data` of
 * each entry), so the central directory is read directly instead.
 */

export const OFFICE_ZIP_MAX_ENTRIES = 2000;
export const OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_ENTRY_SIGNATURE = 0x02_01_4b_50;
const EOCD_MIN_LENGTH = 22;
const CENTRAL_ENTRY_MIN_LENGTH = 46;
const MAX_ZIP_COMMENT = 0xff_ff;
const ZIP64_MARKER = 0xff_ff_ff_ff;

export interface OfficeZipLimits {
    maxBytes: number;
    maxEntries: number;
}

const DEFAULT_LIMITS: OfficeZipLimits = { maxBytes: OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES, maxEntries: OFFICE_ZIP_MAX_ENTRIES };

/** Throws when the archive is malformed, has too many entries, or would expand past the cap. */
export const assertOfficeZipWithinLimits = (buffer: ArrayBuffer, limits: OfficeZipLimits = DEFAULT_LIMITS): void => {
    const view = new DataView(buffer);
    const lowest = Math.max(0, buffer.byteLength - EOCD_MIN_LENGTH - MAX_ZIP_COMMENT);
    let eocd = buffer.byteLength - EOCD_MIN_LENGTH;

    while (eocd >= lowest && view.getUint32(eocd, true) !== EOCD_SIGNATURE) {
        eocd -= 1;
    }

    if (eocd < lowest) {
        throw new Error("Not a ZIP archive");
    }

    const entryCount = view.getUint16(eocd + 10, true);
    const directoryOffset = view.getUint32(eocd + 16, true);

    // 0xFFFF / 0xFFFFFFFF mean ZIP64, which no office file this app previews needs.
    if (entryCount > limits.maxEntries || directoryOffset === ZIP64_MARKER) {
        throw new Error("Archive has too many entries");
    }

    let position = directoryOffset;
    let total = 0;

    for (let index = 0; index < entryCount; index += 1) {
        if (position + CENTRAL_ENTRY_MIN_LENGTH > buffer.byteLength || view.getUint32(position, true) !== CENTRAL_ENTRY_SIGNATURE) {
            throw new Error("Corrupt ZIP directory");
        }

        const size = view.getUint32(position + 24, true);

        total += size;

        if (size === ZIP64_MARKER || total > limits.maxBytes) {
            throw new Error("Archive expands too large");
        }

        position += CENTRAL_ENTRY_MIN_LENGTH + view.getUint16(position + 28, true) + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
    }
};
