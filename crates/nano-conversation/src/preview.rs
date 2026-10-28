//! Live assistant-stream previews.
//!
//! A preview is presentation data, never history. It is marked finished when
//! the attempt settles, replaced by the durable `assistant/message`, and
//! dropped on reconnect where the durable log is the only baseline.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::events::StreamFrame;
use crate::{MAX_PREVIEW_BYTES, MAX_TOTAL_PREVIEW_BYTES};

/// One tool call assembled from dense `tool-call-delta` chunks.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ToolPreview {
    /// Chunk-local block index.
    pub index: u64,
    /// Provider-issued call identity, when seen.
    pub call_id: Option<String>,
    /// Tool name, when seen.
    pub name: Option<String>,
    /// Raw JSON arguments accumulated verbatim.
    pub arguments: String,
    /// Whether a `block-end` completed this call.
    pub complete: bool,
}

/// One live attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preview {
    /// Attempt identity.
    pub attempt_id: String,
    /// Owning turn.
    pub turn: u64,
    /// Owning step.
    pub step: u64,
    /// Visible text accumulated from text deltas.
    pub text: String,
    /// Reasoning text, kept separate from visible text.
    pub reasoning: String,
    /// Tool calls by block index.
    pub tools: BTreeMap<u64, ToolPreview>,
    /// Next expected dense chunk index.
    pub expected_index: u64,
    /// A dense-index or revision gap was observed.
    pub gap: bool,
    /// The preview hit its byte bound.
    pub truncated: bool,
    /// Bytes retained for this attempt.
    pub bytes: usize,
    /// Whether the attempt has emitted its terminal finish.
    pub finished: bool,
    /// Settlement reported by the end frame.
    pub outcome: Option<PreviewOutcome>,
}

/// How an attempt settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewOutcome {
    /// A durable assistant message or attempt was committed.
    Committed,
    /// The attempt was abandoned without a durable settlement.
    Abandoned,
    /// The host did not report a recognizable settlement.
    Unknown,
}

/// A preview that left the live set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewRetirement {
    /// Attempt identity.
    pub attempt_id: String,
    /// Owning turn.
    pub turn: u64,
    /// Owning step.
    pub step: u64,
    /// Settlement.
    pub outcome: PreviewOutcome,
}

/// Read-only projection for rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewView {
    /// Attempt identity.
    pub attempt_id: String,
    /// Owning turn.
    pub turn: u64,
    /// Owning step.
    pub step: u64,
    /// Visible text.
    pub text: String,
    /// Reasoning text.
    pub reasoning: String,
    /// Tool calls in block order.
    pub tools: Vec<ToolPreview>,
    /// Whether the preview is known to be incomplete.
    pub gap: bool,
    /// Whether the preview was cut by its byte bound.
    pub truncated: bool,
    /// Whether the attempt emitted its terminal finish.
    pub finished: bool,
    /// Settlement reported by the end frame, when one was seen.
    pub outcome: Option<PreviewOutcome>,
}

/// Bounded live preview set.
#[derive(Debug, Clone)]
pub struct PreviewAccumulator {
    previews: BTreeMap<String, Preview>,
    total_bytes: usize,
    max_bytes: usize,
    max_total_bytes: usize,
    /// Last accepted frame revision in the attached Agent lifecycle.
    /// The official stream increments it on every frame; a jump means frames
    /// were missed and the live preview cannot be trusted.
    revision: u64,
    /// Attempt whose dense chunk sequence is currently accepted.
    active_attempt: Option<String>,
}

impl Default for PreviewAccumulator {
    fn default() -> Self {
        Self::new(MAX_PREVIEW_BYTES, MAX_TOTAL_PREVIEW_BYTES)
    }
}

impl PreviewAccumulator {
    /// Build with explicit bounds.
    pub fn new(max_bytes: usize, max_total_bytes: usize) -> Self {
        Self {
            previews: BTreeMap::new(),
            total_bytes: 0,
            max_bytes,
            max_total_bytes,
            revision: 0,
            active_attempt: None,
        }
    }

