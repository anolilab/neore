import { Heading, Link, Text } from "./components/primitives";
import { BaseEmail } from "./components/base-email";
import { styles } from "./components/styles";

interface VerifyEmailProperties {
    brandLogoUrl?: string;
    brandName?: string;
    brandTagline?: string;
    url: string;
}

const VerifyEmail = ({ brandLogoUrl, brandName, brandTagline, url }: VerifyEmailProperties) => (
    <BaseEmail brandLogoUrl={brandLogoUrl} brandName={brandName} brandTagline={brandTagline} previewText="Verify your email address">
        <Heading style={styles.h1}>Verify your email</Heading>
        <Link
            href={url}
            style={{
                ...styles.link,
                display: "block",
                marginBottom: "16px",
            }}
            target="_blank"
        >
            Click here to verify your email address
        </Link>
        <Text
            style={{
                ...styles.text,
                color: "#ababab",
                marginBottom: "16px",
                marginTop: "14px",
            }}
        >
            If you didn&apos;t create an account, you can safely ignore this email.
        </Text>
    </BaseEmail>
);

export default VerifyEmail;
