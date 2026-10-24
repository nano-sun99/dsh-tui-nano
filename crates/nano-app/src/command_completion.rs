//! Local `/command` completion.
//!
//! The candidate list comes from the official command registry plus Nano view
//! commands and user-invocable skills. Nothing here sends an RPC; the app owns
//! keys and execution, and this module only filters and tracks the selection.

use nano_controls::CommandEntry;
use nano_skills::SkillEntry;

/// Where one candidate comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateKind {
    /// An official model-facing command or a Nano view command.
    Command,
    /// A user-invocable skill.
    Skill,
}

/// One `/` completion candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandCandidate {
    /// Name without the leading slash.
    pub name: String,
    /// One-line description.
    pub description: String,
    /// Official argument hint, when one is advertised.
    pub input_hint: Option<String>,
    /// Whether the entry can run now.
    pub available: bool,
    /// Why the entry is unavailable, when it is.
    pub reason: Option<String>,
    /// Command or skill.
    pub kind: CandidateKind,
}

/// Completion state for the first `/` token.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandCompletion {
    candidates: Vec<CommandCandidate>,
    selected: usize,
    visible: bool,
    query: String,
    token_end: usize,
    ghost: Option<String>,
    dismissed_query: Option<String>,
}

impl CommandCompletion {
    /// Recompute candidates for the current draft and cursor.
    pub fn update(
        &mut self,
        text: &str,
        cursor: usize,
        commands: &[CommandEntry],
        skills: &[SkillEntry],
    ) {
        let Some((token_end, query)) = first_token(text, cursor) else {
            self.clear();
            return;
        };
        if self.dismissed_query.as_deref() == Some(query.as_str()) {
            self.visible = false;
            self.candidates.clear();
            self.ghost = None;
            self.query = query;
            self.token_end = token_end;
            return;
        }
        self.dismissed_query = None;
        let mut candidates = command_candidates(commands);
        for skill in skills
            .iter()
            .filter(|skill| skill.user_invocable && !skill.shadowed_by_command)
        {
            if candidates
                .iter()
                .any(|candidate| candidate.name == skill.name)
            {
                continue;
            }
            candidates.push(CommandCandidate {
                name: skill.name.clone(),
                description: skill.description.clone(),
                input_hint: None,
                available: true,
                reason: None,
                kind: CandidateKind::Skill,
            });
        }
        let filtered = filter_candidates(candidates, &query);
        self.query = query.clone();
        self.token_end = token_end;
        self.ghost = ghost_for(&filtered, &query);
        self.selected = self.selected.min(filtered.len().saturating_sub(1));
        self.visible = !filtered.is_empty();
        self.candidates = filtered;
    }

    /// Candidates currently shown.
    pub fn candidates(&self) -> &[CommandCandidate] {
        &self.candidates
    }

    /// Selected index.
    pub fn selected(&self) -> usize {
        self.selected
    }

    /// Whether the popup is visible.
    pub fn visible(&self) -> bool {
        self.visible && !self.candidates.is_empty()
    }

    /// Inline suffix for the first token, when one unique prefix match exists.
    pub fn ghost(&self) -> Option<&str> {
        self.ghost.as_deref()
    }

    /// Byte offset just past the first token.
    pub fn token_end(&self) -> usize {
        self.token_end
    }

    /// Selected candidate.
    pub fn selected_candidate(&self) -> Option<&CommandCandidate> {
        self.candidates.get(self.selected)
    }

    /// Move the selection by `delta`, clamped.
    pub fn move_selection(&mut self, delta: isize) {
        if self.candidates.is_empty() {
            return;
        }
        let last = self.candidates.len() - 1;
        let next = self.selected as isize + delta;
        self.selected = next.clamp(0, last as isize) as usize;
    }

    /// Hide the popup for this exact query until the draft changes.
    pub fn dismiss(&mut self) {
        self.dismissed_query = Some(self.query.clone());
        self.visible = false;
        self.ghost = None;
    }

    /// Clear all completion state.
    pub fn clear(&mut self) {
        self.candidates.clear();
        self.selected = 0;
        self.visible = false;
        self.query.clear();
        self.token_end = 0;
        self.ghost = None;
        self.dismissed_query = None;
    }
}

/// The first `/` token and its query when the cursor is inside it.
fn first_token(text: &str, cursor: usize) -> Option<(usize, String)> {
    if !text.starts_with('/') || cursor == 0 {
        return None;
    }
    let end = text
        .char_indices()
        .find(|(_, character)| character.is_whitespace())
        .map(|(offset, _)| offset)
        .unwrap_or(text.len());
    if cursor > end {
        return None;
    }
    Some((end, text[1..end].to_string()))
}

