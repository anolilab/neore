//! `neore-host mcp-bridge`: a local MCP server over stdio that relays each JSON-RPC message to one MCP server over
//! Streamable HTTP (MCP revision 2025-06-18), so a server on the person's own network is reached as one more stdio
//! server: spawned by `mcp.rs`, under the same sandbox and the server's own network tier. The addon never links it.
//!
//! The address and headers come from the environment ([`URL_VAR`], [`HEADERS_VAR`]), never from argv, which other
//! processes can read and the add-server confirmation prints. Nothing this writes (stdout errors, stderr) names the
//! address or a header value: a call's error text reaches the chat, and the cloud must learn only the server's name.
//!
//! Each message is one POST. A reply is one JSON object or an event stream; every message in it goes to stdout as one
//! line, and `mcp.rs` answers the server's own requests (a ping; it offers nothing else). Redirects are not followed (a
//! header such as `Authorization` would go to another host), no proxy is read from the environment, and a reply is
//! capped. A request the server answers with a 404 (the session ended) gets `mcp::SESSION_GONE`, and so does every
//! request after it, without being sent. `mcp.rs` reads that error, stops the bridge and sends the call once more to a
//! new one, which opens a new session.

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{json, Value};
use ureq::http::{HeaderName, HeaderValue, Uri};

use crate::mcp::SESSION_GONE;

/// The server's address: `http://` or `https://`, no user name or password in it.
pub const URL_VAR: &str = "NEORE_MCP_BRIDGE_URL";
/// The headers sent with every request, as one JSON object of strings (absent or empty = none).
pub const HEADERS_VAR: &str = "NEORE_MCP_BRIDGE_HEADERS";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Longer than a tool call may take (`actions::MCP_CALL_TIMEOUT`), so the caller gives up first and says why.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(150);
/// One reply: a JSON object or a whole event stream.
const MAX_REPLY_BYTES: u64 = 16 * 1024 * 1024;
const MAX_URL_BYTES: usize = 2048;
const MAX_HEADERS: usize = 32;
const MAX_HEADER_VALUE_BYTES: usize = 8192;
/// Requests relayed at once. `mcp.rs` waits for each one, so more than one is rare.
const MAX_IN_FLIGHT: usize = 8;
/// Headers the bridge sets itself, or that would change how a request is framed.
const RESERVED_HEADERS: &[&str] = &[
    "accept",
    "connection",
    "content-length",
    "content-type",
    "host",
    "mcp-protocol-version",
    "mcp-session-id",
    "transfer-encoding",
];

/// A secret shorter than this stays in what the server says: replacing it could garble an answer. So a credential (a
/// header's, a cookie's, or one in the address's query) must be at least this long.
const MIN_REDACTED_BYTES: usize = 8;

/// Where the bridge sends, checked once at start.
#[derive(Debug)]
pub struct Target {
    url: String,
    headers: Vec<(HeaderName, HeaderValue)>,
    /// The header credentials, cookie values and query values, longest first, that nothing the server says may carry
    /// on to the chat.
    secrets: Vec<String>,
}

fn scrub(text: &mut String, secrets: &[String]) {
    for secret in secrets {
        if text.contains(secret.as_str()) {
            *text = text.replace(secret.as_str(), "[redacted]");
        }
    }
}

/// Replaces every `secret` in the strings of `value`, object keys included (a tool's schema names its fields by them).
fn redact(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(text) => scrub(text, secrets),
        // A credential of digits can come back as a number.
        Value::Number(number) => {
            let mut text = number.to_string();

            scrub(&mut text, secrets);

            if text != number.to_string() {
                *value = Value::String(text);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| redact(item, secrets)),
        Value::Object(fields) => {
            *fields = std::mem::take(fields)
                .into_iter()
                .map(|(mut key, mut item)| {
                    scrub(&mut key, secrets);
                    redact(&mut item, secrets);
                    (key, item)
                })
                .collect();
        }
        _ => {}
    }
}

/// Whether a header or a query parameter carries a credential by its name. Its secret must be long enough to blank out
/// of what the server says (`MIN_REDACTED_BYTES`), or the address or header is refused.
/// By whole words, so `x-api-key` and `access_token` are one, and `max_tokens` or `author` is not.
fn holds_a_credential(name: &str) -> bool {
    name.to_ascii_lowercase()
        .split(['-', '_', '.'])
        .any(|word| {
            matches!(
                word,
                "auth"
                    | "authorization"
                    | "cookie"
                    | "token"
                    | "key"
                    | "apikey"
                    | "secret"
                    | "password"
            )
        })
}

