//! Approval prompts, answered ONLY in the local `device` window.
//!
//! A worker thread that needs a decision queues a [`Prompt`] and blocks on its
//! answer; the window shows the head of the queue and answers it through
//! `device_prompt_answer`, a command only that local window's capability
//! grants. An unanswered prompt is denied when its deadline passes, and closing
//! the window denies everything waiting.

use std::collections::VecDeque;
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

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum PromptBody {
    /// Pair this app with an account.
    Pairing { account_label: String },
    /// Run one tool call.
    Call {
        /// "Always allow" is offered: the tool may be always-allowed and the call is untainted.
        allow_always: bool,
        /// What exactly will happen, spelled out (the command line, the path…).
        detail: String,
        input: String,
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
            PromptBody::Pairing { .. } => false,
            PromptBody::Call { allow_always, .. } => *allow_always,
        }
    }
}

#[derive(Default)]
pub struct Prompts {
    next_id: Mutex<u64>,
    queue: Mutex<VecDeque<(Prompt, Sender<Answer>)>>,
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
            input: "{}".into(),
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
    fn times_out_to_a_denial() {
        let prompts = Prompts::default();

        assert_eq!(
            prompts.ask(call(true), 0, Duration::from_millis(20), |_| {}),
            Answer::Timeout
        );
        assert!(prompts.current().is_none());
    }
}
