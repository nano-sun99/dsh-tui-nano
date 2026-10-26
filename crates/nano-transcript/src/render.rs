//! Transcript rendering: visible-line budgets, expansion, and hit targets.
//!
//! Budgets count display rows after terminal wrapping. A collapsed block shows
//! its budget plus an explicit hidden-row count; expanding is an in-place click
//! on the content area, never a new shortcut. The renderer mounts only the
//! viewport plus a bounded overscan window and keeps a small measurement cache.

use std::collections::{HashMap, HashSet, VecDeque};

use nano_conversation::PreviewOutcome;
use nano_theme::spacing::{self, Gap};
use nano_theme::Theme;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use crate::diff::{DiffLine, DiffLineKind, DiffView};
use crate::display::{char_width, display_text, elide, line_width, wrap_line, wrap_row_count};
use crate::model::{Entry, EntryKind, PreviewEntry, TranscriptModel};
use crate::scroll::{EntryOffset, ScrollState};
use crate::tool::{
    ApprovalView, DisplayStatus, ExitStatus, RecordedQuestionState, ToolDisplay, ToolRecord,
};

/// Default visible rows for a long diff.
pub const DIFF_BUDGET: usize = 8;
/// Default visible rows for a command title.
pub const COMMAND_BUDGET: usize = 1;
/// Default visible rows for running/completed output.
pub const OUTPUT_BUDGET: usize = 2;
/// Default visible rows for a failure summary. Failures are never hidden.
pub const FAILURE_BUDGET: usize = 3;
/// Default visible rows for a thinking summary.
pub const THINKING_BUDGET: usize = 1;
/// Overscan rows mounted above and below the viewport.
pub const OVERSCAN_ROWS: usize = 80;
/// Hard cap on mounted rows in one render pass.
pub const MAX_MOUNTED_ROWS: usize = 300;
/// Rendered entries kept in the line cache.
const MAX_CACHED_ENTRIES: usize = 512;
/// Wrapped source rows kept per block, even when expanded.
const MAX_BLOCK_ROWS: usize = 4_000;
/// Fixed width of the diff line-number column.
const DIFF_LINE_NUMBER_WIDTH: usize = 4;

/// What a click does on a rendered row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HitKind {
    /// Toggle the entry's expanded state.
    Toggle,
    /// Open the recorded question for this tool call.
    OpenQuestion {
        /// Official call identity.
        call_id: String,
    },
}

/// One clickable row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    /// Entry identity the row belongs to.
    pub identity: String,
    /// What the click does.
    pub kind: HitKind,
}

/// One frame of rendered transcript.
#[derive(Debug, Clone)]
pub struct TranscriptRender {
    /// Visible rows for the feed region.
    pub lines: Vec<Line<'static>>,
    /// One hit target per visible row.
    pub hits: Vec<Option<Hit>>,
    /// Total display rows the transcript occupies.
    pub total_height: usize,
    /// First row shown.
    pub top: usize,
    /// Mounted row count.
    pub mounted: usize,
    /// Entry offsets used for anchor resolution.
    pub entries: Vec<EntryOffset>,
}

/// Cached measurement and line data.
#[derive(Debug, Clone, Default)]
pub struct RenderCache {
    heights: HashMap<CacheKey, usize>,
    lines: HashMap<CacheKey, RenderedEntry>,
    order: VecDeque<CacheKey>,
}

type CacheKey = (String, u64, usize, bool, u8, u8);

#[derive(Debug, Clone, Default)]
struct RenderedEntry {
    lines: Vec<Line<'static>>,
    hits: Vec<Option<Hit>>,
}

impl RenderedEntry {
    fn height(&self) -> usize {
        self.lines.len()
    }

    /// Append the role's blank rows unless the last row is already blank.
    /// That blank row is the collapsed Section/Block gap, so adding another
    /// would sum the margins instead of collapsing them.
    fn push_gap(&mut self, gap: Gap) {
        for _ in 0..gap.rows() {
            if self.last_is_blank() {
                break;
            }
            self.lines.push(Line::default());
            self.hits.push(None);
        }
    }

    fn last_is_blank(&self) -> bool {
        self.lines
            .last()
            .is_some_and(|line| line.spans.iter().all(|span| span.content.trim().is_empty()))
    }
}

/// How one display unit opens and closes for adjacent-gap purposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    /// Part of the compact process group (thinking header, tool summary).
    Process,
    /// A visible answer or interrupted note.
    Answer,
    /// A turn boundary: user, notice, context, echo.
    Turn,
}

/// The leading and trailing roles one entry contributes to the rhythm.
fn entry_roles(entry: &Entry) -> (Role, Role) {
    match &entry.kind {
        EntryKind::User { .. }
        | EntryKind::Notice { .. }
        | EntryKind::Context { .. }
        | EntryKind::Echo { .. } => (Role::Turn, Role::Turn),
        EntryKind::Assistant {
            text, reasoning, ..
        } => {
            if text.trim().is_empty() && reasoning.trim().is_empty() {
                // `render_entry` returns before drawing anything.
                (Role::Turn, Role::Turn)
            } else if text.trim().is_empty() {
                (Role::Process, Role::Process)
            } else if reasoning.trim().is_empty() {
                (Role::Answer, Role::Answer)
            } else {
                (Role::Process, Role::Answer)
            }
        }
        EntryKind::Tool(_) => (Role::Process, Role::Process),
        EntryKind::Preview(preview) => {
            if preview.text.trim().is_empty() {
                (Role::Process, Role::Process)
            } else {
                (Role::Process, Role::Answer)
            }
        }
    }
}

/// Every visible unit now gets a block gap. The roles stay part of the model
/// so a future, denser rhythm can re-introduce `None` without changing callers.
fn gap_between(_previous: Role, _next: Role) -> Gap {
    Gap::Block
}

/// One display unit: single entries render one-to-one; adjacent ordinary
/// context injections merge into a single disclosure.
enum Unit<'a> {
    Single(&'a Entry),
    Context(Vec<&'a Entry>),
}

impl<'a> Unit<'a> {
    fn identity(&self) -> &'a str {
        match self {
            Self::Single(entry) => &entry.identity,
            Self::Context(entries) => &entries[0].identity,
        }
    }

    fn fingerprint(&self) -> u64 {
        match self {
            Self::Single(entry) => entry.fingerprint,
            Self::Context(entries) => entries.iter().fold(entries.len() as u64, |hash, entry| {
                hash.wrapping_mul(1_099_511_628_211)
                    .wrapping_add(entry.fingerprint)
            }),
        }
    }

    fn roles(&self) -> (Role, Role) {
        match self {
            Self::Single(entry) => entry_roles(entry),
            Self::Context(_) => (Role::Turn, Role::Turn),
        }
    }

    /// An assistant step that only requested tools renders no content. It
    /// stays as a zero-height barrier so it still separates context groups.
    fn is_empty(&self) -> bool {
        match self {
            Self::Single(entry) => matches!(
                &entry.kind,
                EntryKind::Assistant { text, reasoning, .. }
                    if text.trim().is_empty() && reasoning.trim().is_empty()
            ),
            Self::Context(_) => false,
        }
    }
}

/// Group consecutive ordinary injected context into one display unit.
/// Bash and monitor context keep their own labels and never join a group.
fn units(model: &TranscriptModel) -> Vec<Unit<'_>> {
    let mut units: Vec<Unit<'_>> = Vec::new();
    for entry in model.entries() {
        let ordinary = matches!(
            &entry.kind,
            EntryKind::Context {
                bash: false,
                monitor: false,
                ..
            }
        );
        if ordinary {
            if let Some(Unit::Context(entries)) = units.last_mut() {
                entries.push(entry);
                continue;
            }
            units.push(Unit::Context(vec![entry]));
        } else {
            units.push(Unit::Single(entry));
        }
    }
    units
}

fn render_unit(
    unit: &Unit<'_>,
    width: usize,
    expanded: bool,
    theme: Theme,
    gap_after: Gap,
) -> RenderedEntry {
    let mut output = match unit {
        Unit::Single(entry) => render_entry(entry, width, expanded, theme),
        Unit::Context(entries) => {
            let mut output = RenderedEntry::default();
            render_context_group(
                &mut output,
                unit.identity(),
                entries,
                width,
                expanded,
                theme,
            );
            output
        }
    };
    output.push_gap(gap_after);
    output
}

impl RenderCache {
    /// Empty cache.
    pub fn new() -> Self {
        Self::default()
    }

    fn ensure<F>(
        &mut self,
        identity: &str,
        fingerprint: u64,
        width: usize,
        expanded: bool,
        theme: Theme,
        gap: Gap,
        render: F,
    ) -> &RenderedEntry
    where
        F: FnOnce() -> RenderedEntry,
    {
        let key = (
            identity.to_string(),
            fingerprint,
            width.max(1),
            expanded,
            theme as u8,
            gap as u8,
        );
        if !self.lines.contains_key(&key) {
            let rendered = render();
            self.heights.insert(key.clone(), rendered.height());
            self.order.push_back(key.clone());
            self.lines.insert(key.clone(), rendered);
            while self.order.len() > MAX_CACHED_ENTRIES {
                if let Some(oldest) = self.order.pop_front() {
                    self.lines.remove(&oldest);
                }
            }
            if self.heights.len() > MAX_CACHED_ENTRIES * 4 {
                self.heights.clear();
                for key in &self.order {
                    if let Some(rendered) = self.lines.get(key) {
                        self.heights.insert(key.clone(), rendered.height());
                    }
                }
            }
        }
        self.lines.get(&key).expect("entry was just cached")
    }

    fn height<F>(
        &mut self,
        identity: &str,
        fingerprint: u64,
        width: usize,
        expanded: bool,
        theme: Theme,
        gap: Gap,
        render: F,
    ) -> usize
    where
        F: FnOnce() -> RenderedEntry,
    {
        let key = (
            identity.to_string(),
            fingerprint,
            width.max(1),
            expanded,
            theme as u8,
            gap as u8,
        );
        if let Some(height) = self.heights.get(&key) {
            return *height;
        }
        self.ensure(identity, fingerprint, width, expanded, theme, gap, render)
            .height()
    }

    /// Drop cache rows for entries that no longer exist.
    pub fn retain(&mut self, identities: &HashSet<&str>) {
        self.lines
            .retain(|(identity, _, _, _, _, _), _| identities.contains(identity.as_str()));
        self.order
            .retain(|(identity, _, _, _, _, _)| identities.contains(identity.as_str()));
        self.heights
            .retain(|(identity, _, _, _, _, _), _| identities.contains(identity.as_str()));
    }
}

/// Render the visible transcript window.
pub fn render(
    model: &TranscriptModel,
    cache: &mut RenderCache,
    scroll: &mut ScrollState,
    width: usize,
    viewport: usize,
    theme: Theme,
) -> TranscriptRender {
    let width = width.max(1);
    let viewport = viewport.max(1);
    let units = units(model);
    let roles: Vec<(Role, Role)> = units.iter().map(Unit::roles).collect();
    let gaps: Vec<Gap> = (0..units.len())
        .map(|index| {
            if units[index].is_empty() {
                return Gap::None;
            }
            match roles.get(index + 1) {
                Some((next_lead, _)) => gap_between(roles[index].1, *next_lead),
                None => Gap::Block,
            }
        })
        .collect();
    let mut entries = Vec::new();
    let mut starts = Vec::new();
    let mut start = 0usize;
    for (index, unit) in units.iter().enumerate() {
        let expanded = model.is_expanded(unit.identity());
        let gap = gaps[index];
        let height = cache.height(
            unit.identity(),
            unit.fingerprint(),
            width,
            expanded,
            theme,
            gap,
            || render_unit(unit, width, expanded, theme, gap),
        );
        starts.push(start);
        entries.push(EntryOffset {
            identity: unit.identity().to_string(),
            start,
            height,
        });
        start += height;
    }
    let total = start;
    let top = scroll.top(total, viewport, &entries);
    let limit = MAX_MOUNTED_ROWS.max(viewport);
    let mut window_start = top.saturating_sub(OVERSCAN_ROWS);
    let mut window_end = (top + viewport + OVERSCAN_ROWS).min(total);
    if window_end.saturating_sub(window_start) > limit {
        window_start = window_end.saturating_sub(limit);
        if window_start > top {
            window_start = top;
            window_end = (top + limit).min(total);
        }
    }
    let mut lines = Vec::new();
    let mut hits = Vec::new();
    let mut base = None;
    for (index, unit) in units.iter().enumerate() {
        let offset = &entries[index];
        let entry_end = offset.start + offset.height;
        if entry_end <= window_start || offset.start >= window_end {
            continue;
        }
        let expanded = model.is_expanded(unit.identity());
        let gap = gaps[index];
        let rendered = cache
            .ensure(
                unit.identity(),
                unit.fingerprint(),
                width,
                expanded,
                theme,
                gap,
                || render_unit(unit, width, expanded, theme, gap),
            )
            .clone();
        let first = window_start.saturating_sub(offset.start);
        let last = (window_end - offset.start).min(rendered.lines.len());
        if first >= last {
            continue;
        }
        if base.is_none() {
            base = Some(offset.start + first);
        }
        lines.extend(rendered.lines[first..last].iter().cloned());
        hits.extend(rendered.hits[first..last].iter().cloned());
    }
    let base = base.unwrap_or(0);
    let local_top = top.saturating_sub(base).min(lines.len());
    let local_end = (local_top + viewport).min(lines.len());
    lines = lines[local_top..local_end].to_vec();
    hits = hits[local_top..local_end].to_vec();
    let mounted = lines.len();
    scroll.after_render(total, viewport, &entries, top);
    let identities: HashSet<&str> = model
        .entries()
        .iter()
        .map(|entry| entry.identity.as_str())
        .collect();
    cache.retain(&identities);
    TranscriptRender {
        lines,
        hits,
        total_height: total,
        top,
        mounted,
        entries,
    }
}