/// A header's credential: the whole value, and the part after its scheme (`Bearer <credential>`, however spaced).
fn credentials(value: &str) -> impl Iterator<Item = &str> {
    [
        Some(value),
        value
            .split_once(|character: char| character.is_ascii_whitespace())
            .map(|(_, credential)| credential.trim()),
    ]
    .into_iter()
    .flatten()
}

/// The `name=value` pairs of a cookie header or a query string, split on `separator`.
fn pairs(text: &str, separator: char) -> impl Iterator<Item = (&str, &str)> {
    text.split(separator)
        .filter_map(|pair| pair.trim().split_once('='))
}

/// `%XX` and `+` decoded, as a server reads a query string. Anything that does not decode stays as it is.
fn percent_decoded(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;

    while at < bytes.len() {
        let hex = bytes
            .get(at + 1..at + 3)
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());

        match (bytes[at], hex) {
            (b'%', Some(byte)) => {
                decoded.push(byte);
                at += 3;
            }
            (b'+', _) => {
                decoded.push(b' ');
                at += 1;
            }
            (byte, _) => {
                decoded.push(byte);
                at += 1;
            }
        }
    }

    String::from_utf8_lossy(&decoded).into_owned()
}

/// Checks the address and headers. The errors name neither the address nor a header value.
pub fn parse_target(url: &str, headers: &str) -> Result<Target, String> {
    let invalid = || "the server address is not a valid URL".to_owned();

    if url.len() > MAX_URL_BYTES || url.chars().any(char::is_whitespace) {
        return Err(invalid());
    }

    let uri: Uri = url.parse().map_err(|_| invalid())?;

    if !matches!(uri.scheme_str(), Some("http" | "https")) {
        return Err("the server address must start with http:// or https://".into());
    }

    let authority = uri.authority().ok_or("the server address has no host")?;

    if authority.as_str().contains('@') {
        return Err(
            "the server address must not hold a user name or password; send them as a header"
                .into(),
        );
    }

    if authority.host().is_empty() {
        return Err("the server address has no host".into());
    }

    let given: BTreeMap<String, String> = if headers.trim().is_empty() {
        BTreeMap::new()
    } else {
        serde_json::from_str(headers)
            .map_err(|_| "the headers must be one JSON object of strings".to_owned())?
    };

    if given.len() > MAX_HEADERS {
        return Err(format!("at most {MAX_HEADERS} headers"));
    }

    let mut parsed = Vec::with_capacity(given.len());

    for (name, value) in &given {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "a header name is not valid".to_owned())?;

        if RESERVED_HEADERS.contains(&name.as_str()) {
            return Err(format!("the header {name} is set by the bridge"));
        }

        if value.len() > MAX_HEADER_VALUE_BYTES {
            return Err(format!("the value of {name} is too long"));
        }

        let mut header = HeaderValue::from_str(value)
            .map_err(|_| format!("the value of {name} is not valid"))?;

        let cookies = pairs(value, ';')
            .filter(|_| name == "cookie")
            .map(|(_, cookie)| cookie);

        if holds_a_credential(name.as_str())
            && credentials(value)
                .chain(cookies)
                .any(|secret| secret.len() < MIN_REDACTED_BYTES)
        {
            return Err(format!(
                "the value of {name} is too short to keep out of the chat ({MIN_REDACTED_BYTES} characters at least)"
            ));
        }

        header.set_sensitive(true);
        parsed.push((name, header));
    }

    let raw_query = uri.query().unwrap_or_default();
    // As the server reads them: decoded.
    let query: Vec<(String, String)> = pairs(raw_query, '&')
        .map(|(name, value)| (percent_decoded(name), percent_decoded(value)))
        .collect();

    if query
        .iter()
        .any(|(name, value)| holds_a_credential(name) && value.len() < MIN_REDACTED_BYTES)
    {
        return Err(format!(
            "a credential in the server address is too short to keep out of the chat ({MIN_REDACTED_BYTES} characters at least)"
        ));
    }

    // Each header's credential, each cookie's value, and each value in the address's query (`?key=…`), as written and
    // decoded.
    let mut secrets: Vec<String> = given
        .values()
        .flat_map(|value| credentials(value).chain(pairs(value, ';').map(|(_, cookie)| cookie)))
        .chain(query.iter().map(|(_, value)| value.as_str()))
        .chain(pairs(raw_query, '&').map(|(_, value)| value))
        .filter(|secret| secret.len() >= MIN_REDACTED_BYTES)
        .map(str::to_owned)
        .collect();

    secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));

    Ok(Target {
        url: url.to_owned(),
        headers: parsed,
        secrets,
    })
}

