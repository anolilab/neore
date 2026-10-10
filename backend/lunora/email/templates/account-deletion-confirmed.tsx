import { Body, Container, Head, Heading, Html, Preview, Text } from "./components/primitives";
import type { ReactElement } from "react";

const AccountDeletionConfirmedEmail = (): ReactElement => (
    <Html>
        <Head />
        <Preview>Your account has been deleted</Preview>
        <Body style={{ color: "#333", fontFamily: "Arial, sans-serif", lineHeight: "1.6" }}>
            <Container style={{ margin: "0 auto", maxWidth: "600px", padding: "20px" }}>
                <Heading style={{ color: "#2563eb" }}>Account Deletion Confirmed</Heading>
                <Text>
                    Your account and all associated personal data have been permanently deleted from our systems in accordance with your request and GDPR
                    Article 17 (Right to Erasure).
                </Text>
                <Text style={{ marginTop: "20px" }}>The following data has been removed:</Text>
                <ul style={{ marginTop: "10px", paddingLeft: "20px" }}>
                    <li>Your profile and account information</li>
                    <li>All conversations and messages</li>
                    <li>Uploaded files and folders</li>
                    <li>Saved prompts and preferences</li>
                    <li>Usage history and analytics data</li>
                </ul>
                <Text style={{ color: "#666", fontSize: "14px", marginTop: "20px" }}>
                    <strong>Note:</strong> This action cannot be undone. If you wish to use our service again in the future, you will need to create a new
                    account.
                </Text>
                <Text style={{ marginTop: "20px" }}>
                    If you have any questions or concerns, please contact our Data Protection Officer at {process.env.DPO_EMAIL || "dpo@example.com"}.
                </Text>
            </Container>
        </Body>
    </Html>
);

export default AccountDeletionConfirmedEmail;