fn command_candidates(commands: &[CommandEntry]) -> Vec<CommandCandidate> {
    commands
        .iter()
        .map(|entry| CommandCandidate {
            name: entry.name.clone(),
            description: entry.description.clone(),
            input_hint: entry.input_hint.clone(),
            available: entry.available,
            reason: entry.reason.clone(),
            kind: CandidateKind::Command,
        })
        .collect()
}

fn filter_candidates(candidates: Vec<CommandCandidate>, query: &str) -> Vec<CommandCandidate> {
    let query = query.to_lowercase();
    let mut prefix = Vec::new();
    let mut substring = Vec::new();
    for candidate in candidates {
        let name = candidate.name.to_lowercase();
        if query.is_empty() || name.starts_with(&query) {
            prefix.push(candidate);
        } else if name.contains(&query) {
            substring.push(candidate);
        }
    }
    let mut rows = if prefix.is_empty() { substring } else { prefix };
    rows.sort_by(|left, right| {
        let left_exact = left.name.eq_ignore_ascii_case(&query);
        let right_exact = right.name.eq_ignore_ascii_case(&query);
        right_exact
            .cmp(&left_exact)
            .then_with(|| left.name.cmp(&right.name))
    });
    rows
}

fn ghost_for(candidates: &[CommandCandidate], query: &str) -> Option<String> {
    if query.is_empty() {
        return None;
    }
    let lower = query.to_lowercase();
    let mut matches = candidates
        .iter()
        .filter(|candidate| candidate.name.to_lowercase().starts_with(&lower));
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let suffix = first.name.get(query.len()..)?;
    (!suffix.is_empty()).then(|| suffix.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nano_controls::CommandOrigin;

    fn command(name: &str, hint: Option<&str>) -> CommandEntry {
        CommandEntry {
            name: name.to_string(),
            description: format!("{name} description"),
            input_hint: hint.map(str::to_string),
            origin: CommandOrigin::Official,
            available: true,
            reason: None,
        }
    }

    fn skill(name: &str, invocable: bool) -> SkillEntry {
        SkillEntry {
            name: name.to_string(),
            description: format!("{name} skill"),
            when_to_use: None,
            model_invocable: invocable,
            user_invocable: invocable,
            path: None,
            source: "test".to_string(),
            provider: "test".to_string(),
            shadowed_by_command: false,
        }
    }

    fn update(completion: &mut CommandCompletion, text: &str, cursor: usize) {
        let commands = vec![
            command("compact", None),
            command("model", None),
            command("permission", Some("<preset>")),
            command("commit", None),
        ];
        let skills = vec![skill("hello", true), skill("hidden", false)];
        completion.update(text, cursor, &commands, &skills);
    }

    #[test]
    fn a_slash_lists_commands_and_user_invocable_skills() {
        let mut completion = CommandCompletion::default();
        update(&mut completion, "/", 1);
        assert!(completion.visible());
        let names: Vec<&str> = completion
            .candidates()
            .iter()
            .map(|candidate| candidate.name.as_str())
            .collect();
        assert!(names.contains(&"compact"));
        assert!(names.contains(&"hello"));
        assert!(!names.contains(&"hidden"));
    }

    #[test]
    fn prefix_matches_win_over_substring_matches() {
        let mut completion = CommandCompletion::default();
        update(&mut completion, "/com", 4);
        let names: Vec<&str> = completion
            .candidates()
            .iter()
            .map(|candidate| candidate.name.as_str())
            .collect();
        assert_eq!(names, vec!["commit", "compact"]);
    }

    #[test]
    fn an_exact_match_sorts_first() {
        let mut completion = CommandCompletion::default();
        update(&mut completion, "/commit", 7);
        assert_eq!(
            completion.selected_candidate().map(|c| c.name.as_str()),
            Some("commit")
        );
    }

    #[test]
    fn a_unique_prefix_produces_inline_ghost_text() {
        let mut completion = CommandCompletion::default();
        update(&mut completion, "/perm", 5);
        assert_eq!(completion.ghost(), Some("ission"));
        update(&mut completion, "/com", 4);
        assert_eq!(completion.ghost(), None);
    }

    #[test]
    fn moving_out_of_the_first_token_hides_the_popup() {
        let mut completion = CommandCompletion::default();
        update(&mut completion, "/model ", 7);
        assert!(!completion.visible());
        assert_eq!(completion.ghost(), None);
    }

    #[test]
    fn escape_dismisses_only_until_the_text_changes() {
        let mut completion = CommandCompletion::default();
        update(&mut completion, "/mo", 3);
        completion.dismiss();
        assert!(!completion.visible());
        update(&mut completion, "/mo", 3);
        assert!(!completion.visible());
        update(&mut completion, "/mod", 4);
        assert!(completion.visible());
    }
}