    /// Number of live attempts.
    pub fn len(&self) -> usize {
        self.previews.len()
    }

    /// Whether no attempt is live.
    pub fn is_empty(&self) -> bool {
        self.previews.is_empty()
    }

    /// Read-only views in turn/step order.
    pub fn views(&self) -> Vec<PreviewView> {
        let mut previews: Vec<&Preview> = self.previews.values().collect();
        previews.sort_by_key(|preview| (preview.turn, preview.step, preview.attempt_id.clone()));
        previews
            .into_iter()
            .map(|preview| PreviewView {
                attempt_id: preview.attempt_id.clone(),
                turn: preview.turn,
                step: preview.step,
                text: preview.text.clone(),
                reasoning: preview.reasoning.clone(),
                tools: preview.tools.values().cloned().collect(),
                gap: preview.gap,
                truncated: preview.truncated,
                finished: preview.finished,
                outcome: preview.outcome,
            })
            .collect()
    }

    /// Whether any attempt is still streaming. Finished previews stay visible
    /// until a durable settlement retires them, but they need no frame ticks.
    pub fn has_live(&self) -> bool {
        self.previews.values().any(|preview| !preview.finished)
    }

    /// Apply one live frame.
    ///
    /// The official stream carries a revision that increments on every frame.
    /// Frames are accepted only while that sequence stays contiguous; a jump
    /// means content was lost, so the active preview is marked incomplete and
    /// the live assembler waits for the next attempt start (or a durable
    /// settlement). Unknown attempts and unknown chunk types are ignored.
    pub fn apply(&mut self, frame: &StreamFrame) -> Option<PreviewRetirement> {
        // A fresh Agent lifecycle restarts the frame counter at 1. Do this
        // before the duplicate check so a new lifecycle is never mistaken for
        // a repeated frame.
        if let StreamFrame::Start { revision: 1, .. } = frame {
            if self.revision != 0 {
                self.previews.clear();
                self.total_bytes = 0;
                self.revision = 0;
                self.active_attempt = None;
            }
        }
        // The same frame can arrive twice: a root subscription receives child
        // frames in addition to the child's own subscription. Revisions are
        // unique per frame, so an equal revision is an exact duplicate.
        let revision = match frame {
            StreamFrame::Start { revision, .. }
            | StreamFrame::Chunk { revision, .. }
            | StreamFrame::End { revision, .. } => *revision,
        };
        if self.revision != 0 && revision == self.revision {
            return None;
        }
        match frame {
            StreamFrame::Start {
                attempt_id,
                revision,
                turn,
                step,
            } => {
                if *revision != self.revision + 1 {
                    self.mark_gap();
                    self.revision = *revision;
                    self.active_attempt = None;
                    return None;
                }
                self.revision = *revision;
                // A new attempt supersedes any finished preview still parked
                // in the live set (notably an abandoned attempt with no
                // durable settlement).
                self.retire_finished();
                self.remove(attempt_id);
                self.active_attempt = Some(attempt_id.clone());
                let preview = Preview {
                    attempt_id: attempt_id.clone(),
                    turn: *turn,
                    step: *step,
                    text: String::new(),
                    reasoning: String::new(),
                    tools: BTreeMap::new(),
                    expected_index: 0,
                    gap: false,
                    truncated: false,
                    bytes: 0,
                    finished: false,
                    outcome: None,
                };
                self.previews.insert(attempt_id.clone(), preview);
                None
            }
            StreamFrame::Chunk {
                attempt_id,
                revision,
                index,
                chunk,
                ..
            } => {
                if *revision != self.revision + 1 {
                    self.mark_gap();
                    self.revision = *revision;
                    self.active_attempt = None;
                    return None;
                }
                self.revision = *revision;
                if self.active_attempt.as_deref() != Some(attempt_id.as_str()) {
                    // A late, unknown, or already-closed attempt: ignore it;
                    // its durable settlement still arrives through session.event.
                    return None;
                }
                let Some(preview) = self.previews.get_mut(attempt_id) else {
                    self.active_attempt = None;
                    return None;
                };
                if *index != preview.expected_index {
                    // A stale, repeated, or skipped index ends this attempt;
                    // only the next start (or the durable settlement) recovers.
                    preview.gap = true;
                    self.active_attempt = None;
                    return None;
                }
                preview.expected_index = index + 1;
                let max_bytes = self.max_bytes;
                let max_total_bytes = self.max_total_bytes;
                Self::apply_chunk(
                    preview,
                    chunk,
                    max_bytes,
                    max_total_bytes,
                    &mut self.total_bytes,
                );
                self.enforce_bounds()
            }
            StreamFrame::End {
                attempt_id,
                revision,
                index,
                outcome,
            } => {
                if *revision != self.revision + 1 {
                    self.mark_gap();
                    self.revision = *revision;
                    self.active_attempt = None;
                } else {
                    self.revision = *revision;
                    if self.active_attempt.as_deref() == Some(attempt_id.as_str()) {
                        self.active_attempt = None;
                    }
                }
                // The end settles the attempt even when frames were lost: a
                // committed preview is retired by durable history, and an
                // abandoned preview must finish so the next start can retire it.
                let Some(preview) = self.previews.get_mut(attempt_id) else {
                    return None;
                };
                if *index != preview.expected_index {
                    preview.gap = true;
                }
                preview.finished = true;
                preview.outcome = Some(outcome_of(outcome));
                None
            }
        }
    }

