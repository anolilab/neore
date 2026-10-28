//! Approval prompts, answered ONLY in the local `device` window.
//!
//! A worker thread that needs a decision queues a [`Prompt`] and blocks on its
//! answer; the window shows the head of the queue and answers it through
//! `device_prompt_answer`, a command only that local window's capability
//! grants. An unanswered prompt is denied when its deadline passes, and closing
//! the window denies everything waiting.

use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    Deny,
    Once,
    Always,
    /// Nobody answered before the deadline.
    Timeout,
}

impl Answer {
    pub fn parse(value: &str) -> Option<Answer> {
        match value {
            "deny" => Some(Answer::Deny),
            "once" => Some(Answer::Once),
            "always" => Some(Answer::Always),
            _ => None,
        }
    }
}

/// How a shell call is confined, so the window need not parse the prompt text.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxState {
    /// The command runs inside the OS sandbox (false = full access, which the user allowed).
    pub confined: bool,
    /// The prompt's line about the sandbox.
    pub note: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum PromptBody {
    /// Pair this app with an account.
    Pairing { account_label: String },
    /// A page asks to open an SSH connection to a server that is not paired yet. Asked before anything touches the
    /// network, so a page cannot probe hosts or log in as a user of its choosing on its own.
    HostConnect {
        address: String,
        identity_file: Option<String>,
        name: String,
        port: u16,
        user: String,
    },
    /// Add a server reached over SSH as a device of its own.
    HostPairing {
        address: String,
        identity_file: Option<String>,
        name: String,
        port: u16,
        user: String,
    },
    /// First use of a server: trust the key it presents? "Once" trusts and pins it, "deny" does not.
    HostKey {
        fingerprint: String,
        host: String,
        identity_file: Option<String>,
        key_type: String,
        port: u16,
    },
    /// A pinned server presents another key. Nothing to decide: the connection is refused and this only shows why.
    HostKeyChanged {
        host: String,
        pinned: Vec<String>,
        port: u16,
        presented: Vec<String>,
    },
    /// ssh asks for a key passphrase. Answered with [`Prompts::answer_secret`], never with a plain answer.
    Passphrase { host: String, prompt: String },
    /// Run one tool call.
    Call {
        /// "Always allow" is offered: the tool may be always-allowed and the call is untainted.
        allow_always: bool,
        /// What exactly will happen, spelled out (the command line, the path…).
        detail: String,
        /// The server the call will run on, when it is not this computer.
        #[serde(skip_serializing_if = "Option::is_none")]
        host: Option<String>,
        input: String,
        /// Set for shell calls only.
        sandbox: Option<SandboxState>,
        tainted_by: Vec<String>,
        thread_title: String,
        tool: String,
        tool_kind: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub body: PromptBody,
    /// Epoch ms after which the prompt is denied.
    pub expires_at: u64,
    pub id: u64,
}

impl Prompt {
    fn allows_always(&self) -> bool {
        match &self.body {
            PromptBody::Call { allow_always, .. } => *allow_always,
            _ => false,
        }
    }
}

#[derive(Default)]
pub struct Prompts {
    next_id: Mutex<u64>,
    queue: Mutex<VecDeque<(Prompt, Sender<Answer>)>>,
    /// Secrets typed into a [`PromptBody::Passphrase`] prompt, by prompt id, until its asker takes them. Memory only.
    secrets: Mutex<HashMap<u64, String>>,
}

impl Prompts {
    /// Queues a prompt and blocks until it is answered or `wait` passes.
    /// `on_queued` runs once the prompt is visible (open the window, notify).
    pub fn ask(
        &self,
        body: PromptBody,
        expires_at: u64,
        wait: Duration,
        on_queued: impl FnOnce(&Prompt),
    ) -> Answer {
        let id = {
            let mut next = self.next_id.lock().unwrap();
            *next += 1;
            *next
        };
        let prompt = Prompt {
            body,
            expires_at,
            id,
        };
        let (sender, receiver) = channel();

        self.queue
            .lock()
            .unwrap()
            .push_back((prompt.clone(), sender));
        on_queued(&prompt);

        let answer = receiver.recv_timeout(wait).unwrap_or(Answer::Timeout);

        self.queue
            .lock()
            .unwrap()
            .retain(|(queued, _)| queued.id != id);

        answer
    }

    /// [`Self::ask`] for a prompt whose answer is a secret the user types. `None` when it was denied, timed out or
    /// closed. The secret never appears in a [`Prompt`], so it never reaches the window's state or an event.
    pub fn ask_secret(
        &self,
        body: PromptBody,
        expires_at: u64,
        wait: Duration,
        on_queued: impl FnOnce(&Prompt),
    ) -> Option<String> {
        let queued = Mutex::new(0);
        let answer = self.ask(body, expires_at, wait, |prompt| {
            *queued.lock().unwrap() = prompt.id;
            on_queued(prompt);
        });
        let secret = self
            .secrets
            .lock()
            .unwrap()
            .remove(&*queued.lock().unwrap());

        match answer {
            Answer::Once | Answer::Always => secret,
            Answer::Deny | Answer::Timeout => None,
        }
    }

    /// Answers a [`PromptBody::Passphrase`] prompt with what the user typed.
    pub fn answer_secret(&self, id: u64, secret: String) -> Result<(), String> {
        let asking = self.queue.lock().unwrap().iter().any(|(prompt, _)| {
            prompt.id == id && matches!(prompt.body, PromptBody::Passphrase { .. })
        });

        if !asking {
            return Err("that request is no longer waiting".into());
        }

        self.secrets.lock().unwrap().insert(id, secret);

        self.answer(id, Answer::Once).inspect_err(|_| {
            self.secrets.lock().unwrap().remove(&id);
        })
    }

    /// The prompt the window should show.
    pub fn current(&self) -> Option<Prompt> {
        self.queue
            .lock()
            .unwrap()
            .front()
            .map(|(prompt, _)| prompt.clone())
    }

    /// Answers one prompt. "Always" where it was not offered is refused, not
    /// downgraded — the user must see what they are agreeing to.
    pub fn answer(&self, id: u64, answer: Answer) -> Result<(), String> {
        let mut queue = self.queue.lock().unwrap();
        let index = queue
            .iter()
            .position(|(prompt, _)| prompt.id == id)
            .ok_or("that request is no longer waiting")?;

        if answer == Answer::Always && !queue[index].0.allows_always() {
            return Err("\"Always allow\" is not available for this request".into());
        }

        if let Some((_, sender)) = queue.remove(index) {
            let _ = sender.send(answer);
        }

        Ok(())
    }

    pub fn deny_all(&self) {
        for (_, sender) in self.queue.lock().unwrap().drain(..) {
            let _ = sender.send(Answer::Deny);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    fn call(allow_always: bool) -> PromptBody {
        PromptBody::Call {
            allow_always,
            detail: String::new(),
            host: None,
            input: "{}".into(),
            sandbox: None,
            tainted_by: vec![],
            thread_title: String::new(),
            tool: "fs_read".into(),
            tool_kind: "fs".into(),
        }
    }

    fn answer_when_queued(
        prompts: &Arc<Prompts>,
        answer: Answer,
    ) -> thread::JoinHandle<Result<(), String>> {
        let prompts = prompts.clone();

        thread::spawn(move || loop {
            if let Some(prompt) = prompts.current() {
                return prompts.answer(prompt.id, answer);
            }

            thread::sleep(Duration::from_millis(5));
        })
    }

    #[test]
    fn returns_the_answer_given_in_the_window() {
        let prompts = Arc::new(Prompts::default());
        let answering = answer_when_queued(&prompts, Answer::Once);

        assert_eq!(
            prompts.ask(call(false), 0, Duration::from_secs(5), |_| {}),
            Answer::Once
        );
        assert!(answering.join().unwrap().is_ok());
        assert!(prompts.current().is_none());
    }

    #[test]
    fn refuses_always_where_it_was_not_offered() {
        let prompts = Arc::new(Prompts::default());
        let answering = answer_when_queued(&prompts, Answer::Always);

        assert_eq!(
            prompts.ask(call(false), 0, Duration::from_millis(300), |_| {}),
            Answer::Timeout
        );
        assert!(answering.join().unwrap().is_err());
    }

    /// The shape `src/device.js` reads.
    #[test]
    fn serialises_camel_case_for_the_window() {
        let prompt = Prompt {
            body: call(true),
            expires_at: 5,
            id: 1,
        };
        let value = serde_json::to_value(&prompt).unwrap();

        assert_eq!(value["expiresAt"], 5);
        assert_eq!(value["body"]["kind"], "call");
        assert_eq!(value["body"]["allowAlways"], true);
        assert!(value["body"]["taintedBy"].is_array());
        assert_eq!(value["body"]["threadTitle"], "");

        let pairing = serde_json::to_value(PromptBody::Pairing {
            account_label: "me".into(),
        })
        .unwrap();
        assert_eq!(pairing["kind"], "pairing");
        assert_eq!(pairing["accountLabel"], "me");
    }

    #[test]
    fn a_passphrase_reaches_only_its_asker_and_never_the_prompt() {
        let prompts = Arc::new(Prompts::default());
        let body = || PromptBody::Passphrase {
            host: "build-box".into(),
            prompt: "Enter passphrase for key".into(),
        };
        let asking = {
            let prompts = prompts.clone();

            thread::spawn(move || prompts.ask_secret(body(), 0, Duration::from_secs(5), |_| {}))
        };

        let prompt = loop {
            if let Some(prompt) = prompts.current() {
                break prompt;
            }

            thread::sleep(Duration::from_millis(5));
        };

        // A plain answer is not a passphrase: it is a denial of the question.
        assert!(!serde_json::to_string(&prompt).unwrap().contains("hunter2"));
        prompts.answer_secret(prompt.id, "hunter2".into()).unwrap();

        assert_eq!(asking.join().unwrap().as_deref(), Some("hunter2"));
        assert!(prompts.secrets.lock().unwrap().is_empty());
        assert!(prompts.answer_secret(prompt.id, "late".into()).is_err());
        assert!(prompts.secrets.lock().unwrap().is_empty());
    }

    #[test]
    fn a_secret_cannot_answer_another_kind_of_prompt() {
        let prompts = Arc::new(Prompts::default());
        let waiting = {
            let prompts = prompts.clone();

            thread::spawn(move || prompts.ask(call(false), 0, Duration::from_secs(5), |_| {}))
        };

        let id = loop {
            if let Some(prompt) = prompts.current() {
                break prompt.id;
            }

            thread::sleep(Duration::from_millis(5));
        };

        assert!(prompts.answer_secret(id, "x".into()).is_err());
        prompts.deny_all();
        assert_eq!(waiting.join().unwrap(), Answer::Deny);
    }

    #[test]
    fn a_denied_passphrase_prompt_gives_nothing() {
        let prompts = Prompts::default();
        let body = PromptBody::Passphrase {
            host: "h".into(),
            prompt: "p".into(),
        };

        assert_eq!(
            prompts.ask_secret(body, 0, Duration::from_millis(20), |_| {}),
            None
        );
    }

    #[test]
    fn deny_all_releases_a_waiting_prompt_as_a_denial() {
        let prompts = Arc::new(Prompts::default());
        let waiting = {
            let prompts = prompts.clone();

            thread::spawn(move || prompts.ask(call(true), 0, Duration::from_secs(5), |_| {}))
        };

        while prompts.current().is_none() {
            thread::sleep(Duration::from_millis(5));
        }

        prompts.deny_all();

        assert_eq!(waiting.join().unwrap(), Answer::Deny);
    }

    #[test]
    fn times_out_to_a_denial() {
        let prompts = Prompts::default();

        assert_eq!(
            prompts.ask(call(true), 0, Duration::from_millis(20), |_| {}),
            Answer::Timeout
        );
        assert!(prompts.current().is_none());
    }
}