fn render_entry(entry: &Entry, width: usize, expanded: bool, theme: Theme) -> RenderedEntry {
    let mut output = RenderedEntry::default();
    if let EntryKind::Assistant {
        text, reasoning, ..
    } = &entry.kind
    {
        if text.trim().is_empty() && reasoning.trim().is_empty() {
            // The assistant settled a step that only requested tool calls; the
            // tool cards below carry the visible content.
            return output;
        }
    }
    match &entry.kind {
        EntryKind::User { text } => render_user(&mut output, width, text, theme),
        EntryKind::Assistant {
            text,
            reasoning,
            reasoning_ms,
            interrupted,
        } => {
            let has_thinking = !reasoning.trim().is_empty();
            if has_thinking {
                render_thinking(
                    &mut output,
                    &entry.identity,
                    reasoning,
                    *reasoning_ms,
                    width,
                    expanded,
                    theme,
                );
            }
            if has_thinking && (!text.trim().is_empty() || *interrupted) {
                output.push_gap(Gap::Section);
            }
            if !text.trim().is_empty() {
                for row in markdown_rows(text, width, theme) {
                    output.lines.push(row);
                    output.hits.push(None);
                }
            }
            if *interrupted {
                output
                    .lines
                    .push(Line::from(Span::styled("（中断前的片段）", muted(theme))));
                output.hits.push(None);
            }
        }
        EntryKind::Notice { text, is_error } => {
            let color = if *is_error {
                theme.colors().error
            } else {
                theme.colors().muted
            };
            for row in wrap_block(text, width, MAX_BLOCK_ROWS) {
                output
                    .lines
                    .push(Line::from(Span::styled(row, Style::default().fg(color))));
                output.hits.push(None);
            }
        }
        EntryKind::Context {
            text,
            bash,
            monitor,
        } => {
            if *bash || *monitor {
                let (label, color) = if *bash {
                    ("bash", theme.colors().warning)
                } else {
                    ("monitor · role=user", theme.colors().accent)
                };
                render_labeled_context(
                    &mut output,
                    &entry.identity,
                    width,
                    ContextLabel { text: label, color },
                    text,
                    expanded,
                    theme,
                );
            } else {
                render_context_group(
                    &mut output,
                    &entry.identity,
                    &[entry],
                    width,
                    expanded,
                    theme,
                );
            }
        }
        EntryKind::Tool(record) => render_tool(&mut output, record, width, expanded, theme),
        EntryKind::Preview(preview) => render_preview(&mut output, preview, width, theme),
        EntryKind::Echo { text, state } => render_echo(&mut output, width, text, state, theme),
    }
    output
}

fn muted(theme: Theme) -> Style {
    Style::default().fg(theme.colors().muted)
}

fn render_user(output: &mut RenderedEntry, width: usize, text: &str, theme: Theme) {
    let style = Style::default()
        .fg(theme.colors().accent)
        .add_modifier(Modifier::BOLD);
    let rows = wrap_block(
        text,
        width.saturating_sub(spacing::INDENT).max(1),
        MAX_BLOCK_ROWS,
    );
    for (index, row) in rows.into_iter().enumerate() {
        let prefix = if index == 0 {
            "> ".to_string()
        } else {
            " ".repeat(spacing::INDENT)
        };
        output.lines.push(Line::from(vec![
            Span::styled(prefix, style),
            Span::styled(row, style),
        ]));
        output.hits.push(None);
    }
}

fn render_echo(output: &mut RenderedEntry, width: usize, text: &str, state: &str, theme: Theme) {
    let style = Style::default()
        .fg(theme.colors().accent)
        .add_modifier(Modifier::BOLD);
    let rows = wrap_block(
        text,
        width.saturating_sub(spacing::INDENT).max(1),
        MAX_BLOCK_ROWS,
    );
    let suffix = format!("（{state}）");
    let suffix_width = suffix.chars().map(char_width).sum::<usize>();
    let last = rows.len().saturating_sub(1);
    let mut appended = false;
    for (index, row) in rows.into_iter().enumerate() {
        let prefix = if index == 0 {
            "> ".to_string()
        } else {
            " ".repeat(spacing::INDENT)
        };
        let row_width = row.chars().map(char_width).sum::<usize>();
        let mut spans = vec![Span::styled(prefix, style), Span::styled(row, style)];
        if index == last && spacing::INDENT + row_width + suffix_width <= width {
            spans.push(Span::styled(suffix.clone(), muted(theme)));
            appended = true;
        }
        output.lines.push(Line::from(spans));
        output.hits.push(None);
    }
    // The state suffix never gets clipped: when the last text row has no
    // room, it becomes its own muted line.
    if !appended {
        output
            .lines
            .push(Line::from(Span::styled(suffix, muted(theme))));
        output.hits.push(None);
    }
}

fn render_thinking(
    output: &mut RenderedEntry,
    identity: &str,
    reasoning: &str,
    reasoning_ms: Option<u64>,
    width: usize,
    expanded: bool,
    theme: Theme,
) {
    let marker = if expanded { "▾" } else { "▸" };
    let meta = reasoning_ms
        .map(format_duration)
        .unwrap_or_else(|| "用时未知".to_string());
    let hit = Some(Hit {
        identity: identity.to_string(),
        kind: HitKind::Toggle,
    });
    push_two_column(
        output,
        vec![Span::styled(format!("{marker} 思考 已完成"), muted(theme))],
        vec![Span::styled(meta, muted(theme))],
        width,
        hit.clone(),
    );
    if expanded {
        for row in wrap_block(
            reasoning,
            width.saturating_sub(spacing::INDENT).max(1),
            MAX_BLOCK_ROWS,
        ) {
            output.lines.push(Line::from(Span::styled(
                format!("{}{row}", " ".repeat(spacing::INDENT)),
                muted(theme),
            )));
            output.hits.push(hit.clone());
        }
    }
}

fn render_tool(
    output: &mut RenderedEntry,
    record: &ToolRecord,
    width: usize,
    expanded: bool,
    theme: Theme,
) {
    let question_hit = question_hit(record);
    match &record.display {
        ToolDisplay::Bash {
            command,
            description,
            output: body,
            exit,
        } => {
            let status = record.display_status;
            let command_rows = command
                .as_deref()
                .map(|command| {
                    wrap_block(
                        command,
                        width.saturating_sub(spacing::INDENT).max(1),
                        MAX_BLOCK_ROWS,
                    )
                })
                .unwrap_or_default();
            let output_rows = wrap_block(
                body,
                width.saturating_sub(spacing::INDENT).max(1),
                MAX_BLOCK_ROWS,
            );
            let (shown_command, shown_output): (Vec<String>, Vec<String>) = if expanded {
                (command_rows.clone(), output_rows.clone())
            } else {
                let command = command_rows.iter().take(COMMAND_BUDGET).cloned().collect();
                let output = match status {
                    DisplayStatus::Pending => Vec::new(),
                    DisplayStatus::Failed | DisplayStatus::Interrupted => {
                        output_rows.iter().take(FAILURE_BUDGET).cloned().collect()
                    }
                    _ => output_rows
                        .iter()
                        .rev()
                        .take(OUTPUT_BUDGET)
                        .rev()
                        .cloned()
                        .collect(),
                };
                (command, output)
            };
            let hidden = command_rows
                .len()
                .saturating_sub(shown_command.len())
                .saturating_add(output_rows.len().saturating_sub(shown_output.len()));
            let title = description
                .as_deref()
                .filter(|description| !description.trim().is_empty())
                .map(str::to_string)
                .or_else(|| {
                    command
                        .as_deref()
                        .and_then(|command| command.lines().next())
                        .map(str::to_string)
                })
                .filter(|title| !title.trim().is_empty())
                .unwrap_or_else(|| "Bash".to_string());
            let marker = if expanded { "▾" } else { "▸" };
            let mut left = vec![
                Span::styled(format!("{marker} "), muted(theme)),
                Span::styled("Bash", muted(theme)),
                Span::styled(format!(" {}", title.replace('\r', "")), muted(theme)),
            ];
            if hidden > 0 {
                left.push(Span::styled(format!(" +{hidden} 行"), muted(theme)));
            }
            push_two_column(
                output,
                left,
                vec![Span::styled(
                    status.label(),
                    process_status_style(status, theme),
                )],
                width,
                toggle_hit(record),
            );
            for row in &shown_command {
                output.lines.push(Line::from(Span::styled(
                    format!("{}{row}", " ".repeat(spacing::INDENT)),
                    muted(theme),
                )));
                output.hits.push(toggle_hit(record));
            }
            if status == DisplayStatus::Pending && !expanded {
                output.lines.push(Line::from(Span::styled(
                    format!(
                        "{}（等待结果；没有来源时不显示假输出）",
                        " ".repeat(spacing::INDENT)
                    ),
                    muted(theme),
                )));
                output.hits.push(toggle_hit(record));
            }
            for row in &shown_output {
                output.lines.push(Line::from(Span::styled(
                    format!("{}{row}", " ".repeat(spacing::INDENT)),
                    muted(theme),
                )));
                output.hits.push(toggle_hit(record));
            }
            let show_exit = match exit {
                ExitStatus::Code(0) => false,
                ExitStatus::Unknown => status == DisplayStatus::Unknown,
                _ => true,
            };
            if show_exit {
                let exit_style = match exit {
                    ExitStatus::Code(0) => Style::default().fg(theme.colors().success),
                    ExitStatus::Unknown => Style::default().fg(theme.colors().warning),
                    _ => Style::default().fg(theme.colors().error),
                };
                output.lines.push(Line::from(vec![
                    Span::raw(" ".repeat(spacing::INDENT)),
                    Span::styled(exit.label(), exit_style),
                ]));
                output.hits.push(toggle_hit(record));
            }
        }
        ToolDisplay::File { path, diff } => {
            let name = official_name(&record.name);
            let mut right = Vec::new();
            if let Some(diff) = diff {
                if let Some(added) = diff.added {
                    right.push(Span::styled(
                        format!("+{added}"),
                        Style::default().fg(theme.colors().diff_add_fg),
                    ));
                }
                if let Some(deleted) = diff.deleted {
                    if !right.is_empty() {
                        right.push(Span::raw(" "));
                    }
                    right.push(Span::styled(
                        format!("-{deleted}"),
                        Style::default().fg(theme.colors().diff_del_fg),
                    ));
                }
                if right.is_empty() {
                    right.push(Span::styled("±?", muted(theme)));
                }
            } else {
                right.push(Span::styled("±?", muted(theme)));
            }
            let marker = if expanded { "▾" } else { "▸" };
            let path = path.clone().unwrap_or_else(|| "(未知文件)".to_string());
            push_two_column(
                output,
                vec![
                    Span::styled(format!("{marker} "), muted(theme)),
                    Span::styled(format!("{name} "), muted(theme)),
                    Span::styled(path, Style::default().add_modifier(Modifier::BOLD)),
                ],
                right,
                width,
                toggle_hit(record),
            );
            if let Some(diff) = diff {
                output.lines.push(Line::from(Span::styled(
                    "─".repeat(width.max(1)),
                    Style::default().fg(theme.colors().rule),
                )));
                output.hits.push(toggle_hit(record));
                output.lines.push(Line::from(Span::styled(
                    format!("{}{}", " ".repeat(spacing::INDENT), diff.state.label()),
                    muted(theme),
                )));
                output.hits.push(toggle_hit(record));
                render_diff_body(output, diff, width, expanded, record, theme);
            } else {
                output.lines.push(Line::from(Span::styled(
                    format!("{}（没有可显示的差异数据）", " ".repeat(spacing::INDENT)),
                    muted(theme),
                )));
                output.hits.push(toggle_hit(record));
            }
        }
        ToolDisplay::AskUser { record: question } => {
            output.lines.push(Line::from(vec![
                Span::styled("问卷 ", Style::default().fg(theme.colors().accent)),
                Span::styled(
                    question.state.label(),
                    Style::default().fg(match question.state {
                        RecordedQuestionState::Settled => theme.colors().success,
                        RecordedQuestionState::Cancelled => theme.colors().error,
                        RecordedQuestionState::Submitted => theme.colors().warning,
                        _ => theme.colors().accent,
                    }),
                ),
                Span::styled(format!(" · {} 题", question.questions.len()), muted(theme)),
                Span::styled(
                    if question_hit.is_some() {
                        " · 点击查看"
                    } else {
                        ""
                    },
                    muted(theme),
                ),
            ]));
            output.hits.push(question_hit.clone());
            for (index, item) in question.questions.iter().enumerate() {
                if index >= 3 && !expanded {
                    break;
                }
                let answer = question
                    .answers
                    .iter()
                    .find(|answer| answer.id == item.id)
                    .map(answer_label)
                    .unwrap_or_else(|| {
                        if question.state == RecordedQuestionState::Settled {
                            "（跳过）".to_string()
                        } else {
                            question.state.label().to_string()
                        }
                    });
                let text = format!(
                    "{}{} → {}",
                    " ".repeat(spacing::INDENT),
                    one_line(&item.question),
                    answer
                );
                for (offset, row) in wrap_line(&text, width).into_iter().enumerate() {
                    output.lines.push(Line::from(vec![
                        Span::styled(
                            if offset == 0 {
                                " ".repeat(spacing::INDENT)
                            } else {
                                " ".repeat(spacing::NESTED)
                            },
                            Style::default(),
                        ),
                        Span::styled(row, muted(theme)),
                    ]));
                    output.hits.push(question_hit.clone());
                }
            }
        }
        ToolDisplay::Generic => {
            let name = official_name(&record.name);
            let body = record.result.as_deref().unwrap_or("");
            let rows = wrap_block(
                body,
                width.saturating_sub(spacing::INDENT).max(1),
                MAX_BLOCK_ROWS,
            );
            let shown = if expanded {
                rows.len()
            } else {
                rows.len().min(FAILURE_BUDGET.max(OUTPUT_BUDGET))
            };
            let hidden = rows.len().saturating_sub(shown);
            let marker = if expanded { "▾" } else { "▸" };
            let mut left = vec![
                Span::styled(format!("{marker} "), muted(theme)),
                Span::styled(name, muted(theme)),
            ];
            if let Some(target) = tool_target(record) {
                left.push(Span::styled(format!(" {target}"), muted(theme)));
            }
            if hidden > 0 {
                left.push(Span::styled(format!(" +{hidden} 行"), muted(theme)));
            }
            push_two_column(
                output,
                left,
                vec![Span::styled(
                    record.display_status.label(),
                    process_status_style(record.display_status, theme),
                )],
                width,
                toggle_hit(record),
            );
            for row in rows.iter().take(shown) {
                output.lines.push(Line::from(Span::styled(
                    format!("{}{row}", " ".repeat(spacing::INDENT)),
                    muted(theme),
                )));
                output.hits.push(toggle_hit(record));
            }
        }
    }
    if record.display_status == DisplayStatus::Unknown {
        output.lines.push(Line::from(Span::styled(
            format!("{}工具未返回成功或失败结论", " ".repeat(spacing::INDENT)),
            muted(theme),
        )));
        output.hits.push(toggle_hit(record));
    }
    if let Some(approval) = &record.approval {
        render_approval_line(output, approval, record, theme);
    }
}