    /// Mark the active preview incomplete after a lost frame.
    fn mark_gap(&mut self) {
        let Some(attempt_id) = self.active_attempt.clone() else {
            return;
        };
        if let Some(preview) = self.previews.get_mut(&attempt_id) {
            preview.gap = true;
        }
    }

    /// Retire any preview for a durable turn/step settlement.
    pub fn retire_turn_step(&mut self, turn: u64, step: u64) -> Vec<PreviewRetirement> {
        let ids: Vec<String> = self
            .previews
            .values()
            .filter(|preview| preview.turn == turn && preview.step == step)
            .map(|preview| preview.attempt_id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| {
                self.remove(&id).map(|preview| PreviewRetirement {
                    attempt_id: preview.attempt_id,
                    turn: preview.turn,
                    step: preview.step,
                    outcome: PreviewOutcome::Committed,
                })
            })
            .collect()
    }

    /// Drop all previews, for example after a reconnect.
    pub fn clear(&mut self) {
        self.previews.clear();
        self.total_bytes = 0;
        self.revision = 0;
        self.active_attempt = None;
    }

    fn apply_chunk(
        preview: &mut Preview,
        chunk: &Value,
        max_bytes: usize,
        max_total_bytes: usize,
        total_bytes: &mut usize,
    ) {
        let Some(kind) = chunk.get("type").and_then(Value::as_str) else {
            return;
        };
        match kind {
            "text-delta" => {
                if let Some(text) = chunk.get("text").and_then(Value::as_str) {
                    append(preview, text, true, max_bytes, max_total_bytes, total_bytes);
                }
            }
            "reasoning-delta" => {
                if let Some(text) = chunk.get("text").and_then(Value::as_str) {
                    append(
                        preview,
                        text,
                        false,
                        max_bytes,
                        max_total_bytes,
                        total_bytes,
                    );
                }
            }
            "tool-call-delta" => {
                let Some(index) = chunk.get("index").and_then(Value::as_u64) else {
                    return;
                };
                let call_id = chunk.get("id").and_then(Value::as_str).map(str::to_string);
                let name = chunk
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let delta = chunk
                    .get("argumentsDelta")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let reserved = delta
                    .as_ref()
                    .map(|value| {
                        reserve_bytes(
                            preview,
                            value.len(),
                            max_bytes,
                            max_total_bytes,
                            total_bytes,
                        )
                    })
                    .unwrap_or(true);
                let mut truncated = false;
                {
                    let entry = preview.tools.entry(index).or_insert_with(|| ToolPreview {
                        index,
                        ..ToolPreview::default()
                    });
                    if let Some(call_id) = call_id {
                        entry.call_id = Some(call_id);
                    }
                    if let Some(name) = name {
                        entry.name = Some(name);
                    }
                    if let Some(delta) = delta {
                        if reserved {
                            entry.arguments.push_str(&delta);
                        } else {
                            truncated = true;
                        }
                    }
                }
                if truncated {
                    preview.truncated = true;
                }
            }
            "block-end" => {
                let Some(index) = chunk.get("index").and_then(Value::as_u64) else {
                    return;
                };
                if let Some(block) = chunk.get("block") {
                    let call_id = block.get("id").and_then(Value::as_str).map(str::to_string);
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let arguments = block
                        .get("arguments")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let old = preview
                        .tools
                        .get(&index)
                        .map(|entry| entry.arguments.len())
                        .unwrap_or(0);
                    let new_len = arguments.as_ref().map_or(old, String::len);
                    let mut accepted = true;
                    if new_len > old {
                        // Keep the old arguments accounted while reserving the
                        // delta; a failed reserve leaves the old value intact.
                        accepted = reserve_bytes(
                            preview,
                            new_len - old,
                            max_bytes,
                            max_total_bytes,
                            total_bytes,
                        );
                    } else if new_len < old {
                        let shrink = old - new_len;
                        preview.bytes = preview.bytes.saturating_sub(shrink);
                        *total_bytes = total_bytes.saturating_sub(shrink);
                    }
                    let mut truncated = false;
                    {
                        let entry = preview.tools.entry(index).or_insert_with(|| ToolPreview {
                            index,
                            ..ToolPreview::default()
                        });
                        if let Some(call_id) = call_id {
                            entry.call_id = Some(call_id);
                        }
                        if let Some(name) = name {
                            entry.name = Some(name);
                        }
                        if let Some(arguments) = arguments {
                            if accepted {
                                entry.arguments = arguments;
                            } else {
                                truncated = true;
                            }
                        }
                        entry.complete = true;
                    }
                    if truncated {
                        preview.truncated = true;
                    }
                }
            }
            "finish" => preview.finished = true,
            // Unknown chunk types are ignored rather than interpreted.
            _ => {}
        }
    }

