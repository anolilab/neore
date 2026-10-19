import type JSZip from "jszip";

/**
 * A minimal Word document: a title, a date line and one bold-labelled block per
 * message. A .docx is a zip of three XML parts; nothing here needs a Word library.
 */

export const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

interface DocxEntry {
    role: string;
    text: string;
}

interface DocxContent {
    date: string;
    entries: DocxEntry[];
    title: string;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const ROOT_RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

/** Characters XML 1.0 forbids (control codes other than tab, newline and carriage return). */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_XML_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const NEWLINES = /\r\n|\r|\n/;

export const escapeXml = (text: string): string =>
    text.replaceAll(FORBIDDEN_XML_CHARACTERS, "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const paragraph = (text: string, { bold = false, size }: { bold?: boolean; size?: number } = {}): string => {
    const properties = `${bold ? "<w:b/>" : ""}${size ? `<w:sz w:val="${size}"/>` : ""}`;

    return `<w:p><w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
};

export const buildDocumentXml = ({ date, entries, title }: DocxContent): string => {
    const body = [paragraph(title, { bold: true, size: 36 }), paragraph(date)];

    for (const { role, text } of entries) {
        body.push(paragraph(role, { bold: true }));

        for (const line of text.split(NEWLINES)) {
            body.push(paragraph(line));
        }
    }

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}</w:body></w:document>`;
};

/** `JsZip` is passed in so the caller can load the library on demand. */
export const buildDocx = async (JsZip: typeof JSZip, content: DocxContent): Promise<ArrayBuffer> => {
    const zip = new JsZip();

    zip.file("[Content_Types].xml", CONTENT_TYPES);
    zip.file("_rels/.rels", ROOT_RELATIONSHIPS);
    zip.file("word/document.xml", buildDocumentXml(content));

    return await zip.generateAsync({ compression: "DEFLATE", type: "arraybuffer" });
};