/// The session headers a request carries: what the server said at `initialize`.
#[derive(Clone, Default)]
struct Headers {
    id: Option<HeaderValue>,
    version: Option<HeaderValue>,
}

fn version_of(answer: &Value) -> Option<HeaderValue> {
    answer
        .pointer("/result/protocolVersion")
        .and_then(Value::as_str)
        .and_then(|version| HeaderValue::from_str(version).ok())
}

fn is_initialize(message: &Value) -> bool {
    message.get("method").and_then(Value::as_str) == Some("initialize")
}

/// How one POST ended.
enum Sent {
    /// The answer to a request.
    Answered(Value),
    /// Taken with nothing to say back (a notification or a response).
    Accepted,
    /// The server no longer knows the session.
    SessionGone,
    Failed(String),
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_global(Some(REQUEST_TIMEOUT))
        // A redirect would carry the headers to another host. A 3xx is answered as an error instead.
        .max_redirects(0)
        .max_redirects_will_error(false)
        .http_status_as_error(false)
        // A proxy variable must never route the person's headers (the sandbox clears the environment anyway).
        .proxy(None)
        .build()
        .into()
}

/// The text a failed request is reported with. Never the error's own text: it can name the host.
fn describe(error: &ureq::Error) -> &'static str {
    match error {
        ureq::Error::Timeout(_) => "the MCP server did not answer in time",
        ureq::Error::HostNotFound => "the MCP server's host name was not found",
        ureq::Error::ConnectionFailed => "could not connect to the MCP server",
        ureq::Error::Io(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            "could not connect to the MCP server"
        }
        ureq::Error::BodyExceedsLimit(_) => "the MCP server's answer was too large",
        ureq::Error::Tls(_) | ureq::Error::Rustls(_) => {
            "the MCP server's TLS certificate was not accepted (only publicly trusted certificates are)"
        }
        ureq::Error::Io(_) => "the connection to the MCP server failed",
        _ => "the request to the MCP server failed",
    }
}

fn read_failure(error: &io::Error) -> String {
    match error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<ureq::Error>())
    {
        Some(inner) => describe(inner).into(),
        None => "the MCP server's answer could not be read".into(),
    }
}

fn error_reply(id: &Value, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": message } })
}

/// The client's id when `message` is a request; `None` for a notification or a response.
fn request_id(message: &Value) -> Option<&Value> {
    message.get("method").and(message.get("id"))
}

/// The next line of an event stream, which may end in CR, LF or CRLF. The LF after a CR is skipped when the next line
/// is read, so a stream that pauses after the CR is not waited on.
fn event_line(reader: &mut impl BufRead, after_cr: &mut bool) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();

    loop {
        let buffer = reader.fill_buf()?;

        if buffer.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }

        if std::mem::take(after_cr) && buffer[0] == b'\n' {
            reader.consume(1);
            continue;
        }

        let Some(end) = buffer.iter().position(|byte| matches!(byte, b'\r' | b'\n')) else {
            line.extend_from_slice(buffer);

            let length = buffer.len();

            reader.consume(length);
            continue;
        };

        *after_cr = buffer[end] == b'\r';
        line.extend_from_slice(&buffer[..end]);
        reader.consume(end + 1);

        return Ok(Some(line));
    }
}

/// Whether `message` is the response to the request `id`. Anything else must not reach that request's caller.
fn is_answer_to(message: &Value, id: &Value) -> bool {
    message.get("method").is_none()
        && message.get("id") == Some(id)
        && (message.get("result").is_some() || message.get("error").is_some())
}

/// Visible ASCII only, as the transport requires of a session id.
fn session_id_of(response: &ureq::http::Response<ureq::Body>) -> Option<HeaderValue> {
    response
        .headers()
        .get("mcp-session-id")
        .filter(|value| {
            !value.is_empty()
                && value
                    .as_bytes()
                    .iter()
                    .all(|byte| (0x21..=0x7e).contains(byte))
        })
        .cloned()
}

