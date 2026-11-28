//! `neore-host mcp-bridge`'s relay against a fake MCP server over HTTP on the loopback (a stand-in for a host on the
//! person's network).
//!
//! `cargo test --no-default-features --features mcp-bridge --test mcp_bridge`
#![cfg(feature = "mcp-bridge")]

use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use device_core::mcp::SESSION_GONE;
use device_core::mcp_bridge::{parse_target, run};
use serde_json::{json, Value};

/// One request the fake server saw.
#[derive(Clone, Debug)]
struct Seen {
    headers: Vec<(String, String)>,
    body: Value,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        let found = self
            .headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name));

        found.map(|(_, value)| value.as_str())
    }
}

type Answer = dyn Fn(&Seen) -> String + Send + Sync;
type Log = Arc<Mutex<Vec<Seen>>>;

fn read_request(stream: &TcpStream) -> Seen {
    let mut reader = BufReader::new(stream);
    let mut lines = Vec::new();

    loop {
        let mut line = String::new();

        if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim_end().is_empty() {
            break;
        }

        lines.push(line.trim_end().to_owned());
    }

    let headers = lines
        .iter()
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_owned(), value.trim().to_owned()))
        .collect();
    let mut request = Seen {
        headers,
        body: Value::Null,
    };
    let length = request
        .header("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];

    reader.read_exact(&mut body).unwrap();
    request.body = serde_json::from_slice(&body).unwrap_or(Value::Null);
    request
}

/// Answers each request with `answer(request)`, one connection at a time.
fn serve(answer: Box<Answer>) -> (String, Log) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let seen = Log::default();
    let log = seen.clone();

    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let request = read_request(&stream);

            log.lock().unwrap().push(request.clone());
            let _ = stream.write_all(answer(&request).as_bytes());
        }
    });

    (url, seen)
}

fn reply(status: &str, headers: &[(&str, &str)], body: &str) -> String {
    let extra: String = headers
        .iter()
        .map(|(key, value)| format!("{key}: {value}\r\n"))
        .collect();

    format!(
        "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n{body}",
        body.len()
    )
}

fn json_reply(request: &Seen, result: Value, session: Option<&str>) -> String {
    let body = json!({ "jsonrpc": "2.0", "id": request.body["id"], "result": result }).to_string();
    let mut headers = vec![("Content-Type", "application/json")];

    headers.extend(session.map(|id| ("Mcp-Session-Id", id)));
    reply("200 OK", &headers, &body)
}

/// Collects what the bridge writes to its client.
#[derive(Clone, Default)]
struct Output(Arc<Mutex<Vec<u8>>>);

impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn initialize() -> Value {
    json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } })
}

fn request(id: i64, method: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method })
}

