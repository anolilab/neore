import { Body, Container, Head, Heading, Html, Link, Preview, Text } from "./components/primitives";

interface TaskOutcomeEmailProps {
    title: string;
    url: string;
}

const TaskOutcomeEmail = ({ title, url }: TaskOutcomeEmailProps) => (
    <Html>
        <Head />
        <Preview>{title} has finished</Preview>
        <Body style={{ color: "#333", fontFamily: "Arial, sans-serif", lineHeight: "1.6" }}>
            <Container style={{ margin: "0 auto", maxWidth: "600px", padding: "20px" }}>
                <Heading style={{ color: "#2563eb" }}>{title}</Heading>
                <Text>Status: finished with a result.</Text>
                <Text>
                    <Link href={url}>View the result</Link>
                </Text>
                <Text style={{ color: "#666", fontSize: "14px", marginTop: "20px" }}>You can turn these emails off in your notification settings.</Text>
            </Container>
        </Body>
    </Html>
);

export default TaskOutcomeEmail;