fn render_approval_line(
    output: &mut RenderedEntry,
    approval: &ApprovalView,
    record: &ToolRecord,
    theme: Theme,
) {
    let reason = approval
        .display_reason
        .get("zh")
        .or_else(|| approval.display_reason.get("en"))
        .map(String::as_str)
        .or(approval.reason.as_deref())
        .unwrap_or("");
    output.lines.push(Line::from(vec![
        Span::styled(
            format!("{}审批 ", " ".repeat(spacing::INDENT)),
            muted(theme),
        ),
        Span::styled(
            approval.outcome_label(),
            Style::default().fg(match approval.outcome {
                Some(nano_decisions::approval::ApprovalOutcome::AllowedOnce) => {
                    theme.colors().success
                }
                Some(nano_decisions::approval::ApprovalOutcome::Rejected) => theme.colors().error,
                Some(nano_decisions::approval::ApprovalOutcome::Cancelled) => {
                    theme.colors().warning
                }
                Some(nano_decisions::approval::ApprovalOutcome::Unavailable) => {
                    theme.colors().error
                }
                None => theme.colors().muted,
            }),
        ),
        Span::styled(
            if reason.is_empty() {
                String::new()
            } else {
                format!(" · {reason}")
            },
            muted(theme),
        ),
    ]));
    output.hits.push(toggle_hit(record));
}

fn render_diff_body(
    output: &mut RenderedEntry,
    diff: &DiffView,
    width: usize,
    expanded: bool,
    record: &ToolRecord,
    theme: Theme,
) {
    if diff.coarse {
        output.lines.push(Line::from(Span::styled(
            format!("{}（差异过大，仅显示统计）", " ".repeat(spacing::INDENT)),
            Style::default().fg(theme.colors().warning),
        )));
        output.hits.push(toggle_hit(record));
        return;
    }
    let mut rows: Vec<DiffRow> = Vec::new();
    for (index, hunk) in diff.hunks.iter().enumerate() {
        if index > 0 {
            rows.push(DiffRow::Separator(format!(
                "… 另一处修改（旧 {} 行 / 新 {} 行）",
                hunk.old_lines, hunk.new_lines
            )));
        }
        for line in &hunk.lines {
            rows.push(DiffRow::Line(line.clone()));
        }
    }
    let text_width = width.saturating_sub(7).max(1);
    let total: usize = rows
        .iter()
        .map(|row| match row {
            DiffRow::Line(line) => wrap_row_count(&line.text, text_width),
            DiffRow::Separator(_) => 1,
        })
        .sum();
    let budget = if expanded { total } else { DIFF_BUDGET };
    let mut shown = 0usize;
    for row in &rows {
        if shown >= budget {
            break;
        }
        match row {
            DiffRow::Separator(label) => {
                output.lines.push(Line::from(Span::styled(
                    format!("{}{label}", " ".repeat(spacing::INDENT)),
                    muted(theme),
                )));
                output.hits.push(toggle_hit(record));
                shown += 1;
            }
            DiffRow::Line(line) => {
                shown += render_diff_line(output, line, width, record, theme, budget - shown);
            }
        }
    }
    let hidden = total.saturating_sub(shown);
    if hidden > 0 {
        let suffix = if expanded {
            "（超出显示上限）"
        } else {
            " · 点击展开"
        };
        output.lines.push(Line::from(Span::styled(
            format!("{}… 还有 {hidden} 行{suffix}", " ".repeat(spacing::INDENT)),
            muted(theme),
        )));
        output.hits.push(toggle_hit(record));
    }
}

fn render_diff_line(
    output: &mut RenderedEntry,
    line: &DiffLine,
    width: usize,
    record: &ToolRecord,
    theme: Theme,
    max_rows: usize,
) -> usize {
    if max_rows == 0 {
        return 0;
    }
    let kind = line.kind;
    let number = line.old_no.or(line.new_no);
    let number = number
        .map(|number| format!("{number:>width$}", width = DIFF_LINE_NUMBER_WIDTH))
        .unwrap_or_else(|| " ".repeat(DIFF_LINE_NUMBER_WIDTH));
    let colors = theme.colors();
    let (marker, background, emphasis_background, marker_color) = match kind {
        DiffLineKind::Add => (
            '+',
            Some(colors.diff_add_bg),
            Some(colors.diff_add_word_bg),
            colors.diff_add_fg,
        ),
        DiffLineKind::Delete => (
            '-',
            Some(colors.diff_del_bg),
            Some(colors.diff_del_word_bg),
            colors.diff_del_fg,
        ),
        DiffLineKind::Context => (' ', None, None, colors.muted),
    };
    let number_style = Style::default().fg(colors.muted);
    let text_style = Style::default().fg(colors.fg);
    let (number_style, text_style) = match background {
        Some(background) => (number_style.bg(background), text_style.bg(background)),
        None => (number_style, text_style),
    };
    let marker_style = Style::default().fg(marker_color);
    let marker_style = match background {
        Some(background) => marker_style.bg(background),
        None => marker_style,
    };
    let blank_style = match background {
        Some(background) => Style::default().bg(background),
        None => Style::default(),
    };
    let text_width = width.saturating_sub(7).max(1);
    let mut text_offset = 0usize;
    let mut rendered = 0usize;
    for (row_index, row) in wrap_line(&line.text, text_width)
        .into_iter()
        .take(max_rows)
        .enumerate()
    {
        let mut spans = Vec::new();
        if row_index == 0 {
            spans.push(Span::styled(number.clone(), number_style));
            spans.push(Span::styled(" ", blank_style));
            spans.push(Span::styled(marker.to_string(), marker_style));
            spans.push(Span::styled(" ", blank_style));
        } else {
            spans.push(Span::styled(" ".repeat(7), blank_style));
        }
        let mut run = String::new();
        let mut current_bold = line
            .emphasis
            .map(|(start, end)| text_offset >= start && text_offset < end)
            .unwrap_or(false);
        for (index, character) in row.chars().enumerate() {
            let bold = line
                .emphasis
                .map(|(start, end)| {
                    let index = text_offset + index;
                    index >= start && index < end
                })
                .unwrap_or(false);
            if bold != current_bold && !run.is_empty() {
                let mut style = text_style;
                if current_bold {
                    style = style
                        .add_modifier(Modifier::BOLD)
                        .fg(colors.fg)
                        .bg(emphasis_background.unwrap_or(Color::Reset));
                }
                spans.push(Span::styled(std::mem::take(&mut run), style));
                current_bold = bold;
            }
            run.push(character);
        }
        if !run.is_empty() {
            let mut style = text_style;
            if current_bold {
                style = style
                    .add_modifier(Modifier::BOLD)
                    .fg(colors.fg)
                    .bg(emphasis_background.unwrap_or(Color::Reset));
            }
            spans.push(Span::styled(run, style));
        }
        let used = 7 + line_width(&row);
        if used < width {
            spans.push(Span::styled(" ".repeat(width - used), blank_style));
        }
        output.lines.push(Line::from(spans));
        output.hits.push(toggle_hit(record));
        text_offset += row.chars().count();
        rendered += 1;
    }
    rendered
}

enum DiffRow {
    Line(DiffLine),
    Separator(String),
}

fn render_preview(output: &mut RenderedEntry, preview: &PreviewEntry, width: usize, theme: Theme) {
    let (status, status_style) = if let Some(outcome) = preview.outcome {
        match outcome {
            PreviewOutcome::Committed => ("▸ 回答已提交", muted(theme)),
            PreviewOutcome::Abandoned => {
                ("▸ 生成已中断", Style::default().fg(theme.colors().warning))
            }
            PreviewOutcome::Unknown => ("▸ 未收到完整回答", muted(theme)),
        }
    } else {
        // A terminal `finish` chunk ends the stream but not the attempt; the
        // official settlement arrives with the end frame.
        ("▸ 生成中", muted(theme))
    };
    output
        .lines
        .push(Line::from(Span::styled(status, status_style)));
    output.hits.push(None);
    if !preview.reasoning.trim().is_empty() {
        let timing = preview
            .reasoning_ms
            .map(format_duration)
            .map(|duration| format!(" · {duration}"))
            .unwrap_or_default();
        let state = if preview.finished {
            "已结束"
        } else {
            "进行中…"
        };
        output.lines.push(Line::from(vec![
            Span::styled(format!("▸ 思考 {state}"), muted(theme)),
            Span::styled(timing, muted(theme)),
        ]));
        output.hits.push(None);
    }
    let text_rows = wrap_block(&preview.text, width, MAX_BLOCK_ROWS);
    let first = first_visible_row(&text_rows);
    if first < text_rows.len() {
        output.push_gap(Gap::Section);
    }
    for row in text_rows.into_iter().skip(first) {
        output
            .lines
            .push(Line::from(Span::styled(row, Style::default())));
        output.hits.push(None);
    }
    // The partial-content notice only applies while the attempt is live: a
    // finished attempt without a durable message must not promise a later one.
    if !preview.finished && (preview.gap || preview.truncated) {
        for row in wrap_block(
            "当前只显示部分生成内容，最终回答到达后会补全",
            width,
            MAX_BLOCK_ROWS,
        ) {
            output
                .lines
                .push(Line::from(Span::styled(row, muted(theme))));
            output.hits.push(None);
        }
    }
    for tool in &preview.tools {
        let name = official_name(tool.name.as_deref().unwrap_or("tool"));
        let state = if tool.complete {
            "参数完成"
        } else {
            "参数流入"
        };
        output.lines.push(Line::from(Span::styled(
            format!("▸ {name} {state}"),
            muted(theme),
        )));
        output.hits.push(None);
    }
}

/// The merged disclosure for consecutive ordinary injected context.
fn render_context_group(
    output: &mut RenderedEntry,
    identity: &str,
    entries: &[&Entry],
    width: usize,
    expanded: bool,
    theme: Theme,
) {
    let count = entries.len();
    let label = if count > 1 {
        format!("上下文 {count} 段")
    } else {
        "上下文".to_string()
    };
    output.lines.push(Line::from(vec![
        Span::styled(label, muted(theme)),
        Span::styled(
            if expanded {
                " · 已展开"
            } else {
                " · 点击展开"
            },
            muted(theme),
        ),
    ]));
    let hit = Some(Hit {
        identity: identity.to_string(),
        kind: HitKind::Toggle,
    });
    output.hits.push(hit.clone());
    if !expanded {
        return;
    }
    let mut written = 0usize;
    for entry in entries {
        let EntryKind::Context { text, .. } = &entry.kind else {
            continue;
        };
        let rows = wrap_block(text, width, MAX_BLOCK_ROWS);
        let first = first_visible_row(&rows);
        if first == rows.len() {
            continue;
        }
        if written > 0 {
            output.push_gap(Gap::Block);
        }
        for row in rows.into_iter().skip(first) {
            output
                .lines
                .push(Line::from(Span::styled(row, muted(theme))));
            output.hits.push(hit.clone());
        }
        written += 1;
    }
}

struct ContextLabel<'a> {
    text: &'a str,
    color: Color,
}