    fn remove(&mut self, attempt_id: &str) -> Option<Preview> {
        let preview = self.previews.remove(attempt_id)?;
        self.total_bytes = self.total_bytes.saturating_sub(preview.bytes);
        if self.active_attempt.as_deref() == Some(attempt_id) {
            self.active_attempt = None;
        }
        Some(preview)
    }

    fn retire_finished(&mut self) {
        let ids: Vec<String> = self
            .previews
            .iter()
            .filter(|(_, preview)| preview.finished)
            .map(|(attempt_id, _)| attempt_id.clone())
            .collect();
        for attempt_id in ids {
            self.remove(&attempt_id);
        }
    }

    /// Enforce the total bound globally; called after each applied chunk.
    fn enforce_bounds(&mut self) -> Option<PreviewRetirement> {
        // Per-attempt bounds are enforced while appending. The global bound is
        // enforced by refusing new bytes, so no attempt needs eviction here.
        None
    }
}

fn reserve_bytes(
    preview: &mut Preview,
    bytes: usize,
    max_bytes: usize,
    max_total_bytes: usize,
    total_bytes: &mut usize,
) -> bool {
    if preview.bytes + bytes > max_bytes || *total_bytes + bytes > max_total_bytes {
        return false;
    }
    preview.bytes += bytes;
    *total_bytes += bytes;
    true
}

