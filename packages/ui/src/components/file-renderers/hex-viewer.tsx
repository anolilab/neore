"use client";

/**
 * Binary / Hex Viewer
 *
 * Displays binary data in a traditional hex editor layout:
 * - Offset column (hex address)
 * - Hex dump (16 bytes per row)
 * - ASCII representation (printable chars, dots for non-printable)
 *
 * Features:
 * - Virtualized rendering for large files
 * - Byte highlighting on hover
 * - Copy hex/ASCII selection
 * - File header detection (magic bytes)
 */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import type { FC } from "react";
import { memo, useCallback, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HexViewerProps {
    /** Bytes per row (default: 16). */
    bytesPerRow?: number;
    /** Additional CSS class. */
    className?: string;
    /** Binary data as Uint8Array or ArrayBuffer. */
    data: Uint8Array | ArrayBuffer;
    /** Maximum rows to render initially (default: 256 = 4KB). */
    maxInitialRows?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;

const toHex = (byte: number): string => byte.toString(16).padStart(2, "0");

const toAscii = (byte: number): string => (byte >= PRINTABLE_MIN && byte <= PRINTABLE_MAX ? String.fromCodePoint(byte) : ".");

const offsetToHex = (offset: number): string => offset.toString(16).padStart(8, "0");

/**
 * Detect file type from magic bytes.
 */
const detectFileType = (bytes: Uint8Array): MessageDescriptor | null => {
    if (bytes.length < 4) {
        return null;
    }

    const magic4 = (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;

    // Common magic numbers
    if (magic4 === 0x89_50_4e_47) {
        return msg`PNG image`;
    }

    if (magic4 === 0x47_49_46_38) {
        return msg`GIF image`;
    }

    const magic2 = (bytes[0]! << 8) | bytes[1]!;

    if (magic2 === 0xff_d8) {
        return msg`JPEG image`;
    }

    if (magic4 === 0x25_50_44_46) {
        return msg`PDF document`;
    }

    if (magic4 === 0x50_4b_03_04) {
        return msg`ZIP archive`;
    }

    if (magic4 === 0x7f_45_4c_46) {
        return msg`ELF executable`;
    }

    if (magic4 === 0x4d_5a_90_00 || magic2 === 0x4d_5a) {
        return msg`PE executable`;
    }

    if (magic4 === 0xca_fe_ba_be) {
        return msg`Java class / Mach-O fat binary`;
    }

    if (magic4 === 0xfe_ed_fa_ce || magic4 === 0xfe_ed_fa_cf) {
        return msg`Mach-O binary`;
    }

    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        return msg`GZIP compressed`;
    }

    if (bytes[0] === 0x42 && bytes[1] === 0x5a) {
        return msg`BZIP2 compressed`;
    }

    if (magic4 === 0x52_49_46_46) {
        return msg`RIFF (WAV/AVI/WebP)`;
    }

    if (magic4 === 0x00_00_00_18 || magic4 === 0x00_00_00_20) {
        return msg`MP4/MOV video`;
    }

    return null;
};

// ---------------------------------------------------------------------------
// Row Component
// ---------------------------------------------------------------------------

const getHexByteClass = (byte: number | undefined, isHovered: boolean): string => {
    if (byte === undefined) {
        return "text-transparent";
    }

    return isHovered ? "rounded bg-yellow-200 dark:bg-yellow-800" : "text-gray-700 dark:text-gray-300";
};

const getAsciiByteClass = (isHovered: boolean, isPrintable: boolean): string => {
    if (isHovered) {
        return "rounded bg-yellow-200 dark:bg-yellow-800";
    }

    return isPrintable ? "text-gray-700 dark:text-gray-300" : "text-gray-400 dark:text-gray-600";
};

const HexRow: FC<{
    bytes: Uint8Array;
    bytesPerRow: number;
    hoveredByte: number | null;
    offset: number;
    onHoverByte: (index: number | null) => void;
}> = memo(({ bytes, bytesPerRow, hoveredByte, offset, onHoverByte }) => (
    <div className="flex items-center font-mono text-xs leading-5 hover:bg-gray-50 dark:hover:bg-gray-800/30">
        {/* Offset */}
        <span className="w-20 flex-shrink-0 text-gray-400 select-none dark:text-gray-500">{offsetToHex(offset)}</span>

        {/* Hex bytes */}
        <span className="mr-4 flex-shrink-0">
            {Array.from({ length: bytesPerRow }, (_, i) => {
                const byteIndex = offset + i;
                const byte = i < bytes.length ? bytes[i] : undefined;
                const isHovered = hoveredByte === byteIndex;

                return (
                    <span
                        className={`inline-block w-6 cursor-default text-center ${getHexByteClass(byte, isHovered)}${i === 7 ? "mr-1" : ""}`}
                        key={i}
                        onMouseEnter={() => byte !== undefined && onHoverByte(byteIndex)}
                        onMouseLeave={() => onHoverByte(null)}
                    >
                        {byte === undefined ? "  " : toHex(byte)}
                    </span>
                );
            })}
        </span>

        {/* ASCII */}
        <span className="border-l border-gray-200 pl-2 text-gray-500 dark:border-gray-700 dark:text-gray-400">
            {Array.from({ length: bytes.length }, (_, i) => {
                const byteIndex = offset + i;
                const byte = bytes[i] ?? 0;
                const isHovered = hoveredByte === byteIndex;
                const char = toAscii(byte);
                const isPrintable = byte >= PRINTABLE_MIN && byte <= PRINTABLE_MAX;

                return (
                    <span
                        className={getAsciiByteClass(isHovered, isPrintable)}
                        key={i}
                        onMouseEnter={() => onHoverByte(byteIndex)}
                        onMouseLeave={() => onHoverByte(null)}
                    >
                        {char}
                    </span>
                );
            })}
        </span>
    </div>
));

HexRow.displayName = "HexRow";

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

const HexViewer: FC<HexViewerProps> = memo(({ bytesPerRow = 16, className, data, maxInitialRows = 256 }) => {
    const { i18n, t } = useLingui();
    const bytes = useMemo(() => (data instanceof Uint8Array ? data : new Uint8Array(data)), [data]);
    const [showAll, setShowAll] = useState(false);
    const [hoveredByte, setHoveredByte] = useState<number | null>(null);

    const totalRows = Math.ceil(bytes.length / bytesPerRow);
    const MAX_RENDERED_ROWS = 4096; // Cap at ~64KB to prevent browser freeze
    const visibleRows = showAll ? Math.min(totalRows, MAX_RENDERED_ROWS) : Math.min(totalRows, maxInitialRows);
    const fileTypeDescriptor = useMemo(() => detectFileType(bytes), [bytes]);
    const fileType = fileTypeDescriptor ? i18n._(fileTypeDescriptor) : null;
    const byteCount = bytes.length.toLocaleString(i18n.locale);
    const rowLimit = Math.min(totalRows, MAX_RENDERED_ROWS).toLocaleString(i18n.locale);

    const handleHoverByte = useCallback((index: number | null) => {
        setHoveredByte(index);
    }, []);

    const hoveredValue = hoveredByte === null ? 0 : (bytes[hoveredByte] ?? 0);
    const hoveredOffsetHex = hoveredByte === null ? "" : offsetToHex(hoveredByte);
    const hoveredValueHex = toHex(hoveredValue);

    const rows = useMemo(() => {
        const result: { offset: number; rowBytes: Uint8Array }[] = [];

        for (let i = 0; i < visibleRows; i++) {
            const offset = i * bytesPerRow;
            const end = Math.min(offset + bytesPerRow, bytes.length);

            result.push({ offset, rowBytes: bytes.slice(offset, end) });
        }

        return result;
    }, [bytes, bytesPerRow, visibleRows]);

    return (
        <div className={`overflow-auto ${className ?? ""}`}>
            {/* Header */}
            <div className="mb-2 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <span>
                    <Plural one="# byte" other="# bytes" value={bytes.length} />
                </span>
                {fileType && (
                    <>
                        <span>·</span>
                        <span>{fileType}</span>
                    </>
                )}
                {hoveredByte !== null && (
                    <>
                        <span>·</span>
                        <span>{t`Offset: 0x${hoveredOffsetHex} (${hoveredByte}) = 0x${hoveredValueHex} (${hoveredValue})`}</span>
                    </>
                )}
            </div>

            {/* Column headers */}
            <div className="mb-1 flex items-center border-b border-gray-200 pb-1 font-mono text-xs text-gray-400 select-none dark:border-gray-700 dark:text-gray-500">
                <span className="w-20 flex-shrink-0">{t`Offset`}</span>
                <span className="mr-4 flex-shrink-0">
                    {Array.from({ length: bytesPerRow }, (_, i) => (
                        <span className={`inline-block w-6 text-center${i === 7 ? "mr-1" : ""}`} key={i}>
                            {toHex(i)}
                        </span>
                    ))}
                </span>
                <span className="border-l border-gray-200 pl-2 dark:border-gray-700">ASCII</span>
            </div>

            {/* Hex rows */}
            {rows.map(({ offset, rowBytes }) => (
                <HexRow bytes={rowBytes} bytesPerRow={bytesPerRow} hoveredByte={hoveredByte} key={offset} offset={offset} onHoverByte={handleHoverByte} />
            ))}

            {/* Show more button */}
            {!showAll && totalRows > maxInitialRows && (
                <div className="mt-2 text-center">
                    <button className="text-xs text-blue-500 hover:text-blue-700 dark:text-blue-400" onClick={() => setShowAll(true)} type="button">
                        {t`Show up to ${rowLimit} rows (${byteCount} bytes)`}
                    </button>
                </div>
            )}
        </div>
    );
});

HexViewer.displayName = "HexViewer";

export { HexViewer };
export type { HexViewerProps };