/// Bash and monitor context keep their own labels and never merge.
fn render_labeled_context(
    output: &mut RenderedEntry,
    identity: &str,
    width: usize,
    label: ContextLabel<'_>,
    text: &str,
    expanded: bool,
    theme: Theme,
) {
    let rows = wrap_block(text, width, MAX_BLOCK_ROWS);
    output.lines.push(Line::from(vec![
        Span::styled(label.text.to_string(), Style::default().fg(label.color)),
        Span::styled(
            if expanded {
                " · 已展开"
            } else {
                " · 点击展开"
            },
            muted(theme),
        ),
    ]));
    let hit = Some(Hit {
        identity: identity.to_string(),
        kind: HitKind::Toggle,
    });
    output.hits.push(hit.clone());
    let first = first_visible_row(&rows);
    let rows = &rows[first..];
    if rows.is_empty() {
        return;
    }
    let shown = if expanded {
        rows.len()
    } else {
        1.min(rows.len())
    };
    for row in rows.iter().take(shown) {
        output.lines.push(Line::from(Span::styled(
            row.clone(),
            Style::default().fg(label.color),
        )));
        output.hits.push(hit.clone());
    }
    if shown < rows.len() {
        output.lines.push(Line::from(Span::styled(
            format!(
                "{}… 还有 {} 行 · 点击展开",
                " ".repeat(spacing::INDENT),
                rows.len() - shown
            ),
            muted(theme),
        )));
        output.hits.push(hit);
    }
}

/// First row that carries visible text, skipping leading blank rows.
fn first_visible_row(rows: &[String]) -> usize {
    rows.iter()
        .position(|row| !row.trim().is_empty())
        .unwrap_or(rows.len())
}

/// Append one gap row unless the previous row is already blank.
fn push_row_gap(rows: &mut Vec<Line<'static>>, gap: Gap) {
    if rows.is_empty() || gap.rows() == 0 {
        return;
    }
    if rows
        .last()
        .is_some_and(|line| line.spans.iter().all(|span| span.content.trim().is_empty()))
    {
        return;
    }
    rows.push(Line::default());
}

/// Minimal Markdown: headings lose their marker and turn bold, a leading
/// paragraph acts as the answer's lead, list items use `-`, and `**…**`
/// turns bold inline. No third-party parser is involved.
fn markdown_rows(text: &str, width: usize, theme: Theme) -> Vec<Line<'static>> {
    let text = display_text(text);
    let mut blocks: Vec<Vec<&str>> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            if !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    let mut rows = Vec::new();
    for (block_index, block) in blocks.iter().enumerate() {
        if block_index > 0 {
            push_row_gap(&mut rows, Gap::Block);
        }
        let mut lead = block_index == 0;
        let mut previous_kind: Option<MarkdownKind> = None;
        let mut index = 0;
        while index < block.len() {
            if let Some(table) = parse_table(&block[index..], width) {
                let consumed = 2 + table.body.len();
                push_row_gap(&mut rows, Gap::Block);
                rows.extend(table_rows(
                    &table.header,
                    &table.aligns,
                    &table.body,
                    width,
                    theme,
                ));
                index += consumed;
                previous_kind = None;
                lead = false;
                if index < block.len() {
                    push_row_gap(&mut rows, Gap::Block);
                }
                continue;
            }
            let line = block[index].trim_end();
            let trimmed = line.trim_start();
            let kind = if heading_text(trimmed).is_some() {
                MarkdownKind::Heading
            } else if list_item(trimmed).is_some() {
                MarkdownKind::List
            } else {
                MarkdownKind::Paragraph
            };
            if previous_kind.is_some_and(|previous| markdown_gap(previous, kind)) {
                push_row_gap(&mut rows, Gap::Block);
            }
            previous_kind = Some(kind);
            if let Some(heading) = heading_text(trimmed) {
                for row in inline_rows(
                    heading,
                    width,
                    Style::default().add_modifier(Modifier::BOLD),
                ) {
                    rows.push(row);
                }
                lead = false;
            } else if let Some(item) = list_item(trimmed) {
                let item_rows = inline_rows(
                    item,
                    width.saturating_sub(spacing::INDENT).max(1),
                    Style::default(),
                );
                for (item_index, row) in item_rows.into_iter().enumerate() {
                    let prefix = if item_index == 0 {
                        "- ".to_string()
                    } else {
                        " ".repeat(spacing::INDENT)
                    };
                    let mut spans = vec![Span::styled(prefix, muted(theme))];
                    spans.extend(row.spans);
                    rows.push(Line::from(spans));
                }
                lead = false;
            } else {
                let style = if lead {
                    Style::default().add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                };
                for row in inline_rows(line, width, style) {
                    rows.push(row);
                }
                lead = false;
            }
            index += 1;
        }
    }
    rows
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MarkdownKind {
    Heading,
    List,
    Paragraph,
}

/// One blank line between semantic groups; tight inside a list or a heading
/// group.
fn markdown_gap(previous: MarkdownKind, current: MarkdownKind) -> bool {
    match (previous, current) {
        (MarkdownKind::Heading, MarkdownKind::Heading) => false,
        (MarkdownKind::Heading, _) => true,
        (MarkdownKind::List, MarkdownKind::List) => false,
        (MarkdownKind::List, _) => true,
        (_, MarkdownKind::List) => true,
        (MarkdownKind::Paragraph, MarkdownKind::Heading) => true,
        (MarkdownKind::Paragraph, MarkdownKind::Paragraph) => false,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TableAlign {
    Left,
    Right,
    Center,
}

struct ParsedTable {
    header: Vec<String>,
    aligns: Vec<TableAlign>,
    body: Vec<Vec<String>>,
}

/// A table needs a header row, a separator row, and matching column counts.
/// Anything else stays ordinary Markdown text.
fn parse_table(lines: &[&str], width: usize) -> Option<ParsedTable> {
    if lines.len() < 2 {
        return None;
    }
    let header_line = lines[0].trim_start();
    if heading_text(header_line).is_some() || list_item(header_line).is_some() {
        return None;
    }
    let header = split_table_cells(lines[0])?;
    let aligns = parse_table_separator(lines[1])?;
    if header.is_empty() || header.len() != aligns.len() {
        return None;
    }
    let columns = header.len();
    let minimum = columns * 2 + 3 * columns.saturating_sub(1);
    if minimum > width {
        return None;
    }
    let mut body = Vec::new();
    for line in &lines[2..] {
        let Some(cells) = split_table_cells(line) else {
            break;
        };
        if cells.len() != columns {
            break;
        }
        body.push(cells);
    }
    Some(ParsedTable {
        header,
        aligns,
        body,
    })
}

/// Split on unescaped pipes, keeping `\|` as a literal pipe inside a cell.
fn split_table_cells(line: &str) -> Option<Vec<String>> {
    let line = line.trim();
    if !line.contains('|') {
        return None;
    }
    let outer_left = line.starts_with('|');
    let outer_right = line.ends_with('|') && !line.ends_with("\\|");
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut characters = line.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '\\' if characters.peek() == Some(&'|') => {
                characters.next();
                current.push('|');
            }
            '|' => {
                cells.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(character),
        }
    }
    cells.push(current.trim().to_string());
    if outer_left && cells.first().is_some_and(|cell| cell.is_empty()) {
        cells.remove(0);
    }
    if outer_right && cells.last().is_some_and(|cell| cell.is_empty()) {
        cells.pop();
    }
    if cells.is_empty() {
        None
    } else {
        Some(cells)
    }
}

fn parse_table_separator(line: &str) -> Option<Vec<TableAlign>> {
    let cells = split_table_cells(line)?;
    let mut aligns = Vec::new();
    for cell in cells {
        let cell = cell.trim();
        if cell.is_empty() {
            return None;
        }
        let left = cell.starts_with(':');
        let right = cell.ends_with(':') && cell.len() > 1;
        let dashes = cell.strip_prefix(':').unwrap_or(cell);
        let dashes = dashes.strip_suffix(':').unwrap_or(dashes);
        if dashes.is_empty() || !dashes.chars().all(|character| character == '-') {
            return None;
        }
        aligns.push(match (left, right) {
            (true, true) => TableAlign::Center,
            (false, true) => TableAlign::Right,
            _ => TableAlign::Left,
        });
    }
    if aligns.is_empty() {
        None
    } else {
        Some(aligns)
    }
}

fn table_rows(
    header: &[String],
    aligns: &[TableAlign],
    body: &[Vec<String>],
    width: usize,
    theme: Theme,
) -> Vec<Line<'static>> {
    let columns = header.len();
    let separators = 3 * columns.saturating_sub(1);
    let minimum = columns * 2 + separators;
    if minimum > width {
        return Vec::new();
    }
    let mut widths: Vec<usize> = (0..columns)
        .map(|index| {
            let mut cell_width = plain_table_width(&header[index]).max(2);
            for row in body {
                if let Some(cell) = row.get(index) {
                    cell_width = cell_width.max(plain_table_width(cell));
                }
            }
            cell_width
        })
        .collect();
    let mut total = widths.iter().sum::<usize>() + separators;
    while total > width {
        let widest = widths
            .iter()
            .enumerate()
            .filter(|(_, cell_width)| **cell_width > 2)
            .max_by_key(|(_, cell_width)| **cell_width)
            .map(|(index, _)| index);
        let Some(index) = widest else {
            break;
        };
        widths[index] -= 1;
        total -= 1;
    }
    if total > width {
        return Vec::new();
    }
    let header_style = Style::default()
        .fg(theme.colors().accent)
        .add_modifier(Modifier::BOLD);
    let mut rows = table_row_lines(header, &widths, aligns, header_style, theme);
    rows.push(Line::from(Span::styled(
        "─".repeat(total),
        Style::default().fg(theme.colors().rule),
    )));
    for row in body {
        rows.extend(table_row_lines(
            row,
            &widths,
            aligns,
            Style::default(),
            theme,
        ));
    }
    rows
}

fn table_row_lines(
    cells: &[String],
    widths: &[usize],
    aligns: &[TableAlign],
    base: Style,
    theme: Theme,
) -> Vec<Line<'static>> {
    let wrapped: Vec<Vec<(Vec<Span<'static>>, usize)>> = widths
        .iter()
        .enumerate()
        .map(|(index, width)| {
            cell_rows(
                cells.get(index).map(String::as_str).unwrap_or(""),
                *width,
                base,
            )
        })
        .collect();
    let height = wrapped.iter().map(Vec::len).max().unwrap_or(1).max(1);
    let mut lines = Vec::new();
    for line_index in 0..height {
        let mut spans = Vec::new();
        for (index, width) in widths.iter().enumerate() {
            if index > 0 {
                spans.push(Span::styled(
                    " │ ",
                    Style::default().fg(theme.colors().muted),
                ));
            }
            let (content, used) = wrapped
                .get(index)
                .and_then(|rows| rows.get(line_index))
                .map(|(content, used)| (content.clone(), *used))
                .unwrap_or_default();
            let pad = width.saturating_sub(used);
            let (left, right) = match aligns.get(index).copied().unwrap_or(TableAlign::Left) {
                TableAlign::Left => (0, pad),
                TableAlign::Right => (pad, 0),
                TableAlign::Center => (pad / 2, pad - pad / 2),
            };
            if left > 0 {
                spans.push(Span::raw(" ".repeat(left)));
            }
            spans.extend(content);
            if right > 0 {
                spans.push(Span::raw(" ".repeat(right)));
            }
        }
        lines.push(Line::from(spans));
    }
    lines
}

fn plain_table_width(cell: &str) -> usize {
    line_width(&strip_inline_bold(cell).0)
}

fn cell_rows(text: &str, width: usize, base: Style) -> Vec<(Vec<Span<'static>>, usize)> {
    let (plain, flags) = strip_inline_bold(text);
    let mut rows = Vec::new();
    let mut offset = 0usize;
    for row in wrap_line(&plain, width.max(1)) {
        let mut spans: Vec<Span<'static>> = Vec::new();
        let mut run = String::new();
        let mut current_bold = flags.get(offset).copied().unwrap_or(false);
        for (index, character) in row.chars().enumerate() {
            let bold = flags.get(offset + index).copied().unwrap_or(false);
            if bold != current_bold && !run.is_empty() {
                let mut style = base;
                if current_bold {
                    style = style.add_modifier(Modifier::BOLD);
                }
                spans.push(Span::styled(std::mem::take(&mut run), style));
                current_bold = bold;
            }
            run.push(character);
        }
        if !run.is_empty() {
            let mut style = base;
            if current_bold {
                style = style.add_modifier(Modifier::BOLD);
            }
            spans.push(Span::styled(run, style));
        }
        let used = line_width(&row);
        offset += row.chars().count();
        rows.push((spans, used));
    }
    if rows.is_empty() {
        rows.push((Vec::new(), 0));
    }
    rows
}

fn heading_text(line: &str) -> Option<&str> {
    let hashes = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if hashes == 0 {
        return None;
    }
    let rest = line[hashes..].trim_start();
    if rest.is_empty() {
        None
    } else {
        Some(rest)
    }
}

fn list_item(line: &str) -> Option<&str> {
    let mut characters = line.chars();
    let marker = characters.next()?;
    if marker != '-' && marker != '*' {
        return None;
    }
    let rest = &line[marker.len_utf8()..];
    rest.strip_prefix(' ')
}