struct Bridge<W> {
    agent: ureq::Agent,
    target: Target,
    session: Mutex<Headers>,
    output: Mutex<W>,
    /// Set once the server ended the session. From then on every request is answered with `SESSION_GONE` without being
    /// sent, so the server never saw it and `mcp.rs` can send it once more to a new bridge.
    ended: AtomicBool,
}

impl<W: Write> Bridge<W> {
    fn write(&self, message: &Value) {
        let mut line = message.to_string();

        line.push('\n');

        let mut output = self.output.lock().unwrap();
        let _ = output
            .write_all(line.as_bytes())
            .and_then(|()| output.flush());
    }

    /// Writes what the server said to the client. Its words can echo a header (a token in an error): that is blanked.
    /// Nor may it claim the bridge's `SESSION_GONE`, which would make `mcp.rs` send a call it already ran once more.
    fn forward(&self, message: &Value) {
        let mut message = message.clone();

        redact(&mut message, &self.target.secrets);

        if let Some(text) = message.pointer_mut("/error/message") {
            if text == SESSION_GONE {
                *text = format!("{SESSION_GONE} (as the server put it)").into();
            }
        }

        self.write(&message);
    }

    fn post(
        &self,
        message: &Value,
        session: &Headers,
    ) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
        let mut request = self
            .agent
            .post(&self.target.url)
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json");

        for (name, value) in &self.target.headers {
            request = request.header(name, value);
        }

        if let Some(id) = &session.id {
            request = request.header("Mcp-Session-Id", id);
        }

        if let Some(version) = &session.version {
            request = request.header("MCP-Protocol-Version", version);
        }

        request.send(message.to_string())
    }

    /// One POST and its reply. Every message of the reply goes to the client as it arrives.
    fn send(&self, message: &Value, session: &Headers) -> Sent {
        let mut response = match self.post(message, session) {
            Ok(response) => response,
            Err(error) => return Sent::Failed(describe(&error).into()),
        };
        let status = response.status().as_u16();

        if status == 404 && session.id.is_some() {
            return Sent::SessionGone;
        }

        if !(200..300).contains(&status) {
            return Sent::Failed(format!("the MCP server answered HTTP {status}"));
        }

        let Some(id) = request_id(message) else {
            return Sent::Accepted;
        };

        // Taken before the answer is read: the server may ask something (a ping) on the stream first, and the reply to
        // it must carry the session.
        if is_initialize(message) {
            self.session.lock().unwrap().id = session_id_of(&response);
        }

        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_REPLY_BYTES)
            .reader();
        let answer = if content_type.starts_with("text/event-stream") {
            self.read_events(body, id)
        } else if content_type.starts_with("application/json") {
            self.read_json(body, id)
        } else {
            Err("the MCP server sent no answer".to_owned())
        };

        match answer {
            Ok(answer) => Sent::Answered(answer),
            Err(reason) => Sent::Failed(reason),
        }
    }

    fn read_json(&self, body: impl Read, id: &Value) -> Result<Value, String> {
        let mut text = String::new();

        BufReader::new(body)
            .read_to_string(&mut text)
            .map_err(|error| read_failure(&error))?;

        match serde_json::from_str::<Value>(&text) {
            Ok(reply) if is_answer_to(&reply, id) => {
                self.forward(&reply);
                Ok(reply)
            }
            Ok(reply) if reply.is_object() => {
                Err("the MCP server answered a different request".into())
            }
            _ => Err("the MCP server's answer is not one JSON-RPC message".into()),
        }
    }

    /// Reads an event stream up to the answer to `id`, then stops reading.
    fn read_events(&self, body: impl Read, id: &Value) -> Result<Value, String> {
        let mut data = String::new();
        let (mut reader, mut after_cr) = (BufReader::new(body), false);

        while let Some(line) =
            event_line(&mut reader, &mut after_cr).map_err(|error| read_failure(&error))?
        {
            let line = String::from_utf8_lossy(&line);
            // A stream may open with a byte order mark.
            let line = line.strip_prefix('\u{feff}').unwrap_or(&line);

            if let Some(field) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }

                data.push_str(field.strip_prefix(' ').unwrap_or(field));
                continue;
            }

            // Comments, `event:`, `id:` and `retry:` carry nothing the client reads; a blank line ends an event.
            if !line.is_empty() || data.is_empty() {
                continue;
            }

            let Ok(message) = serde_json::from_str::<Value>(&std::mem::take(&mut data)) else {
                continue;
            };

            if !message.is_object() {
                continue;
            }

            // The server's own requests and notifications go to the client; of the responses, only this request's.
            if message.get("method").is_some() {
                self.forward(&message);
            } else if is_answer_to(&message, id) {
                self.forward(&message);
                return Ok(message);
            }
        }

        Err("the MCP server ended its answer early".into())
    }

    /// Relays one message from the client; a request that fails is answered with an error. `initialize` opens the
    /// session every later message carries.
    fn relay(&self, message: &Value) {
        let sent = if is_initialize(message) {
            *self.session.lock().unwrap() = Headers::default();
            self.ended.store(false, Ordering::SeqCst);

            let sent = self.send(message, &Headers::default());

            match &sent {
                Sent::Answered(answer) => self.session.lock().unwrap().version = version_of(answer),
                _ => *self.session.lock().unwrap() = Headers::default(),
            }

            sent
        } else if self.ended.load(Ordering::SeqCst) {
            Sent::SessionGone
        } else {
            let headers = self.session.lock().unwrap().clone();

            self.send(message, &headers)
        };
        let reason = match sent {
            Sent::Answered(_) | Sent::Accepted => return,
            Sent::SessionGone => {
                self.ended.store(true, Ordering::SeqCst);
                SESSION_GONE.to_owned()
            }
            Sent::Failed(reason) => reason,
        };

        match request_id(message) {
            Some(id) => self.write(&error_reply(id, &reason)),
            None => eprintln!("neore-host mcp-bridge: {reason}"),
        }
    }
}