fn append(
    preview: &mut Preview,
    text: &str,
    visible: bool,
    max_bytes: usize,
    max_total_bytes: usize,
    total_bytes: &mut usize,
) {
    if !reserve_bytes(preview, text.len(), max_bytes, max_total_bytes, total_bytes) {
        preview.truncated = true;
        return;
    }
    if visible {
        preview.text.push_str(text);
    } else {
        preview.reasoning.push_str(text);
    }
}

fn outcome_of(value: &Value) -> PreviewOutcome {
    match value.get("kind").and_then(Value::as_str) {
        Some("committed") => PreviewOutcome::Committed,
        Some("abandoned") => PreviewOutcome::Abandoned,
        _ => PreviewOutcome::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn start(attempt: &str, revision: u64, turn: u64, step: u64) -> StreamFrame {
        StreamFrame::Start {
            attempt_id: attempt.into(),
            revision,
            turn,
            step,
        }
    }

    fn chunk(attempt: &str, revision: u64, index: u64, value: Value) -> StreamFrame {
        StreamFrame::Chunk {
            attempt_id: attempt.into(),
            revision,
            index,
            time: Some(index),
            chunk: value,
        }
    }

    fn end(attempt: &str, revision: u64, index: u64, outcome: Value) -> StreamFrame {
        StreamFrame::End {
            attempt_id: attempt.into(),
            revision,
            index,
            outcome,
        }
    }

    #[test]
    fn every_contiguous_frame_applies() {
        let mut previews = PreviewAccumulator::default();
        previews.apply(&start("a", 1, 1, 1));
        for (step, text) in ["a", "b", "c", "d", "e"].iter().enumerate() {
            previews.apply(&chunk(
                "a",
                step as u64 + 2,
                step as u64,
                json!({"type": "text-delta", "text": text}),
            ));
        }
        let view = &previews.views()[0];
        assert_eq!(view.text, "abcde");
        assert!(!view.gap);
    }

    #[test]
    fn text_deltas_merge_and_end_marks_the_preview_finished() {
        let mut previews = PreviewAccumulator::default();
        assert!(previews.apply(&start("a", 1, 1, 1)).is_none());
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "text-delta", "index": 0, "text": "hel"}),
        ));
        previews.apply(&chunk(
            "a",
            3,
            1,
            json!({"type": "text-delta", "index": 0, "text": "lo"}),
        ));
        assert_eq!(previews.views()[0].text, "hello");
        assert!(previews.has_live());
        let retired = previews.apply(&end(
            "a",
            4,
            2,
            json!({"kind": "committed", "eventType": "assistant/message", "seq": 9}),
        ));
        assert!(retired.is_none());
        let view = &previews.views()[0];
        assert!(view.finished);
        assert_eq!(view.outcome, Some(PreviewOutcome::Committed));
        assert_eq!(view.text, "hello");
        assert!(!previews.has_live());
        assert!(!previews.is_empty());
        let retired = previews.retire_turn_step(1, 1);
        assert_eq!(retired.len(), 1);
        assert!(previews.is_empty());
    }

    #[test]
    fn a_finish_chunk_stops_the_stream_without_settling() {
        let mut previews = PreviewAccumulator::default();
        previews.apply(&start("a", 1, 1, 1));
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "text-delta", "index": 0, "text": "done"}),
        ));
        previews.apply(&chunk("a", 3, 1, json!({"type": "finish"})));
        let view = &previews.views()[0];
        assert!(view.finished);
        assert_eq!(view.outcome, None);
        assert!(!previews.has_live());
    }

    #[test]
    fn a_new_attempt_retires_an_abandoned_finished_preview() {
        let mut previews = PreviewAccumulator::default();
        previews.apply(&start("a", 1, 1, 1));
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "text-delta", "index": 0, "text": "bye"}),
        ));
        previews.apply(&end("a", 3, 1, json!({"kind": "abandoned"})));
        assert_eq!(previews.views().len(), 1);
        assert!(previews.views()[0].finished);
        previews.apply(&start("b", 4, 2, 1));
        let views = previews.views();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].attempt_id, "b");
    }

    #[test]
    fn unknown_attempt_chunks_are_ignored() {
        let mut previews = PreviewAccumulator::default();
        previews.apply(&chunk(
            "ghost",
            1,
            0,
            json!({"type": "text-delta", "text": "x"}),
        ));
        assert!(previews.is_empty());

        previews.apply(&start("a", 2, 1, 1));
        previews.apply(&chunk(
            "ghost",
            3,
            0,
            json!({"type": "text-delta", "text": "x"}),
        ));
        previews.apply(&chunk(
            "a",
            4,
            0,
            json!({"type": "text-delta", "text": "ok"}),
        ));
        assert_eq!(previews.views()[0].text, "ok");
        assert!(!previews.views()[0].gap);
    }

    #[test]
    fn dense_index_gap_marks_preview_incomplete() {
        let mut previews = PreviewAccumulator::default();
        previews.apply(&start("a", 1, 1, 1));
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "text-delta", "text": "one"}),
        ));
        previews.apply(&chunk(
            "a",
            3,
            2,
            json!({"type": "text-delta", "text": "two"}),
        ));
        previews.apply(&chunk(
            "a",
            4,
            3,
            json!({"type": "text-delta", "text": "three"}),
        ));
        let view = &previews.views()[0];
        assert!(view.gap);
        assert_eq!(view.text, "one");
    }

    #[test]
    fn a_revision_jump_marks_the_preview_incomplete_and_waits_for_a_start() {
        let mut previews = PreviewAccumulator::default();
        previews.apply(&start("a", 1, 1, 1));
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "text-delta", "text": "old"}),
        ));
        // Frame revision 3 is missing.
        previews.apply(&chunk(
            "a",
            4,
            0,
            json!({"type": "text-delta", "text": "new"}),
        ));
        let view = &previews.views()[0];
        assert!(view.gap);
        assert_eq!(view.text, "old");
        // The still-contiguous chunk arrives without an active attempt.
        previews.apply(&chunk(
            "a",
            5,
            1,
            json!({"type": "text-delta", "text": "more"}),
        ));
        assert_eq!(previews.views()[0].text, "old");
        // The next attempt start resumes a fresh preview.
        previews.apply(&start("b", 6, 2, 1));
        let views = previews.views();
        assert_eq!(views.len(), 2);
        assert_eq!(views[1].attempt_id, "b");
        assert!(!views[1].gap);
    }

    #[test]
    fn a_new_lifecycle_start_at_one_resets_the_sequence() {
        let mut previews = PreviewAccumulator::default();
        previews.apply(&start("a", 1, 1, 1));
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "text-delta", "text": "old"}),
        ));
        previews.apply(&start("b", 1, 1, 2));
        let views = previews.views();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].attempt_id, "b");
        previews.apply(&chunk(
            "b",
            2,
            0,
            json!({"type": "text-delta", "text": "new"}),
        ));
        assert_eq!(previews.views()[0].text, "new");
        assert!(!previews.views()[0].gap);
    }

    #[test]
    fn a_repeated_frame_is_ignored_as_a_duplicate() {
        let mut previews = PreviewAccumulator::default();
        previews.apply(&start("a", 1, 1, 1));
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "text-delta", "text": "a"}),
        ));
        // The same frame arrives through a second subscription.
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "text-delta", "text": "a"}),
        ));
        previews.apply(&chunk(
            "a",
            3,
            1,
            json!({"type": "text-delta", "text": "b"}),
        ));
        let view = &previews.views()[0];
        assert_eq!(view.text, "ab");
        assert!(!view.gap);
    }

    #[test]
    fn a_mismatched_chunk_index_stops_the_attempt() {
        let mut previews = PreviewAccumulator::default();
        previews.apply(&start("a", 1, 1, 1));
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "text-delta", "text": "a"}),
        ));
        previews.apply(&chunk(
            "a",
            3,
            0,
            json!({"type": "text-delta", "text": "b"}),
        ));
        previews.apply(&chunk(
            "a",
            4,
            1,
            json!({"type": "text-delta", "text": "c"}),
        ));
        let view = &previews.views()[0];
        assert!(view.gap);
        assert_eq!(view.text, "a");
    }

    #[test]
    fn end_with_a_revision_jump_settles_the_preview() {
        let mut previews = PreviewAccumulator::default();
        previews.apply(&start("a", 1, 1, 1));
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "text-delta", "text": "x"}),
        ));
        previews.apply(&end(
            "a",
            4,
            1,
            json!({"kind": "committed", "eventType": "assistant/message", "seq": 9}),
        ));
        let view = &previews.views()[0];
        assert!(view.gap);
        assert!(view.finished);
        assert_eq!(view.outcome, Some(PreviewOutcome::Committed));
    }

    #[test]
    fn an_abandoned_end_after_a_gap_finishes_the_preview() {
        let mut previews = PreviewAccumulator::default();
        previews.apply(&start("a", 1, 1, 1));
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "text-delta", "text": "x"}),
        ));
        // Frame revision 3 is missing.
        previews.apply(&chunk(
            "a",
            4,
            1,
            json!({"type": "text-delta", "text": "y"}),
        ));
        assert!(previews.views()[0].gap);
        previews.apply(&end("a", 5, 2, json!({"kind": "abandoned"})));
        let view = &previews.views()[0];
        assert!(view.finished);
        assert_eq!(view.outcome, Some(PreviewOutcome::Abandoned));
        // The next start retires the abandoned preview.
        previews.apply(&start("b", 6, 2, 1));
        let views = previews.views();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].attempt_id, "b");
    }

    #[test]
    fn an_end_index_mismatch_marks_the_preview_incomplete() {
        let mut previews = PreviewAccumulator::default();
        previews.apply(&start("a", 1, 1, 1));
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "text-delta", "text": "only"}),
        ));
        previews.apply(&end(
            "a",
            3,
            5,
            json!({"kind": "committed", "eventType": "assistant/message", "seq": 9}),
        ));
        let view = &previews.views()[0];
        assert!(view.finished);
        assert!(view.gap);
    }

    #[test]
    fn durable_settlement_retires_previews_for_that_step() {
        let mut previews = PreviewAccumulator::default();
        previews.apply(&start("a", 1, 2, 3));
        let retired = previews.retire_turn_step(2, 3);
        assert_eq!(retired.len(), 1);
        assert!(previews.is_empty());
    }

    #[test]
    fn tool_argument_bytes_count_against_the_total_budget() {
        let mut previews = PreviewAccumulator::new(100, 150);
        previews.apply(&start("a", 1, 1, 1));
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "tool-call-delta", "index": 0, "id": "c-1", "name": "bash", "argumentsDelta": "x".repeat(90)}),
        ));
        previews.apply(&chunk(
            "a",
            3,
            1,
            json!({"type": "tool-call-delta", "index": 1, "id": "c-2", "name": "bash", "argumentsDelta": "y".repeat(90)}),
        ));
        let view = &previews.views()[0];
        assert!(view.truncated);
        let total: usize = view.tools.iter().map(|tool| tool.arguments.len()).sum();
        assert!(total <= 150);
    }

    #[test]
    fn preview_bytes_are_bounded() {
        let mut previews = PreviewAccumulator::new(4, 8);
        previews.apply(&start("a", 1, 1, 1));
        previews.apply(&chunk(
            "a",
            2,
            0,
            json!({"type": "text-delta", "text": "12345"}),
        ));
        let view = &previews.views()[0];
        assert!(view.truncated);
        assert!(view.text.is_empty() || view.text.len() <= 4);
    }
}
