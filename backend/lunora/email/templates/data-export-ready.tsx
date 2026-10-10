import { Body, Container, Head, Heading, Html, Link, Preview, Text } from "./components/primitives";

interface DataExportReadyEmailProps {
    downloadUrl: string;
    expiresAt: string;
}

const DataExportReadyEmail = ({ downloadUrl, expiresAt }: DataExportReadyEmailProps) => (
    <Html>
        <Head />
        <Preview>Your data export is ready for download</Preview>
        <Body style={{ color: "#333", fontFamily: "Arial, sans-serif", lineHeight: "1.6" }}>
            <Container style={{ margin: "0 auto", maxWidth: "600px", padding: "20px" }}>
                <Heading style={{ color: "#2563eb" }}>Your Data Export is Ready</Heading>
                <Text>
                    Your personal data export has been generated and is ready for download. This export includes all your personal data stored in our system.
                </Text>
                <Text>
                    <Link
                        href={downloadUrl}
                        style={{
                            backgroundColor: "#2563eb",
                            borderRadius: "6px",
                            color: "#ffffff",
                            display: "inline-block",
                            fontWeight: "bold",
                            padding: "12px 24px",
                            textDecoration: "none",
                        }}
                    >
                        Download Your Data
                    </Link>
                </Text>
                <Text style={{ color: "#666", fontSize: "14px", marginTop: "20px" }}>
                    <strong>Important:</strong> This link will expire on
                    {expiresAt}. Please download your data before then.
                </Text>
                <Text style={{ marginTop: "20px" }}>The export includes your profile, settings, conversations, file metadata, and prompts in JSON format.</Text>
                <Text style={{ color: "#666", fontSize: "14px", marginTop: "20px" }}>
                    If you did not request this export, please contact our support team immediately.
                </Text>
            </Container>
        </Body>
    </Html>
);

export default DataExportReadyEmail;
