import { Body, Button, Container, Head, Heading, Html, Link, Preview, Section, Text } from "./components/primitives";

type OrganizationInviteEmailProps = {
    acceptUrl: string;
    invitationId: string;
    inviterEmail: string;
    inviterName: string;
    organizationName: string;
    role?: string;
    to: string;
};

const OrganizationInviteEmail = ({
    acceptUrl = "http://localhost:3005/invite?id=example",
    invitationId = "inv_example",
    inviterEmail = "inviter@example.com",
    inviterName = "Example User",
    organizationName = "Example Organization",
    role = "member",
    to = "user@example.com",
}: OrganizationInviteEmailProps) => {
    const siteUrl = process.env.SITE_URL ?? "http://localhost:3005";
    const appName = process.env.APP_NAME ?? "App";

    const previewText = `${inviterName} has invited you to join ${organizationName}`;

    return (
        <Html>
            <Head />
            <Preview>{previewText}</Preview>
            <Body style={main}>
                <Container style={container}>
                    <Heading style={headerTitle}>
                        {inviterName} invited you to join
                        <br />
                        <strong>{organizationName}</strong>
                    </Heading>

                    {/* Organization card */}
                    <Section style={cardSection}>
                        <Container style={card}>
                            <Text style={cardText}>
                                <strong>{inviterName}</strong> ({inviterEmail}) has invited you to join the
                                <strong>{organizationName}</strong> organization
                                {role && role !== "member" ? ` as ${role}` : ""}.
                            </Text>

                            <Text style={{ ...cardText, fontSize: "12px" }}>This invitation will expire in 7 days.</Text>

                            <Section style={buttonContainer}>
                                <Button href={acceptUrl} style={button}>
                                    Join {organizationName}
                                </Button>
                            </Section>

                            <Text style={noteText}>
                                <strong>Note:</strong> This invitation was intended for{" "}
                                <Link href={`mailto:${to}`} style={link}>
                                    <strong>{to}</strong>
                                </Link>
                                . If you were not expecting this invitation, you can ignore this email.
                            </Text>

                            <Text style={noteText}>
                                Button not working? Paste the following link into your browser:
                                <br />
                                <Link href={acceptUrl} style={link}>
                                    {acceptUrl}
                                </Link>
                            </Text>
                        </Container>
                    </Section>

                    {/* Footer */}
                    <Section style={footerSection}>
                        <Text style={footerLinks}>
                            <Link href={`${siteUrl}/unsubscribe?invitationId=${invitationId}`} style={footerLink}>
                                Unsubscribe from invitations
                            </Link>{" "}
                            •{" "}
                            <Link href={`${siteUrl}/terms`} style={footerLink}>
                                Terms
                            </Link>{" "}
                            •{" "}
                            <Link href={`${siteUrl}/privacy`} style={footerLink}>
                                Privacy
                            </Link>{" "}
                            •{" "}
                            <Link href={`${siteUrl}/login`} style={footerLink}>
                                Sign in to {appName}
                            </Link>
                        </Text>
                    </Section>

                    <Text style={disclaimer}>
                        You&apos;re receiving this email because {inviterEmail} invited you to join an organization on {appName}.
                    </Text>
                </Container>
            </Body>
        </Html>
    );
};

export default OrganizationInviteEmail;

// Styles
const main = {
    backgroundColor: "#ffffff",
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
    margin: "0",
    padding: "20px 0",
};

const container = {
    backgroundColor: "#ffffff",
    margin: "0 auto",
    maxWidth: "600px",
    padding: "0 20px",
};

const headerTitle = {
    color: "#24292f",
    fontSize: "24px",
    fontWeight: "400",
    lineHeight: "1.25",
    margin: "30px 0 16px 0",
    textAlign: "center" as const,
};

const cardSection = {
    marginBottom: "4px",
};

const card = {
    backgroundColor: "#ffffff",
    border: "1px solid #d0d7de",
    borderRadius: "6px",
    margin: "0",
    padding: "16px 12px",
    textAlign: "center" as const,
};

const cardText = {
    color: "#24292f",
    fontSize: "14px",
    lineHeight: "1.5",
    margin: "8px 0",
    textAlign: "center" as const,
};

const buttonContainer = {
    margin: "12px 0 16px",
    textAlign: "center" as const,
};

const button = {
    backgroundColor: "#0095c9",
    borderRadius: "6px",
    color: "#ffffff",
    display: "inline-block",
    fontSize: "14px",
    fontWeight: "500",
    lineHeight: "1.5",
    padding: "12px 24px",
    textAlign: "center" as const,
    textDecoration: "none",
};

const noteText = {
    color: "#24292f",
    fontSize: "12px",
    lineHeight: "1.5",
    margin: "16px 0",
    textAlign: "center" as const,
};

const link = {
    color: "#0969da",
    textDecoration: "underline",
};

const footerSection = {
    textAlign: "center" as const,
    width: "100%",
};

const footerLinks = {
    color: "#656d76",
    display: "block",
    fontSize: "12px",
    lineHeight: "1.5",
    margin: "16px 0",
    textAlign: "center" as const,
    width: "100%",
};

const footerLink = {
    color: "#0969da",
    textDecoration: "underline",
};

const disclaimer = {
    color: "#656d76",
    display: "block",
    fontSize: "12px",
    lineHeight: "1.5",
    margin: "16px 0",
    textAlign: "center" as const,
    width: "100%",
};
