/**
 * Size guard for office files (PPTX, DOCX, XLSX), which are ZIP archives. A small
 * download can expand to gigabytes once parsed in the browser, so the file is refused
 * before any parser sees it.
 *
 * The central directory's sizes are checked first, as a cheap pre-pass. They are the
 * archive author's word, so each entry is then inflated and its real output counted:
 * a crafted archive can declare small sizes and still stream far past the cap.
 *
 * JSZip does not expose entry sizes publicly (they sit on the private `_data` of
 * each entry), so the central directory is read directly instead.
 */

export const OFFICE_ZIP_MAX_ENTRIES = 2000;
export const OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_ENTRY_SIGNATURE = 0x02_01_4b_50;
const LOCAL_ENTRY_SIGNATURE = 0x04_03_4b_50;
const EOCD_MIN_LENGTH = 22;
const CENTRAL_ENTRY_MIN_LENGTH = 46;
const LOCAL_ENTRY_MIN_LENGTH = 30;
const MAX_ZIP_COMMENT = 0xff_ff;
const ZIP64_MARKER = 0xff_ff_ff_ff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface OfficeZipLimits {
    maxBytes: number;
    maxEntries: number;
}

const DEFAULT_LIMITS: OfficeZipLimits = { maxBytes: OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES, maxEntries: OFFICE_ZIP_MAX_ENTRIES };

const EXPANDS_TOO_LARGE = "Archive expands too large";

/**
 * The output size of one entry's data, counted as it is produced. Stops at `remaining`
 * bytes so a bomb costs at most the cap in memory and time.
 */
const countInflatedBytes = async (data: Uint8Array<ArrayBuffer>, method: number, remaining: number): Promise<number> => {
    if (method === METHOD_STORED) {
        if (data.byteLength > remaining) {
            throw new Error(EXPANDS_TOO_LARGE);
        }

        return data.byteLength;
    }

    if (method !== METHOD_DEFLATE) {
        throw new Error("Unsupported ZIP compression");
    }

    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    let total = 0;
    let chunk = await reader.read();

    while (!chunk.done) {
        total += chunk.value.byteLength;

        if (total > remaining) {
            await reader.cancel();
            throw new Error(EXPANDS_TOO_LARGE);
        }

        chunk = await reader.read();
    }

    return total;
};

/** Throws when the archive is malformed, has too many entries, or would expand past the cap. */
export const assertOfficeZipWithinLimits = async (buffer: ArrayBuffer, limits: OfficeZipLimits = DEFAULT_LIMITS): Promise<void> => {
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
    let declaredTotal = 0;
    let inflatedTotal = 0;

    for (let index = 0; index < entryCount; index += 1) {
        if (position + CENTRAL_ENTRY_MIN_LENGTH > buffer.byteLength || view.getUint32(position, true) !== CENTRAL_ENTRY_SIGNATURE) {
            throw new Error("Corrupt ZIP directory");
        }

        const method = view.getUint16(position + 10, true);
        const compressedSize = view.getUint32(position + 20, true);
        const declaredSize = view.getUint32(position + 24, true);
        const localOffset = view.getUint32(position + 42, true);

        declaredTotal += declaredSize;

        if (compressedSize === ZIP64_MARKER || declaredSize === ZIP64_MARKER || declaredTotal > limits.maxBytes) {
            throw new Error(EXPANDS_TOO_LARGE);
        }

        // The data follows the local header, whose name and extra fields can differ in length from the central copy.
        if (localOffset + LOCAL_ENTRY_MIN_LENGTH > buffer.byteLength || view.getUint32(localOffset, true) !== LOCAL_ENTRY_SIGNATURE) {
            throw new Error("Corrupt ZIP directory");
        }

        const start = localOffset + LOCAL_ENTRY_MIN_LENGTH + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);

        if (start + compressedSize > buffer.byteLength) {
            throw new Error("Corrupt ZIP directory");
        }

        // Sequential on purpose: each entry is inflated under the budget the ones before it left.
        inflatedTotal += await countInflatedBytes(new Uint8Array(buffer, start, compressedSize), method, limits.maxBytes - inflatedTotal);

        position += CENTRAL_ENTRY_MIN_LENGTH + view.getUint16(position + 28, true) + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
    }
};