/// Relays `input` (one JSON-RPC message per line) until it ends. Requests run side by side; notifications and responses
/// are sent before the next line is read, so `notifications/initialized` always comes before the request that follows
/// it. While `initialize` runs, only responses go out: the server may ping before it answers, and waits for the reply.
pub fn run<W: Write + Send + 'static>(target: Target, input: impl BufRead, output: W) {
    let bridge = Arc::new(Bridge {
        agent: agent(),
        target,
        session: Mutex::new(Headers::default()),
        output: Mutex::new(output),
        ended: AtomicBool::new(false),
    });
    let mut running: Vec<JoinHandle<()>> = Vec::new();
    let mut opening: Option<JoinHandle<()>> = None;

    for line in input.lines().map_while(Result::ok) {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            eprintln!("neore-host mcp-bridge: skipped a line that is not JSON");
            continue;
        };

        if !message.is_object() {
            eprintln!("neore-host mcp-bridge: skipped a message that is not one JSON-RPC object");
            continue;
        }

        if message.get("method").is_some() {
            if let Some(handle) = opening.take() {
                drop(handle.join());
            }
        }

        if is_initialize(&message) {
            running.drain(..).for_each(|handle| drop(handle.join()));

            let bridge = bridge.clone();

            opening = Some(thread::spawn(move || bridge.relay(&message)));
            continue;
        }

        if request_id(&message).is_none() {
            bridge.relay(&message);
            continue;
        }

        running.retain(|handle| !handle.is_finished());

        if running.len() >= MAX_IN_FLIGHT {
            let _ = running.remove(0).join();
        }

        let bridge = bridge.clone();

        running.push(thread::spawn(move || bridge.relay(&message)));
    }

    opening
        .into_iter()
        .chain(running)
        .for_each(|handle| drop(handle.join()));
}

/// `neore-host mcp-bridge`, reading its target from the environment.
pub fn main() -> ExitCode {
    let url = std::env::var(URL_VAR).unwrap_or_default();
    // Headers that cannot be read must not be taken as none: the requests would go out without them.
    let headers = match std::env::var(HEADERS_VAR) {
        Ok(headers) => headers,
        Err(std::env::VarError::NotPresent) => String::new(),
        Err(std::env::VarError::NotUnicode(_)) => {
            eprintln!("neore-host mcp-bridge: the headers are not valid text");
            return ExitCode::from(2);
        }
    };

    match parse_target(&url, &headers) {
        Ok(target) => {
            run(target, io::stdin().lock(), io::stdout());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("neore-host mcp-bridge: {error}");
            ExitCode::from(2)
        }
    }
}
