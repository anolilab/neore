//! `neore-host mcp-bridge`: a local MCP server over stdio that relays each JSON-RPC message to one MCP server over
//! Streamable HTTP (MCP revision 2025-06-18), so a server on the person's own network is reached as one more stdio
//! server: spawned by `mcp.rs`, under the same sandbox and the server's own network tier. The addon never links it.
//!
//! The address and headers come from the environment ([`URL_VAR`], [`HEADERS_VAR`]), never from argv, which other
//! processes can read and the add-server confirmation prints. Nothing this writes (stdout errors, stderr) names the
//! address or a header value: a call's error text reaches the chat, and the cloud must learn only the server's name.
//!
//! Each message is one POST. A reply is one JSON object or an event stream; every message in it goes to stdout as one
//! line, and `mcp.rs` answers the server's own requests (it offers none). Redirects are not followed (a header such
//! as `Authorization` would go to another host), no proxy is read from the environment, and a reply is capped.
//! A server that ends the session (a 404) ends the bridge without an answer: `mcp.rs` then starts it again, which opens a
//! new session, and sends the call once more (the server never ran it).

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{json, Value};
use ureq::http::{HeaderName, HeaderValue, Uri};

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

/// Where the bridge sends, checked once at start.
#[derive(Debug)]
pub struct Target {
    url: String,
    headers: Vec<(HeaderName, HeaderValue)>,
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

    for (name, value) in given {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "a header name is not valid".to_owned())?;

        if RESERVED_HEADERS.contains(&name.as_str()) {
            return Err(format!("the header {name} is set by the bridge"));
        }

        if value.len() > MAX_HEADER_VALUE_BYTES {
            return Err(format!("the value of {name} is too long"));
        }

        let mut value = HeaderValue::from_str(&value)
            .map_err(|_| format!("the value of {name} is not valid"))?;

        value.set_sensitive(true);
        parsed.push((name, value));
    }

    Ok(Target {
        url: url.to_owned(),
        headers: parsed,
    })
}

/// The session headers a request carries: what the server said at `initialize`.
#[derive(Clone, Default)]
struct Headers {
    id: Option<HeaderValue>,
    version: Option<HeaderValue>,
}

impl Headers {
    fn learned(answer: &Value, id: Option<HeaderValue>) -> Headers {
        Headers {
            id,
            version: answer
                .pointer("/result/protocolVersion")
                .and_then(Value::as_str)
                .and_then(|version| HeaderValue::from_str(version).ok()),
        }
    }
}

/// How one POST ended.
enum Sent {
    /// The answer to a request, with the session id the response carried.
    Answered {
        answer: Value,
        session_id: Option<HeaderValue>,
    },
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
    /// Called when the server ended the session: the process exits, so `mcp.rs` starts a new one.
    on_session_gone: fn(),
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

    /// One POST and its reply. With `emit`, every message of the reply goes to the client as it arrives.
    fn send(&self, message: &Value, session: &Headers, emit: bool) -> Sent {
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
        let session_id = session_id_of(&response);
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
            self.read_events(body, id, emit)
        } else if content_type.starts_with("application/json") {
            self.read_json(body, emit)
        } else {
            Err("the MCP server sent no answer".to_owned())
        };

        match answer {
            Ok(answer) => Sent::Answered { answer, session_id },
            Err(reason) => Sent::Failed(reason),
        }
    }

    fn read_json(&self, body: impl Read, emit: bool) -> Result<Value, String> {
        let mut text = String::new();

        BufReader::new(body)
            .read_to_string(&mut text)
            .map_err(|error| read_failure(&error))?;

        match serde_json::from_str::<Value>(&text) {
            Ok(reply) if reply.is_object() => {
                if emit {
                    self.write(&reply);
                }

                Ok(reply)
            }
            _ => Err("the MCP server's answer is not one JSON-RPC message".into()),
        }
    }

    /// Reads an event stream up to the answer to `id`, then stops reading.
    fn read_events(&self, body: impl Read, id: &Value, emit: bool) -> Result<Value, String> {
        let mut data = String::new();

        for line in BufReader::new(body).split(b'\n') {
            let line = line.map_err(|error| read_failure(&error))?;
            let line = String::from_utf8_lossy(&line);
            let line = line.strip_suffix('\r').unwrap_or(&line);

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

            if emit {
                self.write(&message);
            }

            if message.get("method").is_none() && message.get("id") == Some(id) {
                return Ok(message);
            }
        }

        Err("the MCP server ended its answer early".into())
    }

    /// Relays one message from the client; a request that fails is answered with an error. `initialize` opens the
    /// session every later message carries.
    fn relay(&self, message: &Value) {
        let sent = if message.get("method").and_then(Value::as_str) == Some("initialize") {
            let mut session = self.session.lock().unwrap();
            let sent = self.send(message, &Headers::default(), true);

            *session = match &sent {
                Sent::Answered { answer, session_id } => {
                    Headers::learned(answer, session_id.clone())
                }
                _ => Headers::default(),
            };
            sent
        } else {
            let headers = self.session.lock().unwrap().clone();

            self.send(message, &headers, true)
        };
        let reason = match sent {
            Sent::Answered { .. } | Sent::Accepted => return,
            Sent::SessionGone => return (self.on_session_gone)(),
            Sent::Failed(reason) => reason,
        };

        match request_id(message) {
            Some(id) => self.write(&error_reply(id, &reason)),
            None => eprintln!("neore-host mcp-bridge: {reason}"),
        }
    }
}

/// Relays `input` (one JSON-RPC message per line) until it ends. Requests run side by side; anything else (`initialize`,
/// notifications, responses) is sent before the next line is read, so `notifications/initialized` always comes before the
/// request that follows it.
pub fn run<W: Write + Send + 'static>(
    target: Target,
    input: impl BufRead,
    output: W,
    on_session_gone: fn(),
) {
    let bridge = Arc::new(Bridge {
        agent: agent(),
        target,
        session: Mutex::new(Headers::default()),
        output: Mutex::new(output),
        on_session_gone,
    });
    let mut running: Vec<JoinHandle<()>> = Vec::new();

    for line in input.lines().map_while(Result::ok) {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            eprintln!("neore-host mcp-bridge: skipped a line that is not JSON");
            continue;
        };

        if !message.is_object() {
            eprintln!("neore-host mcp-bridge: skipped a message that is not one JSON-RPC object");
            continue;
        }

        let initialize = message.get("method").and_then(Value::as_str) == Some("initialize");

        if initialize || request_id(&message).is_none() {
            if initialize {
                running.drain(..).for_each(|handle| drop(handle.join()));
            }

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

    running.into_iter().for_each(|handle| drop(handle.join()));
}

/// `neore-host mcp-bridge`, reading its target from the environment.
pub fn main() -> ExitCode {
    let url = std::env::var(URL_VAR).unwrap_or_default();
    let headers = std::env::var(HEADERS_VAR).unwrap_or_default();

    match parse_target(&url, &headers) {
        Ok(target) => {
            run(target, io::stdin().lock(), io::stdout(), || {
                std::process::exit(1)
            });
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("neore-host mcp-bridge: {error}");
            ExitCode::from(2)
        }
    }
}