/// Wrap one logical line, styling `**…**` runs bold on top of `base`.
fn inline_rows(text: &str, width: usize, base: Style) -> Vec<Line<'static>> {
    let (plain, bold_flags) = strip_inline_bold(text);
    let mut rows = Vec::new();
    let mut offset = 0usize;
    for row in wrap_line(&plain, width.max(1)) {
        let count = row.chars().count();
        let mut spans: Vec<Span<'static>> = Vec::new();
        let mut run = String::new();
        let mut current_bold = bold_flags.get(offset).copied().unwrap_or(false);
        for (index, character) in row.chars().enumerate() {
            let bold = bold_flags.get(offset + index).copied().unwrap_or(false);
            if bold != current_bold && !run.is_empty() {
                let mut style = base;
                if current_bold {
                    style = style.add_modifier(Modifier::BOLD);
                }
                spans.push(Span::styled(std::mem::take(&mut run), style));
                current_bold = bold;
            }
            run.push(character);
        }
        if !run.is_empty() {
            let mut style = base;
            if current_bold {
                style = style.add_modifier(Modifier::BOLD);
            }
            spans.push(Span::styled(run, style));
        }
        if spans.is_empty() {
            spans.push(Span::styled(String::new(), base));
        }
        rows.push(Line::from(spans));
        offset += count;
    }
    if rows.is_empty() {
        rows.push(Line::default());
    }
    rows
}

/// Remove `**` markers and report which characters were emphasised.
fn strip_inline_bold(text: &str) -> (String, Vec<bool>) {
    let mut plain = String::new();
    let mut flags = Vec::new();
    let mut bold = false;
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '*' && characters.peek() == Some(&'*') {
            characters.next();
            bold = !bold;
            continue;
        }
        plain.push(character);
        flags.push(bold);
    }
    (plain, flags)
}

/// Pick the most useful argument for a generic tool's title.
fn tool_target(record: &ToolRecord) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(&record.arguments).ok()?;
    for key in ["file_path", "path", "pattern", "url"] {
        if let Some(target) = value.get(key).and_then(serde_json::Value::as_str) {
            if !target.trim().is_empty() {
                return Some(target.to_string());
            }
        }
    }
    None
}

fn official_name(name: &str) -> String {
    match name.to_ascii_lowercase().as_str() {
        "bash" => "Bash".to_string(),
        "read" => "Read".to_string(),
        "edit" => "Edit".to_string(),
        "write" => "Write".to_string(),
        "grep" => "Grep".to_string(),
        "glob" => "Glob".to_string(),
        "list" => "List".to_string(),
        "ask_user_question" => "AskUserQuestion".to_string(),
        _ => {
            let mut characters = name.chars();
            match characters.next() {
                Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
                None => "Tool".to_string(),
            }
        }
    }
}

fn process_status_style(status: DisplayStatus, theme: Theme) -> Style {
    match status {
        DisplayStatus::Failed => Style::default().fg(theme.colors().error),
        DisplayStatus::Interrupted | DisplayStatus::Unknown => {
            Style::default().fg(theme.colors().warning)
        }
        DisplayStatus::Pending | DisplayStatus::Succeeded => muted(theme),
    }
}