/// Runs the bridge over `messages` against `url` and returns what it wrote back.
fn relay(url: &str, headers: &str, messages: &[Value]) -> Vec<Value> {
    let input: String = messages
        .iter()
        .map(|message| format!("{message}\n"))
        .collect();
    let output = Output::default();

    run(
        parse_target(url, headers).unwrap(),
        Cursor::new(input),
        output.clone(),
    );

    let text = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();

    text.lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn only_an_http_or_https_address_without_credentials_and_valid_headers_are_taken() {
    assert!(parse_target("https://mcp.internal.example/mcp", "").is_ok());
    assert!(parse_target(
        "http://10.0.0.5:8080/mcp",
        r#"{"Authorization":"Bearer abc"}"#
    )
    .is_ok());

    for (url, headers, expected) in [
        ("ws://10.0.0.5/mcp", "", "http:// or https://"),
        ("file:///etc/passwd", "", "not a valid URL"),
        (
            "https://user:secret-pass@10.0.0.5/mcp",
            "",
            "user name or password",
        ),
        ("https://10.0.0.5/m cp", "", "not a valid URL"),
        ("https://h/mcp", r#"["Authorization"]"#, "one JSON object"),
        (
            "https://h/mcp",
            r#"{"Mcp-Session-Id":"x"}"#,
            "set by the bridge",
        ),
        (
            "https://h/mcp",
            r#"{"Host":"elsewhere"}"#,
            "set by the bridge",
        ),
        (
            "https://h/mcp",
            "{\"X-Token\":\"top-secret\\r\\nX-Evil: 1\"}",
            "value of x-token is not valid",
        ),
    ] {
        let error = parse_target(url, headers).unwrap_err();

        assert!(error.contains(expected), "{url} {headers}: {error}");
        // Neither the address nor a value shows up in the text: it can reach the chat.
        assert!(
            !["10.0.0.5", "secret-pass", "top-secret"]
                .iter()
                .any(|word| error.contains(word)),
            "{error}"
        );
    }
}

#[test]
fn answers_are_relayed_and_the_session_rides_on_every_later_request() {
    let (url, seen) = serve(Box::new(|request| {
        match request.body["method"].as_str() {
            Some("initialize") => json_reply(
                request,
                json!({ "protocolVersion": "2025-06-18" }),
                Some("s-1"),
            ),
            Some("notifications/initialized") => reply("202 Accepted", &[], ""),
            Some("tools/list") => {
                json_reply(request, json!({ "tools": [{ "name": "lookup" }] }), None)
            }
            // An event stream: a comment, a notification, then the answer; the bridge stops reading there.
            _ => {
                let progress = json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": { "progress": 1 } });
                let answer = json!({ "jsonrpc": "2.0", "id": request.body["id"], "result": { "content": [{ "text": "a\nb" }] } });
                let events = format!(
                    ": hi\r\n\r\nevent: message\r\ndata: {progress}\r\n\r\ndata: {answer}\n\n"
                );

                reply("200 OK", &[("Content-Type", "text/event-stream")], &events)
            }
        }
    }));
    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let messages = [
        initialize(),
        initialized,
        request(2, "tools/list"),
        request(3, "tools/call"),
    ];
    let written = relay(&url, r#"{"Authorization":"Bearer abc"}"#, &messages);
    let by_id = |id: Value| {
        written
            .iter()
            .find(|message| message["id"] == id)
            .cloned()
            .unwrap_or_default()
    };

    // Requests after `initialize` run side by side, so only `initialize` comes first. The notification's 202 writes
    // nothing back; the stream's own notification is relayed beside its answer.
    assert_eq!(written.len(), 4, "{written:?}");
    assert_eq!(written[0]["id"], 1);
    assert_eq!(by_id(json!(2))["result"]["tools"][0]["name"], "lookup");
    assert_eq!(by_id(json!(3))["result"]["content"][0]["text"], "a\nb");
    assert_eq!(by_id(Value::Null)["method"], "notifications/progress");

    let seen = seen.lock().unwrap().clone();

    assert_eq!(
        seen[0].header("accept"),
        Some("application/json, text/event-stream")
    );
    assert_eq!(seen[0].header("mcp-session-id"), None);

    for later in &seen[1..] {
        assert_eq!(later.header("mcp-session-id"), Some("s-1"), "{later:?}");
        assert_eq!(later.header("mcp-protocol-version"), Some("2025-06-18"));
        assert_eq!(later.header("authorization"), Some("Bearer abc"));
    }

    // `initialized` is sent before the request after it is read.
    let position = |method: &str| {
        seen.iter()
            .position(|seen| seen.body["method"] == method)
            .unwrap()
    };

    assert!(
        position("notifications/initialized") < position("tools/list"),
        "{seen:?}"
    );
}

#[test]
fn a_failure_is_answered_as_an_error_that_names_no_address_and_a_redirect_is_not_followed() {
    let (url, seen) = serve(Box::new(|request| match request.body["method"].as_str() {
        Some("initialize") => json_reply(request, json!({ "protocolVersion": "2025-06-18" }), None),
        Some("tools/list") => reply("500 Internal Server Error", &[], "boom"),
        // A well-formed answer, but to another request: it must not reach this caller.
        Some("resources/list") => reply(
            "200 OK",
            &[("Content-Type", "application/json")],
            &json!({ "jsonrpc": "2.0", "id": 99, "result": {} }).to_string(),
        ),
        _ => reply(
            "307 Temporary Redirect",
            &[("Location", "http://127.0.0.1:1/elsewhere")],
            "",
        ),
    }));
    let closed = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let unreachable = relay(&format!("http://{closed}/mcp"), "", &[initialize()]);
    let written = relay(
        &url,
        "",
        &[
            initialize(),
            request(2, "tools/list"),
            request(3, "tools/call"),
            request(4, "resources/list"),
        ],
    );
    let error_of = |id: i64| {
        let found = written.iter().find(|message| message["id"] == id);

        found.map(|message| message["error"]["message"].clone())
    };

    assert_eq!(error_of(2), Some(json!("the MCP server answered HTTP 500")));
    assert_eq!(error_of(3), Some(json!("the MCP server answered HTTP 307")));
    assert_eq!(
        error_of(4),
        Some(json!("the MCP server answered a different request"))
    );
    assert!(
        written.iter().all(|message| message["id"] != 99),
        "{written:?}"
    );
    assert_eq!(
        seen.lock().unwrap().len(),
        4,
        "the redirect must not be followed"
    );
    assert_eq!(
        unreachable[0]["error"]["message"],
        "could not connect to the MCP server"
    );

    for message in written.iter().chain(&unreachable) {
        assert!(!message.to_string().contains("127.0.0.1"), "{message}");
    }
}

#[test]
fn once_the_server_ended_the_session_every_call_is_answered_as_such_without_being_sent() {
    let (url, seen) = serve(Box::new(|request| match request.body["method"].as_str() {
        Some("initialize") => json_reply(
            request,
            json!({ "protocolVersion": "2025-06-18" }),
            Some("s-1"),
        ),
        _ => reply("404 Not Found", &[], ""),
    }));
    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let first = relay(&url, "", &[initialize(), request(2, "tools/list")]);
    // The end shows on a notification here: the call after it is answered without being sent, so the server never saw it.
    let second = relay(
        &url,
        "",
        &[initialize(), initialized, request(2, "tools/list")],
    );

    // `mcp.rs` reads that error, stops the bridge and sends the call once more to a new one (a new session).
    for written in [&first, &second] {
        assert_eq!(written.len(), 2, "{written:?}");
        assert_eq!(written[1]["id"], 2);
        assert_eq!(written[1]["error"]["message"], SESSION_GONE);
    }

    let methods: Vec<Value> = seen
        .lock()
        .unwrap()
        .iter()
        .map(|request| request.body["method"].clone())
        .collect();

    assert_eq!(
        methods,
        [
            "initialize",
            "tools/list",
            "initialize",
            "notifications/initialized"
        ]
    );
}

#[test]
fn a_ping_the_server_sends_before_it_answers_initialize_gets_its_reply_within_the_session() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    // Opens the session's stream with a ping and answers `initialize` only once the reply to it arrived (or after a few
    // seconds, so the test fails instead of hanging). A reply outside the session is turned away.
    let server = std::thread::spawn(move || {
        let (mut opening, _) = listener.accept().unwrap();

        assert_eq!(read_request(&opening).body["method"], "initialize");

        let ping = json!({ "jsonrpc": "2.0", "id": "ping-1", "method": "ping" });

        write!(opening, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nMcp-Session-Id: s-1\r\nConnection: close\r\n\r\ndata: {ping}\n\n").unwrap();
        opening.flush().unwrap();
        listener.set_nonblocking(true).unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let pong = loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).unwrap();

                    let pong = read_request(&stream);
                    let status = if pong.header("mcp-session-id") == Some("s-1") {
                        "202 Accepted"
                    } else {
                        "404 Not Found"
                    };

                    let _ = stream.write_all(reply(status, &[], "").as_bytes());
                    break Some(pong);
                }
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Err(_) => break None,
            }
        };
        let answer =
            json!({ "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "2025-06-18" } });

        let _ = write!(opening, "data: {answer}\n\n");
        pong
    });
    let (reader, mut writer) = std::io::pipe().unwrap();
    let output = Output::default();
    let bridge = {
        let (target, output) = (parse_target(&url, "").unwrap(), output.clone());

        std::thread::spawn(move || run(target, BufReader::new(reader), output))
    };
    let written = |count: usize| {
        let deadline = Instant::now() + Duration::from_secs(10);

        loop {
            let text = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
            let lines: Vec<Value> = text
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();

            if lines.len() >= count || Instant::now() > deadline {
                break lines;
            }

            std::thread::sleep(Duration::from_millis(20));
        }
    };

    writeln!(writer, "{}", initialize()).unwrap();
    assert_eq!(written(1)[0]["method"], "ping");

    // Like `mcp.rs`: the reply goes in only once the ping came out.
    writeln!(
        writer,
        "{}",
        json!({ "jsonrpc": "2.0", "id": "ping-1", "result": {} })
    )
    .unwrap();

    let pong = server
        .join()
        .unwrap()
        .expect("the reply to the ping never reached the server");

    assert_eq!(pong.body["id"], "ping-1");
    assert_eq!(pong.header("mcp-session-id"), Some("s-1"));
    assert_eq!(written(2)[1]["id"], 1);

    drop(writer);
    bridge.join().unwrap();
}