fn spans_width(spans: &[Span<'static>]) -> usize {
    spans.iter().map(Span::width).sum()
}

fn truncate_spans(spans: Vec<Span<'static>>, max: usize) -> Vec<Span<'static>> {
    let mut output = Vec::new();
    let mut used = 0usize;
    for span in spans {
        let style = span.style;
        let text = span.content.to_string();
        let mut kept = String::new();
        for character in text.chars() {
            let character_width = char_width(character);
            if used + character_width > max {
                break;
            }
            used += character_width;
            kept.push(character);
        }
        if !kept.is_empty() {
            output.push(Span::styled(kept, style));
        }
        if used >= max {
            break;
        }
    }
    output
}

/// One left-aligned row with a right-aligned status. The left side gives up
/// width first so the status stays visible at narrow terminals.
fn push_two_column(
    output: &mut RenderedEntry,
    left: Vec<Span<'static>>,
    right: Vec<Span<'static>>,
    width: usize,
    hit: Option<Hit>,
) {
    let width = width.max(1);
    let mut right = right;
    if spans_width(&right) > width {
        right = truncate_spans(right, width);
    }
    let right_width = spans_width(&right);
    let left_room = width.saturating_sub(right_width + spacing::INLINE);
    let mut left = truncate_spans(left, left_room);
    let left_width = spans_width(&left);
    let used = left_width + right_width;
    if used < width {
        left.push(Span::raw(" ".repeat(width - used)));
    }
    left.extend(right);
    output.lines.push(Line::from(left));
    output.hits.push(hit);
}
fn wrap_block(text: &str, width: usize, cap: usize) -> Vec<String> {
    let mut rows = Vec::new();
    for line in text.split('\n') {
        let line = line.replace('\r', "");
        for row in wrap_line(&line, width.max(1)) {
            if rows.len() >= cap {
                rows.push("…（内容已截断）".to_string());
                return rows;
            }
            rows.push(row);
        }
    }
    rows
}

fn toggle_hit(record: &ToolRecord) -> Option<Hit> {
    Some(Hit {
        identity: format!("call-{}", record.call_id),
        kind: HitKind::Toggle,
    })
}

fn question_hit(record: &ToolRecord) -> Option<Hit> {
    let ToolDisplay::AskUser { record: question } = &record.display else {
        return None;
    };
    if question.can_review() || question.answerable() {
        Some(Hit {
            identity: format!("call-{}", record.call_id),
            kind: HitKind::OpenQuestion {
                call_id: record.call_id.clone(),
            },
        })
    } else {
        None
    }
}

fn format_duration(ms: u64) -> String {
    if ms < 1_000 {
        format!("{ms}ms")
    } else if ms < 60_000 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        let seconds = ms / 1000;
        format!("{}m{:02}s", seconds / 60, seconds % 60)
    }
}

fn one_line(text: &str) -> String {
    elide(text.replace('\n', " ").trim(), 80)
}

fn answer_label(answer: &nano_decisions::contract::AnswerItem) -> String {
    let mut parts = answer.selected.clone();
    if let Some(custom) = answer
        .custom
        .as_deref()
        .filter(|text| !text.trim().is_empty())
    {
        parts.push(custom.to_string());
    }
    if parts.is_empty() {
        "（跳过）".to_string()
    } else {
        parts.join("、")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::DiffState;
    use crate::model::{PreviewTool, TranscriptSource};
    use crate::tool::{QuestionRecord, ToolDisplay, ToolRecord};
    use nano_conversation::{PreviewOutcome, SessionAddress, ToolStatus};
    use nano_decisions::contract::parse_questions;

    fn model(entries: Vec<Entry>) -> TranscriptModel {
        let mut model =
            TranscriptModel::new(SessionAddress::root("root"), TranscriptSource::Interactive);
        model.entries = entries;
        model
    }

    fn bash_entry(status: ToolStatus, output: &str, display: DisplayStatus) -> Entry {
        Entry {
            identity: "call-c-1".into(),
            fingerprint: 1,
            kind: EntryKind::Tool(ToolRecord {
                call_id: "c-1".into(),
                name: "bash".into(),
                status,
                display_status: display,
                turn: None,
                step: None,
                arguments: r#"{"command":"echo hi"}"#.into(),
                result: Some(output.into()),
                result_fact: None,
                approval: None,
                display: ToolDisplay::Bash {
                    command: Some("echo hi".into()),
                    description: None,
                    output: output.into(),
                    exit: ExitStatus::Unknown,
                },
            }),
        }
    }

    fn assistant_entry(identity: &str, text: &str, reasoning: &str) -> Entry {
        Entry {
            identity: identity.into(),
            fingerprint: identity.len() as u64 + 1,
            kind: EntryKind::Assistant {
                text: text.into(),
                reasoning: reasoning.into(),
                reasoning_ms: Some(2_800),
                interrupted: false,
            },
        }
    }

    fn preview_entry_with_thinking(text: &str, reasoning: &str) -> Entry {
        Entry {
            identity: "preview-1".into(),
            fingerprint: 99,
            kind: EntryKind::Preview(crate::model::PreviewEntry {
                attempt_id: "attempt-1".into(),
                turn: 1,
                step: 1,
                text: text.into(),
                reasoning: reasoning.into(),
                reasoning_ms: Some(1_200),
                tools: vec![PreviewTool {
                    name: Some("bash".into()),
                    complete: true,
                }],
                gap: false,
                truncated: false,
                finished: false,
                outcome: None,
            }),
        }
    }

    fn context_entry(identity: &str, text: &str) -> Entry {
        Entry {
            identity: identity.into(),
            fingerprint: identity.len() as u64,
            kind: EntryKind::Context {
                text: text.into(),
                bash: false,
                monitor: false,
            },
        }
    }

    fn bash_entry_named(identity: &str, call_id: &str, output: &str) -> Entry {
        Entry {
            identity: identity.into(),
            fingerprint: identity.len() as u64,
            kind: EntryKind::Tool(ToolRecord {
                call_id: call_id.into(),
                name: "bash".into(),
                status: ToolStatus::Succeeded,
                display_status: DisplayStatus::Succeeded,
                turn: None,
                step: None,
                arguments: r#"{"command":"echo hi"}"#.into(),
                result: Some(output.into()),
                result_fact: None,
                approval: None,
                display: ToolDisplay::Bash {
                    command: Some("echo hi".into()),
                    description: None,
                    output: output.into(),
                    exit: ExitStatus::Unknown,
                },
            }),
        }
    }

    fn render_model_lines(entries: Vec<Entry>, width: usize) -> Vec<String> {
        let model = model(entries);
        let mut cache = RenderCache::new();
        let mut scroll = ScrollState::default();
        let rendered = render(&model, &mut cache, &mut scroll, width, 40, Theme::Dark);
        rendered.lines.iter().map(ToString::to_string).collect()
    }

    fn render_one(entry: Entry, expanded: bool, width: usize) -> RenderedEntry {
        render_one_with_theme(entry, expanded, width, Theme::Dark)
    }

    fn render_one_with_theme(
        entry: Entry,
        expanded: bool,
        width: usize,
        theme: Theme,
    ) -> RenderedEntry {
        render_entry(&entry, width, expanded, theme)
    }

    #[test]
    fn a_long_transcript_mounts_only_a_bounded_window() {
        let mut model = model(
            (0..100)
                .map(|index| Entry {
                    identity: format!("seq-{index}"),
                    fingerprint: index as u64 + 1,
                    kind: EntryKind::User {
                        text: "line one\nline two\nline three".into(),
                    },
                })
                .collect(),
        );
        let mut cache = RenderCache::new();
        let mut scroll = ScrollState::default();
        let rendered = render(&model, &mut cache, &mut scroll, 80, 20, Theme::Dark);
        assert!(rendered.total_height > 100);
        assert!(rendered.mounted <= MAX_MOUNTED_ROWS);
        assert_eq!(rendered.lines.len(), 20);
        model.revision += 1;
    }

    #[test]
    fn a_viewport_taller_than_the_mount_cap_still_reaches_the_bottom() {
        let mut model = model(
            (0..100)
                .map(|index| Entry {
                    identity: format!("seq-{index}"),
                    fingerprint: index as u64 + 1,
                    kind: EntryKind::User {
                        text: "line one\nline two\nline three".into(),
                    },
                })
                .collect(),
        );
        let mut cache = RenderCache::new();
        let mut scroll = ScrollState::default();
        let viewport = 250;
        let rendered = render(&model, &mut cache, &mut scroll, 80, viewport, Theme::Dark);
        assert_eq!(rendered.lines.len(), viewport);
        assert_eq!(rendered.top + rendered.lines.len(), rendered.total_height);
        model.revision += 1;
    }

    #[test]
    fn a_wide_character_never_gets_split_by_the_renderer() {
        let mut model = model(vec![Entry {
            identity: "m-1".into(),
            fingerprint: 1,
            kind: EntryKind::User {
                text: "你好世界".into(),
            },
        }]);
        let mut cache = RenderCache::new();
        let mut scroll = ScrollState::default();
        let rendered = render(&model, &mut cache, &mut scroll, 4, 10, Theme::Dark);
        assert!(rendered
            .lines
            .iter()
            .all(|line| crate::display::line_width(&line.to_string()) <= 4));
        model.revision = 1;
    }

    #[test]
    fn a_long_diff_shows_at_most_eight_visual_rows_and_a_hidden_count() {
        let old = (0..20)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let new = (0..20)
            .map(|i| format!("changed {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let diff = crate::diff::single_text_diff(
            Some("a.txt".into()),
            Some(old),
            Some(new),
            DiffState::Applied,
        );
        let entry = Entry {
            identity: "call-c".into(),
            fingerprint: 1,
            kind: EntryKind::Tool(ToolRecord {
                call_id: "c".into(),
                name: "edit".into(),
                status: ToolStatus::Succeeded,
                display_status: DisplayStatus::Succeeded,
                turn: None,
                step: None,
                arguments: "{}".into(),
                result: None,
                result_fact: None,
                approval: None,
                display: ToolDisplay::File {
                    path: Some("a.txt".into()),
                    diff: Some(diff),
                },
            }),
        };
        let rendered = render_one(entry, false, 80);
        let body = rendered
            .lines
            .iter()
            .filter(|line| line.to_string().contains('+') || line.to_string().contains('-'))
            .count();
        assert!(body <= DIFF_BUDGET + 1);
        assert!(rendered
            .lines
            .iter()
            .any(|line| line.to_string().contains("还有")));
    }

    fn diff_entry(old: &str, new: &str) -> Entry {
        let diff = crate::diff::single_text_diff(
            Some("a.txt".into()),
            Some(old.into()),
            Some(new.into()),
            DiffState::Applied,
        );
        Entry {
            identity: "call-c".into(),
            fingerprint: 1,
            kind: EntryKind::Tool(ToolRecord {
                call_id: "c".into(),
                name: "edit".into(),
                status: ToolStatus::Succeeded,
                display_status: DisplayStatus::Succeeded,
                turn: None,
                step: None,
                arguments: "{}".into(),
                result: None,
                result_fact: None,
                approval: None,
                display: ToolDisplay::File {
                    path: Some("a.txt".into()),
                    diff: Some(diff),
                },
            }),
        }
    }

    #[test]
    fn a_wrapped_diff_line_spends_visual_row_budget() {
        let long = "x".repeat(400);
        let entry = diff_entry("a\n", &format!("a\n{long}"));
        let rendered = render_one(entry, false, 40);
        let colors = Theme::Dark.colors();
        let diff_rows = rendered
            .lines
            .iter()
            .filter(|line| {
                line.spans
                    .iter()
                    .any(|span| span.style.bg == Some(colors.diff_add_bg))
            })
            .count();
        assert_eq!(
            diff_rows,
            DIFF_BUDGET - 1,
            "one context row plus wrapped add rows"
        );
        let hidden = rendered
            .lines
            .iter()
            .map(Line::to_string)
            .find(|line| line.contains("还有"))
            .expect("hidden count");
        assert!(hidden.contains("还有 6 行"), "{hidden}");
        assert!(hidden.contains("点击展开"), "{hidden}");
    }

    #[test]
    fn diff_add_and_delete_rows_fill_the_content_width() {
        let entry = diff_entry("hello world\n", "hello there\n");
        let rendered = render_one(entry, true, 40);
        let colors = Theme::Dark.colors();
        for line in &rendered.lines {
            let line_bg = line.spans.iter().find_map(|span| span.style.bg);
            if line_bg == Some(colors.diff_add_bg) || line_bg == Some(colors.diff_del_bg) {
                let width = crate::display::line_width(&line.to_string());
                assert_eq!(width, 40, "diff row fills the content width: {line:?}");
                assert_eq!(
                    line.spans.last().and_then(|span| span.style.bg),
                    line_bg,
                    "trailing cells keep the row background"
                );
            }
        }
    }

    #[test]
    fn the_diff_header_puts_a_rule_between_title_and_state() {
        let entry = diff_entry("a\n", "a\nb\n");
        let rendered = render_one(entry, false, 40);
        let lines: Vec<String> = rendered.lines.iter().map(Line::to_string).collect();
        let title = lines
            .iter()
            .position(|line| line.contains("Edit") && line.contains("a.txt"))
            .expect("diff title");
        assert!(
            lines[title + 1]
                .trim()
                .chars()
                .all(|character| character == '─'),
            "rule follows the title: {:?}",
            lines[title + 1]
        );
        assert!(
            lines[title + 2].contains('应'),
            "state follows the rule: {:?}",
            lines[title + 2]
        );
    }

    #[test]
    fn an_oversized_diff_line_reports_the_true_hidden_row_count() {
        let long = "x".repeat(4200);
        let collapsed = render_one(diff_entry("a\n", &format!("a\n{long}")), false, 8);
        let hidden = collapsed
            .lines
            .iter()
            .map(Line::to_string)
            .find(|line| line.contains("还有"))
            .expect("hidden count");
        assert!(hidden.contains("还有 4193 行"), "{hidden}");
        let expanded = render_one(diff_entry("a\n", &format!("a\n{long}")), true, 8);
        let hidden = expanded
            .lines
            .iter()
            .map(Line::to_string)
            .find(|line| line.contains("还有"))
            .expect("expanded cap notice");
        assert!(hidden.contains("超出显示上限"), "{hidden}");
        assert!(hidden.contains("还有 200 行"), "{hidden}");
    }

    #[test]
    fn diff_rows_with_emoji_still_fill_the_content_width() {
        let entry = diff_entry("a\n", "a\n👨‍👩‍👧 x\n");
        let rendered = render_one(entry, true, 40);
        let colors = Theme::Dark.colors();
        let mut checked = false;
        for line in &rendered.lines {
            if line
                .spans
                .iter()
                .any(|span| span.style.bg == Some(colors.diff_add_bg))
            {
                checked = true;
                assert_eq!(
                    crate::display::line_width(&line.to_string()),
                    40,
                    "emoji row fills the content width: {line:?}"
                );
                assert_eq!(
                    line.spans.last().and_then(|span| span.style.bg),
                    Some(colors.diff_add_bg),
                    "trailing cells keep the row background: {line:?}"
                );
            }
        }
        assert!(checked, "the added row was rendered");
    }

    #[test]
    fn diff_rows_have_a_background_and_emphasis_style() {
        let diff = crate::diff::single_text_diff(
            Some("a.txt".into()),
            Some("hello world".into()),
            Some("hello there".into()),
            DiffState::Applied,
        );
        let entry = Entry {
            identity: "call-c".into(),
            fingerprint: 1,
            kind: EntryKind::Tool(ToolRecord {
                call_id: "c".into(),
                name: "edit".into(),
                status: ToolStatus::Succeeded,
                display_status: DisplayStatus::Succeeded,
                turn: None,
                step: None,
                arguments: "{}".into(),
                result: None,
                result_fact: None,
                approval: None,
                display: ToolDisplay::File {
                    path: Some("a.txt".into()),
                    diff: Some(diff),
                },
            }),
        };
        let rendered = render_one(entry, true, 80);
        let backgrounds: Vec<Color> = rendered
            .lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .filter_map(|span| span.style.bg)
            .collect();
        let colors = Theme::Dark.colors();
        assert!(backgrounds.contains(&colors.diff_add_bg));
        assert!(backgrounds.contains(&colors.diff_del_bg));
        assert!(rendered
            .lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .any(|span| span.style.add_modifier.contains(Modifier::BOLD)));
    }

    #[test]
    fn light_theme_uses_light_diff_backgrounds() {
        let diff = crate::diff::single_text_diff(
            Some("a.txt".into()),
            Some("hello world".into()),
            Some("hello there".into()),
            DiffState::Applied,
        );
        let entry = Entry {
            identity: "call-light".into(),
            fingerprint: 1,
            kind: EntryKind::Tool(ToolRecord {
                call_id: "light".into(),
                name: "edit".into(),
                status: ToolStatus::Succeeded,
                display_status: DisplayStatus::Succeeded,
                turn: None,
                step: None,
                arguments: "{}".into(),
                result: None,
                result_fact: None,
                approval: None,
                display: ToolDisplay::File {
                    path: Some("a.txt".into()),
                    diff: Some(diff),
                },
            }),
        };
        let rendered = render_one_with_theme(entry, true, 80, Theme::Light);
        let backgrounds: Vec<Color> = rendered
            .lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .filter_map(|span| span.style.bg)
            .collect();
        let light = Theme::Light.colors();
        let dark = Theme::Dark.colors();
        assert!(backgrounds.contains(&light.diff_add_bg));
        assert!(backgrounds.contains(&light.diff_del_bg));
        assert!(!backgrounds.contains(&dark.diff_add_bg));
        assert!(!backgrounds.contains(&dark.diff_del_bg));
    }

    #[test]
    fn the_render_cache_does_not_mix_theme_colors() {
        let diff = crate::diff::single_text_diff(
            Some("a.txt".into()),
            Some("hello world".into()),
            Some("hello there".into()),
            DiffState::Applied,
        );
        let entry = Entry {
            identity: "call-cache".into(),
            fingerprint: 1,
            kind: EntryKind::Tool(ToolRecord {
                call_id: "cache".into(),
                name: "edit".into(),
                status: ToolStatus::Succeeded,
                display_status: DisplayStatus::Succeeded,
                turn: None,
                step: None,
                arguments: "{}".into(),
                result: None,
                result_fact: None,
                approval: None,
                display: ToolDisplay::File {
                    path: Some("a.txt".into()),
                    diff: Some(diff),
                },
            }),
        };
        let model = model(vec![entry]);
        let mut cache = RenderCache::new();
        let mut dark_scroll = ScrollState::default();
        let dark = render(&model, &mut cache, &mut dark_scroll, 80, 20, Theme::Dark);
        let mut light_scroll = ScrollState::default();
        let light = render(&model, &mut cache, &mut light_scroll, 80, 20, Theme::Light);
        let backgrounds = |rendered: &TranscriptRender| -> Vec<Color> {
            rendered
                .lines
                .iter()
                .flat_map(|line| line.spans.iter())
                .filter_map(|span| span.style.bg)
                .collect()
        };
        assert!(backgrounds(&dark).contains(&Theme::Dark.colors().diff_add_bg));
        assert!(backgrounds(&light).contains(&Theme::Light.colors().diff_add_bg));
        assert!(!backgrounds(&light).contains(&Theme::Dark.colors().diff_add_bg));
    }

    #[test]
    fn a_missing_exit_code_is_shown_as_unconfirmed() {
        let entry = bash_entry(ToolStatus::Succeeded, "hello", DisplayStatus::Unknown);
        let rendered = render_one(entry, false, 80);
        let text: Vec<String> = rendered.lines.iter().map(ToString::to_string).collect();
        assert!(text.iter().any(|line| line.contains("结果未确认")));
        assert!(text.iter().any(|line| line.contains("退出状态未返回")));
        assert!(text
            .iter()
            .any(|line| line.contains("工具未返回成功或失败结论")));
    }

    #[test]
    fn an_explicit_success_hides_missing_exit_warnings() {
        let entry = bash_entry(ToolStatus::Succeeded, "hello", DisplayStatus::Succeeded);
        let rendered = render_one(entry, false, 80);
        let text: Vec<String> = rendered.lines.iter().map(ToString::to_string).collect();
        assert!(text.iter().any(|line| line.contains("完成")));
        assert!(!text.iter().any(|line| line.contains("结果未确认")));
        assert!(!text.iter().any(|line| line.contains("退出状态未返回")));
        assert!(!text
            .iter()
            .any(|line| line.contains("工具未返回成功或失败结论")));
    }

    #[test]
    fn an_explicit_failure_without_an_exit_marker_skips_the_missing_exit_warning() {
        let entry = bash_entry(ToolStatus::Failed, "bad", DisplayStatus::Failed);
        let rendered = render_one(entry, false, 80);
        let text: Vec<String> = rendered.lines.iter().map(ToString::to_string).collect();
        assert!(text.iter().any(|line| line.contains("失败")));
        assert!(!text.iter().any(|line| line.contains("退出状态未返回")));
    }

    #[test]
    fn an_interrupted_call_without_an_exit_marker_skips_the_missing_exit_warning() {
        let entry = bash_entry(ToolStatus::Failed, "stopped", DisplayStatus::Interrupted);
        let rendered = render_one(entry, false, 80);
        let text: Vec<String> = rendered.lines.iter().map(ToString::to_string).collect();
        assert!(text.iter().any(|line| line.contains("已中断")));
        assert!(!text.iter().any(|line| line.contains("退出状态未返回")));
    }

    #[test]
    fn a_failure_summary_is_visible_without_expanding() {
        let entry = bash_entry(
            ToolStatus::Failed,
            "bad\nworse\nworst\nextra",
            DisplayStatus::Failed,
        );
        let rendered = render_one(entry, false, 80);
        assert!(rendered
            .lines
            .iter()
            .any(|line| line.to_string().contains("失败")));
        assert!(rendered
            .lines
            .iter()
            .any(|line| line.to_string().contains("worst")));
    }

    #[test]
    fn expanding_a_block_keeps_the_same_identity_and_click_target() {
        let entry = bash_entry(
            ToolStatus::Succeeded,
            "one\ntwo\nthree",
            DisplayStatus::Unknown,
        );
        let collapsed = render_one(entry.clone(), false, 80);
        let expanded = render_one(entry, true, 80);
        assert!(expanded
            .lines
            .iter()
            .any(|line| line.to_string().contains("one")));
        assert!(!collapsed
            .lines
            .iter()
            .any(|line| line.to_string().contains("one")));
        assert!(expanded
            .hits
            .iter()
            .flatten()
            .any(|hit| hit.kind == HitKind::Toggle));
    }

    #[test]
    fn a_monitor_message_is_labelled_as_a_user_role_monitor_notice() {
        let entry = Entry {
            identity: "seq-monitor".into(),
            fingerprint: 2,
            kind: EntryKind::Context {
                text: "[monitor] job=bash-a matched=1".into(),
                bash: false,
                monitor: true,
            },
        };
        let rendered = render_one(entry, false, 80);
        assert!(rendered
            .lines
            .iter()
            .any(|line| line.to_string().contains("monitor · role=user")));
    }

    #[test]
    fn ordinary_context_starts_collapsed_and_expands_to_its_original_text() {
        let entry = Entry {
            identity: "seq-1".into(),
            fingerprint: 1,
            kind: EntryKind::Context {
                text: "line one\nline two\nline three".into(),
                bash: false,
                monitor: false,
            },
        };
        let collapsed = render_one(entry.clone(), false, 80);
        assert!(collapsed
            .lines
            .iter()
            .any(|line| line.to_string().contains("上下文 · 点击展开")));
        assert!(!collapsed
            .lines
            .iter()
            .any(|line| line.to_string().contains("line one")));
        let expanded = render_one(entry, true, 80);
        assert!(expanded
            .lines
            .iter()
            .any(|line| line.to_string().contains("line one")));
        assert!(expanded
            .lines
            .iter()
            .any(|line| line.to_string().contains("line three")));
    }

    #[test]
    fn consecutive_ordinary_context_entries_merge_into_one_disclosure() {
        let entries = (0..3)
            .map(|index| Entry {
                identity: format!("seq-{index}"),
                fingerprint: index + 1,
                kind: EntryKind::Context {
                    text: format!("segment {index}\nsecond row"),
                    bash: false,
                    monitor: false,
                },
            })
            .collect::<Vec<_>>();
        let model = model(entries);
        let mut cache = RenderCache::new();
        let mut scroll = ScrollState::default();
        let rendered = render(&model, &mut cache, &mut scroll, 80, 20, Theme::Dark);
        let text = rendered
            .lines
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        assert!(text.iter().any(|line| line.contains("上下文 3 段")));
        assert!(!text.iter().any(|line| line.contains("segment 0")));
        assert_eq!(
            rendered
                .lines
                .iter()
                .filter(|line| line.to_string().contains("上下文 3 段"))
                .count(),
            1
        );
        let mut cache = RenderCache::new();
        let mut scroll = ScrollState::default();
        let expanded = render_expanded(&model, &mut cache, &mut scroll, 80, 20);
        for index in 0..3 {
            assert!(expanded
                .iter()
                .any(|line| line.contains(&format!("segment {index}"))));
        }
    }

    fn render_expanded(
        model: &TranscriptModel,
        cache: &mut RenderCache,
        scroll: &mut ScrollState,
        width: usize,
        viewport: usize,
    ) -> Vec<String> {
        let mut model = model.clone();
        let identities = model
            .entries()
            .iter()
            .map(|entry| entry.identity.clone())
            .collect::<Vec<_>>();
        for identity in identities {
            model.reveal(&identity);
        }
        let rendered = render(&model, cache, scroll, width, viewport, Theme::Dark);
        rendered.lines.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn an_assistant_message_with_only_tool_calls_has_no_empty_label() {
        let entry = Entry {
            identity: "a-1".into(),
            fingerprint: 1,
            kind: EntryKind::Assistant {
                text: String::new(),
                reasoning: String::new(),
                reasoning_ms: None,
                interrupted: false,
            },
        };
        let rendered = render_one(entry, false, 80);
        assert!(rendered.lines.is_empty());
    }

    #[test]
    fn every_visible_unit_gets_a_block_gap() {
        for (previous, next) in [
            (Role::Process, Role::Process),
            (Role::Process, Role::Answer),
            (Role::Answer, Role::Process),
            (Role::Turn, Role::Process),
            (Role::Answer, Role::Answer),
        ] {
            assert_eq!(gap_between(previous, next), Gap::Block);
        }
    }

    #[test]
    fn a_tool_then_thinking_separates_each_block() {
        let entries = vec![
            bash_entry(ToolStatus::Succeeded, "ok", DisplayStatus::Succeeded),
            assistant_entry("a-1", "一句话：回答", "先看看"),
        ];
        let rows = render_model_lines(entries, 100);
        let thinking = rows
            .iter()
            .position(|row| row.contains("思考 已完成"))
            .expect("thinking header");
        let answer = rows
            .iter()
            .position(|row| row.contains("一句话：回答"))
            .expect("answer");
        assert_eq!(
            thinking + 2,
            answer,
            "one blank row between thinking and answer: {rows:?}"
        );
        let tool_tail = rows
            .iter()
            .rposition(|row| row.contains("ok"))
            .expect("tool output");
        assert_eq!(
            tool_tail + 2,
            thinking,
            "one blank row between the tool and thinking: {rows:?}"
        );
        assert_eq!(
            rows.last().map(String::as_str),
            Some(""),
            "last unit keeps the bottom gap"
        );
    }

    #[test]
    fn consecutive_tools_get_one_gap() {
        let entries = vec![
            bash_entry_named("call-c-1", "c-1", "one"),
            bash_entry_named("call-c-2", "c-2", "two"),
        ];
        let rows = render_model_lines(entries, 100);
        let first = rows
            .iter()
            .position(|row| row.contains("one"))
            .expect("first output");
        let second = rows
            .iter()
            .enumerate()
            .skip(first + 1)
            .find(|(_, row)| row.contains("▸ Bash"))
            .map(|(index, _)| index)
            .expect("second tool header");
        assert_eq!(first + 2, second, "one blank row between tools: {rows:?}");
    }

    #[test]
    fn preview_spaces_the_answer_but_keeps_its_tail_compact() {
        let entries = vec![preview_entry_with_thinking("流式正文", "先想想")];
        let rows = render_model_lines(entries, 100);
        let thinking = rows
            .iter()
            .position(|row| row.contains("思考 进行中"))
            .expect("preview thinking");
        let text = rows
            .iter()
            .position(|row| row.contains("流式正文"))
            .expect("preview text");
        assert_eq!(thinking + 2, text, "preview answer gets one gap: {rows:?}");
        let tool = rows
            .iter()
            .position(|row| row.contains("参数完成"))
            .expect("preview tool line");
        assert_eq!(
            text + 1,
            tool,
            "preview tool lines stay tight after the text: {rows:?}"
        );
    }

    #[test]
    fn an_empty_assistant_leaves_no_unit_and_no_double_gap() {
        let entries = vec![
            bash_entry(ToolStatus::Succeeded, "ok", DisplayStatus::Succeeded),
            assistant_entry("a-empty", "", ""),
            assistant_entry("a-answer", "答案", ""),
        ];
        let rows = render_model_lines(entries, 100);
        let tool_tail = rows
            .iter()
            .rposition(|row| row.contains("ok"))
            .expect("tool output");
        let answer = rows
            .iter()
            .position(|row| row.contains("答案"))
            .expect("answer");
        assert_eq!(tool_tail + 2, answer, "process to answer: {rows:?}");
        assert!(
            !rows
                .windows(2)
                .any(|pair| pair[0].is_empty() && pair[1].is_empty()),
            "no boundary doubles the gap: {rows:?}"
        );
    }

    #[test]
    fn the_cache_key_separates_gap_roles() {
        let entry = bash_entry(ToolStatus::Succeeded, "ok", DisplayStatus::Succeeded);
        let unit = Unit::Single(&entry);
        let mut cache = RenderCache::new();
        let tight = cache.height(
            unit.identity(),
            unit.fingerprint(),
            80,
            false,
            Theme::Dark,
            Gap::None,
            || render_unit(&unit, 80, false, Theme::Dark, Gap::None),
        );
        let blocked = cache.height(
            unit.identity(),
            unit.fingerprint(),
            80,
            false,
            Theme::Dark,
            Gap::Block,
            || render_unit(&unit, 80, false, Theme::Dark, Gap::Block),
        );
        assert_eq!(blocked, tight + 1);
    }

    #[test]
    fn a_first_unit_has_no_leading_gap() {
        let rows = render_model_lines(vec![assistant_entry("a-1", "开头", "")], 80);
        assert!(
            !rows.first().is_some_and(|row| row.trim().is_empty()),
            "{rows:?}"
        );
    }

    #[test]
    fn a_single_tool_ends_with_one_bottom_gap() {
        let rows = render_model_lines(
            vec![bash_entry(
                ToolStatus::Succeeded,
                "ok",
                DisplayStatus::Succeeded,
            )],
            80,
        );
        assert_eq!(rows.last().map(String::as_str), Some(""));
        assert!(
            rows.iter()
                .rev()
                .nth(1)
                .is_some_and(|row| !row.trim().is_empty()),
            "{rows:?}"
        );
    }

    #[test]
    fn a_context_group_separator_has_no_hit() {
        let mut model = model(vec![
            context_entry("ctx-a", "第一段"),
            context_entry("ctx-b", "第二段"),
        ]);
        model.reveal("ctx-a");
        let mut cache = RenderCache::new();
        let mut scroll = ScrollState::default();
        let rendered = render(&model, &mut cache, &mut scroll, 80, 40, Theme::Dark);
        let first = rendered
            .lines
            .iter()
            .position(|line| line.to_string().contains("第一段"))
            .expect("first context row");
        let second = rendered
            .lines
            .iter()
            .position(|line| line.to_string().contains("第二段"))
            .expect("second context row");
        assert_eq!(
            second,
            first + 2,
            "one separator row: {:?}",
            rendered
                .lines
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        );
        assert!(rendered.hits[first].is_some());
        assert!(rendered.hits[first + 1].is_none());
        assert!(rendered.hits[second].is_some());
    }

    #[test]
    fn a_preview_leading_newline_does_not_double_the_gap() {
        let entries = vec![preview_entry_with_thinking("\n\n流式正文", "先想想")];
        let rows = render_model_lines(entries, 80);
        assert!(
            !rows
                .windows(2)
                .any(|pair| pair[0].is_empty() && pair[1].is_empty()),
            "{rows:?}"
        );
        let text = rows
            .iter()
            .position(|row| row.contains("流式正文"))
            .expect("preview text");
        assert!(rows[text - 1].is_empty());
        assert!(
            !rows[text - 2].is_empty(),
            "only one gap before the text: {rows:?}"
        );
    }

    #[test]
    fn an_empty_assistant_keeps_contexts_as_separate_groups() {
        let rows = render_model_lines(
            vec![
                context_entry("ctx-a", "第一段"),
                assistant_entry("a-empty", "", ""),
                context_entry("ctx-b", "第二段"),
            ],
            80,
        );
        let headers = rows.iter().filter(|row| row.contains("上下文")).count();
        assert_eq!(
            headers, 2,
            "the empty assistant remains a barrier: {rows:?}"
        );
    }

    #[test]
    fn a_pending_approval_is_not_labeled_as_unknown() {
        let entry = Entry {
            identity: "call-c".into(),
            fingerprint: 1,
            kind: EntryKind::Tool(ToolRecord {
                call_id: "c".into(),
                name: "write".into(),
                status: ToolStatus::Pending,
                display_status: DisplayStatus::Pending,
                turn: None,
                step: None,
                arguments: "{}".into(),
                result: None,
                result_fact: None,
                approval: Some(crate::tool::ApprovalView {
                    tool_name: "write".into(),
                    reason: Some("sandbox".into()),
                    display_reason: Default::default(),
                    outcome: None,
                    asked: true,
                    pending: true,
                }),
                display: ToolDisplay::Generic,
            }),
        };
        let rendered = render_one(entry, false, 80);
        assert!(rendered
            .lines
            .iter()
            .any(|line| line.to_string().contains("审批中")));
        assert!(!rendered
            .lines
            .iter()
            .any(|line| line.to_string().contains("结果未确认")));
    }

    #[test]
    fn a_user_message_uses_a_prompt_prefix_instead_of_a_label_row() {
        let entry = Entry {
            identity: "m-1".into(),
            fingerprint: 1,
            kind: EntryKind::User {
                text: "你好世界".into(),
            },
        };
        let rendered = render_one(entry, false, 80);
        assert_eq!(rendered.lines[0].to_string(), "> 你好世界");
        assert!(rendered.lines[0]
            .spans
            .iter()
            .all(|span| span.style.add_modifier.contains(Modifier::BOLD)));
        assert!(!rendered
            .lines
            .iter()
            .any(|line| line.to_string().trim() == "你"));
    }

    #[test]
    fn assistant_markdown_strips_markers_and_styles_lead_heading_and_list() {
        let entry = Entry {
            identity: "a-1".into(),
            fingerprint: 1,
            kind: EntryKind::Assistant {
                text: "# 改动\n完成 **两处** 修改。\n\n- 第一项\n- 第二项".into(),
                reasoning: String::new(),
                reasoning_ms: None,
                interrupted: false,
            },
        };
        let rendered = render_one(entry, false, 40);
        let rows = rendered
            .lines
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        assert!(rows.iter().any(|row| row == "改动"));
        assert!(!rows.iter().any(|row| row.contains('#')));
        assert!(!rows.iter().any(|row| row.contains("**")));
        let bold = rendered
            .lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .find(|span| span.content.contains("两处"))
            .expect("inline bold run");
        assert!(bold.style.add_modifier.contains(Modifier::BOLD));
        assert!(rendered
            .lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .any(|span| span.content.contains("改动")
                && span.style.add_modifier.contains(Modifier::BOLD)));
        assert!(rows.iter().any(|row| row.starts_with("- 第一项")));
    }

    fn table_entry(text: &str) -> Entry {
        Entry {
            identity: "table-1".into(),
            fingerprint: 1,
            kind: EntryKind::Assistant {
                text: text.into(),
                reasoning: String::new(),
                reasoning_ms: None,
                interrupted: false,
            },
        }
    }

    #[test]
    fn a_markdown_table_keeps_columns_alignment_and_header_emphasis() {
        let entry =
            table_entry("| 名称 | 状态 |\n| :--- | ---: |\n| 好 | 完成 |\n| 很长的单元格 | 失败 |");
        let rendered = render_one(entry, false, 100);
        let rows: Vec<String> = rendered.lines.iter().map(ToString::to_string).collect();
        assert!(!rows.iter().any(|row| row.contains('|')), "{rows:?}");
        assert!(
            rows.iter()
                .any(|row| row.trim_matches('─').is_empty() && row.contains('─')),
            "header separator rule: {rows:?}"
        );
        for row in &rows {
            assert!(line_width(row) <= 100, "no overflow: {row:?}");
        }
        let header = rendered
            .lines
            .iter()
            .find(|line| line.to_string().contains("名称"))
            .expect("header row");
        assert!(header.spans.iter().any(|span| span.content.contains("名称")
            && span.style.add_modifier.contains(Modifier::BOLD)));
        let completed = rendered
            .lines
            .iter()
            .find(|line| line.to_string().contains("完成"))
            .expect("body row");
        assert!(
            completed.to_string().ends_with("完成"),
            "right-aligned last column: {completed:?}"
        );
    }

    #[test]
    fn a_markdown_table_preserves_escaped_pipes_and_cjk_wrapping() {
        let entry = table_entry(
            "| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n| 中文内容很长很长 | a \\| b | 短 |",
        );
        let rendered = render_one(entry, false, 60);
        let rows: Vec<String> = rendered.lines.iter().map(ToString::to_string).collect();
        for row in &rows {
            assert!(line_width(row) <= 60, "no horizontal overflow: {row:?}");
        }
        let escaped = rendered
            .lines
            .iter()
            .find(|line| line.to_string().contains("a | b"))
            .expect("escaped pipe stays in one cell");
        assert_eq!(escaped.to_string().matches('│').count(), 2);
        for line in &rendered.lines {
            let row = line.to_string();
            if row.contains('│') {
                assert_eq!(row.matches('│').count(), 2, "columns keep: {row:?}");
            }
        }
    }

    #[test]
    fn a_wide_table_compresses_to_sixty_columns_without_losing_labels() {
        let entry = table_entry(
            "| 名称很长很长很长很长 | 状态说明文字 | 说明很长很长很长很长 | 备注很长很长很长很长 |\n| --- | --- | --- | --- |\n| 内容很长很长很长很长 | 完成 | 更多说明很长很长很长很长 | 无 |",
        );
        let rendered = render_one(entry, false, 60);
        let rows: Vec<String> = rendered.lines.iter().map(ToString::to_string).collect();
        for row in &rows {
            assert!(line_width(row) <= 60, "no horizontal overflow: {row:?}");
        }
        let table_text = rows.join("");
        for label in ["名", "称", "状", "态", "说", "明", "备", "注"] {
            assert!(table_text.contains(label), "header keeps {label}: {rows:?}");
        }
        assert!(
            rows.iter()
                .filter(|row| row.contains('│'))
                .all(|row| row.matches('│').count() == 3),
            "four columns keep three separators: {rows:?}"
        );
    }

    #[test]
    fn a_table_keeps_empty_cells_wide_glyphs_and_column_alignment() {
        let entry = table_entry(
            "| left | center | right |\n| :--- | :---: | ---: |\n| a | bb | ccc |\n|  | 🚀 |  |",
        );
        let rendered = render_one(entry, false, 40);
        let rows: Vec<String> = rendered.lines.iter().map(ToString::to_string).collect();
        for row in &rows {
            assert!(line_width(row) <= 40, "no overflow: {row:?}");
        }
        let rocket = rendered
            .lines
            .iter()
            .find(|line| line.to_string().contains("🚀"))
            .expect("emoji row");
        assert_eq!(rocket.to_string().matches('│').count(), 2);
        let body = rendered
            .lines
            .iter()
            .find(|line| line.to_string().contains("bb"))
            .expect("center row");
        let text = body.to_string();
        assert!(text.starts_with("a"), "{text:?}");
        assert!(text.ends_with("ccc"), "right alignment: {text:?}");
        let center = text.split('│').nth(1).expect("center cell");
        let stripped = center.trim();
        assert_eq!(stripped, "bb");
        let start = center.find(stripped).expect("content offset");
        let left = center[..start].chars().count();
        let right = center[start + stripped.len()..].chars().count();
        assert!(
            left.abs_diff(right) <= 1,
            "centered cell: {center:?} ({left}/{right})"
        );
    }

    #[test]
    fn a_pipe_line_without_a_separator_stays_plain_text() {
        let rows = plain(&render_one(table_entry("a | b\njust text"), false, 40));
        assert!(rows.iter().any(|row| row.contains("a | b")), "{rows:?}");
        assert!(!rows.iter().any(|row| row.contains('│')));
    }

    #[test]
    fn a_table_keeps_one_blank_line_from_surrounding_paragraphs() {
        let rows = plain(&render_one(
            table_entry("前文\n| A | B |\n| --- | --- |\n| 1 | 2 |\n后文"),
            false,
            40,
        ));
        let before = rows
            .iter()
            .position(|row| row.contains("前文"))
            .expect("lead");
        let header = rows
            .iter()
            .position(|row| row.contains('A') && row.contains('B'))
            .expect("header");
        let after = rows
            .iter()
            .position(|row| row.contains("后文"))
            .expect("tail");
        assert_eq!(header, before + 2, "{rows:?}");
        assert_eq!(after, header + 4, "{rows:?}");
        assert!(rows[before + 1].trim().is_empty());
        assert!(rows[after - 1].trim().is_empty());
    }

    #[test]
    fn markdown_semantic_blocks_keep_one_blank_line() {
        let rows = plain(&render_one(
            table_entry("# 标题\n正文\n- 项目\n- 第二项"),
            false,
            40,
        ));
        assert_eq!(rows[0], "标题", "{rows:?}");
        assert!(rows[1].trim().is_empty(), "{rows:?}");
        assert_eq!(rows[2], "正文", "{rows:?}");
        assert!(rows[3].trim().is_empty(), "{rows:?}");
        assert!(rows[4].starts_with("- 项目"), "{rows:?}");
        assert!(
            rows[5].starts_with("- 第二项"),
            "list items stay tight: {rows:?}"
        );
        assert!(
            rows.last().is_some_and(|row| row.starts_with("- 第二项")),
            "an entry no longer carries its own trailing gap: {rows:?}"
        );
    }

    #[test]
    fn a_heading_or_list_line_with_pipes_is_not_a_table_header() {
        for text in [
            "- 项 | 说明\n--- | ---\n- a | b",
            "# 标题 | x\n--- | ---\n| 1 | 2 |",
        ] {
            let rows = plain(&render_one(table_entry(text), false, 40));
            assert!(
                !rows.iter().any(|row| row.contains('│')),
                "no table for {text:?}: {rows:?}"
            );
        }
    }

    #[test]
    fn a_paragraph_after_a_lead_table_is_not_bold() {
        let rendered = render_one(
            table_entry("前言\n| A | B |\n| --- | --- |\n| 1 | 2 |\n结论段落"),
            false,
            40,
        );
        let paragraph = rendered
            .lines
            .iter()
            .find(|line| line.to_string().contains("结论段落"))
            .expect("paragraph");
        assert!(
            !paragraph
                .spans
                .iter()
                .any(|span| span.style.add_modifier.contains(Modifier::BOLD)),
            "{paragraph:?}"
        );
    }

    #[test]
    fn a_table_cell_keeps_inline_bold() {
        let rendered = render_one(
            table_entry("| 名称 | 值 |\n| --- | --- |\n| **重要** | 好 |"),
            false,
            60,
        );
        let bold_row = rendered
            .lines
            .iter()
            .find(|line| line.to_string().contains("重要"))
            .expect("cell row");
        assert_eq!(bold_row.to_string().matches('│').count(), 1);
        assert!(bold_row
            .spans
            .iter()
            .any(|span| span.content.contains("重要")
                && span.style.add_modifier.contains(Modifier::BOLD)));
        assert!(!rendered
            .lines
            .iter()
            .any(|line| line.to_string().contains("**")));
    }

    #[test]
    fn tool_rows_keep_the_status_on_the_right_edge() {
        let entry = bash_entry(ToolStatus::Succeeded, "hello", DisplayStatus::Succeeded);
        let rendered = render_one(entry, false, 40);
        let header = rendered.lines[0].to_string();
        assert!(header.starts_with("▸ Bash "));
        assert!(header.ends_with("完成"));
        assert_eq!(crate::display::line_width(&header), 40);
    }

    #[test]
    fn an_echo_state_suffix_is_never_clipped() {
        let entry = Entry {
            identity: "echo-1".into(),
            fingerprint: 1,
            kind: EntryKind::Echo {
                text: "x".repeat(18),
                state: "已发送".into(),
            },
        };
        let rendered = render_one(entry, false, 10);
        assert!(rendered
            .lines
            .iter()
            .any(|line| line.to_string().contains("（已发送）")));
        assert!(rendered
            .lines
            .iter()
            .all(|line| crate::display::line_width(&line.to_string()) <= 10));
    }

    #[test]
    fn a_non_error_notice_stays_muted() {
        let entry = Entry {
            identity: "n-1".into(),
            fingerprint: 1,
            kind: EntryKind::Notice {
                text: "回合已取消".into(),
                is_error: false,
            },
        };
        let rendered = render_one(entry, false, 80);
        let styles = rendered
            .lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.style.fg)
            .collect::<Vec<_>>();
        let colors = Theme::Dark.colors();
        assert!(styles.contains(&Some(colors.muted)));
        assert!(!styles.contains(&Some(colors.warning)));
    }

    #[test]
    fn a_settled_question_row_opens_the_recorded_answers() {
        let questions = parse_questions(Some(&serde_json::json!([
            {"id": "q", "question": "Q", "options": [{"label": "A"}]}
        ])));
        let record = QuestionRecord {
            questions,
            timed: false,
            state: RecordedQuestionState::Settled,
            answers: vec![nano_decisions::contract::AnswerItem {
                id: "q".into(),
                selected: vec!["A".into()],
                custom: None,
            }],
        };
        let entry = Entry {
            identity: "call-c".into(),
            fingerprint: 1,
            kind: EntryKind::Tool(ToolRecord {
                call_id: "c".into(),
                name: "ask_user_question".into(),
                status: ToolStatus::Succeeded,
                display_status: DisplayStatus::Succeeded,
                turn: None,
                step: None,
                arguments: "{}".into(),
                result: None,
                result_fact: None,
                approval: None,
                display: ToolDisplay::AskUser { record },
            }),
        };
        let rendered = render_one(entry, false, 80);
        assert!(rendered.hits.iter().flatten().any(|hit| matches!(
            &hit.kind,
            HitKind::OpenQuestion { call_id } if call_id == "c"
        )));
    }

    fn preview_entry(gap: bool, truncated: bool) -> Entry {
        Entry {
            identity: "preview-a".into(),
            fingerprint: 1,
            kind: EntryKind::Preview(PreviewEntry {
                attempt_id: "a".into(),
                turn: 1,
                step: 1,
                text: "hello".into(),
                reasoning: String::new(),
                reasoning_ms: None,
                tools: Vec::new(),
                gap,
                truncated,
                finished: false,
                outcome: None,
            }),
        }
    }

    fn finished_preview(outcome: PreviewOutcome) -> Entry {
        let mut entry = preview_entry(false, false);
        let EntryKind::Preview(preview) = &mut entry.kind else {
            unreachable!("preview entry");
        };
        preview.finished = true;
        preview.outcome = Some(outcome);
        entry
    }

    fn plain(rendered: &RenderedEntry) -> Vec<String> {
        rendered
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect()
    }

    #[test]
    fn a_live_preview_shows_a_stable_generating_status_and_one_partial_warning() {
        let rendered = render_one(preview_entry(true, true), false, 60);
        let rows = plain(&rendered);
        assert!(rows.iter().any(|row| row.contains("生成中")), "{rows:?}");
        assert_eq!(
            rows.iter()
                .filter(|row| row.contains("当前只显示部分生成内容，最终回答到达后会补全"))
                .count(),
            1,
            "{rows:?}"
        );
        assert!(rows.iter().all(|row| {
            !row.contains("preview")
                && !row.contains("gap")
                && !row.contains("revision")
                && !row.contains("attempt")
        }));
        assert!(rows
            .iter()
            .all(|row| row.chars().map(char_width).sum::<usize>() <= 60));
        let note = rendered
            .lines
            .iter()
            .find(|line| line.to_string().contains("当前只显示部分生成内容"))
            .expect("partial note");
        assert!(note
            .spans
            .iter()
            .all(|span| span.style.fg == Some(Theme::Dark.colors().muted)));
    }

    #[test]
    fn a_live_preview_without_gaps_has_no_partial_warning() {
        let rows = plain(&render_one(preview_entry(false, false), false, 60));
        assert!(rows.iter().any(|row| row.contains("生成中")));
        assert!(!rows.iter().any(|row| row.contains("只显示部分生成内容")));
    }

    #[test]
    fn a_finished_preview_without_a_conclusion_keeps_its_fragments() {
        let rows = plain(&render_one(
            finished_preview(PreviewOutcome::Unknown),
            false,
            60,
        ));
        assert!(
            rows.iter().any(|row| row.contains("未收到完整回答")),
            "{rows:?}"
        );
        assert!(rows.iter().any(|row| row.contains("hello")));
        assert!(!rows.iter().any(|row| row.contains("生成中")));
        assert!(!rows.iter().any(|row| row.contains("最终回答到达后会补全")));
        assert!(!rows.iter().any(|row| row.contains("preview")));
    }

    #[test]
    fn a_finished_stream_without_an_outcome_still_reads_as_generating() {
        let mut entry = preview_entry(false, false);
        let EntryKind::Preview(preview) = &mut entry.kind else {
            unreachable!("preview entry");
        };
        preview.finished = true;
        preview.outcome = None;
        let rows = plain(&render_one(entry, false, 60));
        assert!(rows.iter().any(|row| row.contains("生成中")), "{rows:?}");
        assert!(!rows.iter().any(|row| row.contains("未收到完整回答")));
    }

    #[test]
    fn a_finished_preview_uses_the_official_outcome() {
        for (outcome, expected) in [
            (PreviewOutcome::Committed, "回答已提交"),
            (PreviewOutcome::Abandoned, "生成已中断"),
        ] {
            let rows = plain(&render_one(finished_preview(outcome), false, 60));
            assert!(
                rows.iter().any(|row| row.contains(expected)),
                "{outcome:?}: {rows:?}"
            );
            assert!(rows.iter().any(|row| row.contains("hello")));
        }
    }
}
