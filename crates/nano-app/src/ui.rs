//! Rendering and display-cell wrapping.
//!
//! S03 owns the styled transcript. This view is deliberately a plain feed plus
//! the input, queue, and status surfaces S02 owns, so the conversation host can
//! be exercised in a real terminal before the reading layer exists.

use std::time::Instant;

use nano_attachments::{AttachmentState, CandidateKind};
use nano_controls::{PanelAction, PanelMode, PanelRow};
use nano_decisions::{
    ApprovalCardState, ApprovalFocus, DecisionClick, DecisionTop, PlanFocus, QuestionCard,
    QuestionCardState,
};
use nano_jobs::{BashRecord, BashState, JobStatus};
use nano_schedule::RowKind;
use nano_sessions::{format_clock, Occupancy};
use nano_subagents::{ComposerGate, Lamp};
use nano_theme::spacing;
use nano_theme::Theme;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;

use crate::app::{ActivityKind, App, Connection};
use unicode_width::UnicodeWidthChar;

/// Draw one frame.
pub fn draw(frame: &mut Frame, app: &mut App) {
    let full = frame.area();
    frame.buffer_mut().set_style(full, app.theme.base_style());
    draw_frame(frame, app);
    // Wide-glyph continuation cells and any cleared region fall back to the
    // theme foreground so no self-drawn cell is left on the terminal default.
    let fg = app.theme.colors().fg;
    let buffer = frame.buffer_mut();
    for y in full.top()..full.bottom() {
        for x in full.left()..full.right() {
            if let Some(cell) = buffer.cell_mut((x, y)) {
                if cell.fg == Color::Reset {
                    cell.set_fg(fg);
                }
            }
        }
    }
}

fn draw_frame(frame: &mut Frame, app: &mut App) {
    let full = frame.area();
    app.send_area = Rect::default();
    app.jump_area = Rect::default();
    if app.terminal_active() {
        draw_terminal(frame, app, full);
        return;
    }
    // The conversation surfaces keep 2 terminal cells of breathing room on
    // both sides; the interactive terminal keeps its full grid.
    let area = inset_horizontal(full, spacing::EDGE as u16);
    if app.schedule.open {
        draw_schedule(frame, app, full);
        return;
    }
    let child_active = app.subagent_active();
    // `/model` owns the bottom band while it is open: the input, status, dock,
    // queue and activity rows make room for the anchored control layer.
    let models_panel = app.panel.is_open() && matches!(app.panel.mode(), PanelMode::Models);
    if models_panel {
        let rows = app.panel.rows(&app.controls).len();
        app.panel.clamp(rows);
    }
    let queue_height = if models_panel || child_active || app.model.inbox().is_empty() {
        0
    } else {
        (app.model.inbox().len().min(4) as u16) + 1
    };
    // Root decision cards belong to the parent conversation and never take the
    // child composer seat.
    let decision = !models_panel && !child_active && app.decision_owns_seat();
    let completion_height = if !decision && !child_active && app.picker.is_none() {
        if app.command_completion.visible() {
            (app.command_completion.candidates().len().min(6) as u16) + 1
        } else if app.completion.visible() {
            (app.completion.candidates().len().min(6) as u16) + 1
        } else {
            0
        }
    } else {
        0
    };
    let (dock_rows, dock_overflow) = if child_active {
        (Vec::new(), 0)
    } else {
        app.subagents.dock()
    };
    let dock_height = if dock_rows.is_empty() && dock_overflow == 0 {
        0
    } else {
        (dock_rows.len() + usize::from(dock_overflow > 0)) as u16 + spacing::CHROME_GAP as u16
    };
    // The header reserves one blank row beneath the title, matching the
    // design's one-line gap before the transcript.
    let header_gap = spacing::CHROME_GAP as u16;
    let header_height = if child_active {
        2 + header_gap
    } else {
        1 + header_gap
    };
    let activity_height = if models_panel {
        0
    } else {
        u16::from(app.activity_kind().is_some())
    };
    // One blank row between the composer and the status bar keeps the bottom
    // band readable; short terminals tighten this separator first. The feed
    // keeps its three-row minimum, so the separator appears only when the
    // actual remaining height allows it.
    let reserved = header_height + 3 + queue_height + completion_height + activity_height;
    let models_height = if models_panel {
        models_panel_height(app, area.height.saturating_sub(reserved))
    } else {
        0
    };
    let status_height = u16::from(!models_panel);
    let dock_height = if models_panel { 0 } else { dock_height };
    let bottom_height = if models_panel {
        models_height
    } else if decision {
        decision_height(app, area.width, area.height)
    } else {
        input_height(app, area.width)
    };
    // Ordinary state: activity sits above the composer. Decision state: the
    // card takes the seat first, then the activity row, then the status bar.
    let (activity_slot, bottom_slot) = if decision && !models_panel {
        (bottom_height, activity_height)
    } else {
        (activity_height, bottom_height)
    };
    let fixed = header_height
        + queue_height
        + completion_height
        + activity_height
        + bottom_height
        + status_height
        + dock_height;
    let free = area.height.saturating_sub(fixed);
    let (bottom_gap, dock_gap) = if models_panel {
        (0, 0)
    } else {
        bottom_gaps(free, dock_height > 0)
    };
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(header_height),
            Constraint::Min(3),
            Constraint::Length(queue_height),
            Constraint::Length(completion_height),
            Constraint::Length(activity_slot),
            Constraint::Length(bottom_slot),
            Constraint::Length(bottom_gap),
            Constraint::Length(status_height),
            Constraint::Length(dock_gap),
            Constraint::Length(dock_height),
        ])
        .split(area);

    draw_header(frame, app, layout[0]);
    app.subagent_dock_area = Rect::default();
    app.subagent_dock_hits.clear();
    if app.sources_visible {
        draw_sources_panel(frame, app, layout[1]);
    } else if app.sessions_panel.open {
        draw_sessions(frame, app, layout[1]);
    } else if app.subagents.nav().list_open {
        draw_subagent_list(frame, app, layout[1]);
    } else if app.jobs_open {
        draw_jobs(frame, app, layout[1]);
    } else if app.skills_panel_open() {
        draw_skills_panel(frame, app, layout[1]);
    } else if app.instructions_panel_open() {
        draw_instructions_panel(frame, app, layout[1]);
    } else {
        draw_feed(frame, app, layout[1]);
    }
    if queue_height > 0 {
        draw_queue(frame, app, layout[2]);
    }
    if completion_height > 0 {
        draw_completion(frame, app, layout[3]);
    }
    if decision && !models_panel {
        draw_decision(frame, app, layout[4]);
        draw_activity(frame, app, layout[5]);
    } else {
        app.decision_area = Rect::default();
        app.decision_hits.clear();
        draw_activity(frame, app, layout[4]);
        if models_panel {
            draw_models_panel(frame, app, layout[5]);
        } else {
            draw_input(frame, app, layout[5]);
        }
    }
    if status_height > 0 {
        draw_status(frame, app, layout[7], area.width);
    }
    if dock_height > 0 {
        draw_subagent_dock(frame, app, layout[9]);
    }
    if app.panel.is_open() && !models_panel {
        draw_panel(frame, app, full);
    }
}

/// Separator rows for composer→status and status→dock, never taking the
/// transcript below its three-row minimum.
fn bottom_gaps(free: u16, dock: bool) -> (u16, u16) {
    let gap = spacing::CHROME_GAP as u16;
    let bottom = if free > 3 { gap } else { 0 };
    let remaining = free.saturating_sub(bottom);
    let dock_gap = if dock && remaining > 3 { gap } else { 0 };
    (bottom, dock_gap)
}

fn inset_horizontal(area: Rect, margin: u16) -> Rect {
    let margin = margin.min(area.width / 2);
    Rect {
        x: area.x.saturating_add(margin),
        y: area.y,
        width: area.width.saturating_sub(margin.saturating_mul(2)),
        height: area.height,
    }
}

fn draw_terminal(frame: &mut Frame, app: &mut App, area: Rect) {
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(area);
    app.terminal_screen_area = layout[0];
    let status = match app.terminal.as_mut() {
        Some(terminal) => {
            terminal.draw(frame, layout[0], app.theme);
            terminal.status_line()
        }
        None => {
            frame.render_widget(
                Paragraph::new("终端状态文件不可用；未附着官方终端。")
                    .style(Style::default().fg(app.theme.colors().error)),
                layout[0],
            );
            "终端不可用".to_string()
        }
    };
    let color = if app
        .terminal
        .as_ref()
        .and_then(|terminal| terminal.error())
        .is_some()
    {
        app.theme.colors().error
    } else {
        app.theme.colors().muted
    };
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            truncate(&status, area.width.max(1) as usize),
            Style::default().fg(color),
        ))),
        layout[1],
    );
}

fn draw_header(frame: &mut Frame, app: &mut App, area: Rect) {
    app.subagent_exit_area = Rect::default();
    let title = Rect {
        height: area.height.min(1),
        ..area
    };
    draw_app_title(frame, app, title);
    let Some(mounted) = app.subagents.mounted() else {
        return;
    };
    if area.height < 2 {
        return;
    }
    let gate = app
        .subagents
        .mounted_gate()
        .unwrap_or(ComposerGate::Resolving);
    let (state, color) = match gate {
        ComposerGate::Enabled => ("可输入", app.theme.colors().success),
        ComposerGate::ReadOnly => ("只读", app.theme.colors().muted),
        ComposerGate::StopOnly => ("仅停止", app.theme.colors().warning),
        ComposerGate::Resolving => ("读取历史中", app.theme.colors().accent),
        ComposerGate::NotNavigable => ("不可进入", app.theme.colors().muted),
    };
    // The second row keeps the main title above and adds the child identity:
    // `← 子代理 <task> <state>`.
    let state_width = state.chars().map(display_width).sum::<usize>();
    let label_room = (area.width as usize)
        .saturating_sub(2 + 7 + 1 + state_width)
        .max(1);
    let label = truncate(&safe_text(&mounted.label), label_room);
    let row = Rect {
        y: area.y.saturating_add(1),
        height: 1,
        ..area
    };
    let spans = vec![
        Span::styled("← ", Style::default().fg(app.theme.colors().accent)),
        Span::styled("子代理 ", Style::default().fg(app.theme.colors().muted)),
        Span::styled(label, Style::default().add_modifier(Modifier::BOLD)),
        Span::styled(format!(" {state}"), Style::default().fg(color)),
    ];
    frame.render_widget(Paragraph::new(Line::from(spans)), row);
    app.subagent_exit_area = Rect::new(area.x, row.y, 2.min(area.width), 1);
}

fn draw_app_title(frame: &mut Frame, app: &App, area: Rect) {
    let path = safe_text(&app.display_path());
    let room = (area.width as usize).saturating_sub(6).max(1);
    let spans = vec![
        Span::styled("nano", Style::default().add_modifier(Modifier::BOLD)),
        Span::raw("  "),
        Span::styled(
            elide_left(&path, room),
            Style::default().fg(app.theme.colors().muted),
        ),
    ];
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn draw_schedule(frame: &mut Frame, app: &mut App, area: Rect) {
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(3),
            Constraint::Length(1),
        ])
        .split(area);
    draw_header(frame, app, layout[0]);
    draw_schedule_body(frame, app, layout[1]);
    draw_status(frame, app, layout[2], area.width);
}

fn draw_schedule_body(frame: &mut Frame, app: &App, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(app.theme.border_style())
        .title(" 定时任务 · 官方 schedule ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let width = inner.width.max(1) as usize;
    let rows = app.schedule.rows();
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut selected_line = None;
    for row in rows {
        if row.kind == RowKind::Selected && selected_line.is_none() {
            selected_line = Some(lines.len());
        }
        let style = schedule_style(row.kind, app.theme);
        for segment in wrap_segments(&row.text, width) {
            lines.push(Line::from(Span::styled(segment.text, style)));
        }
    }
    let viewport = inner.height as usize;
    let offset = selected_line
        .map(|start| start.saturating_sub(viewport.saturating_sub(1)))
        .unwrap_or(0);
    frame.render_widget(
        Paragraph::new(Text::from(lines)).scroll((offset.min(u16::MAX as usize) as u16, 0)),
        inner,
    );
}

fn schedule_style(kind: RowKind, theme: Theme) -> Style {
    let colors = theme.colors();
    match kind {
        RowKind::Title => Style::default()
            .fg(colors.accent)
            .add_modifier(Modifier::BOLD),
        RowKind::Plain => Style::default(),
        RowKind::Dim => Style::default().fg(colors.muted),
        RowKind::Error => Style::default().fg(colors.error),
        RowKind::Selected => Style::default().fg(colors.fg).bg(colors.selected_bg),
        RowKind::SelectedDim => Style::default().fg(colors.muted).bg(colors.selected_bg),
        RowKind::Notice => Style::default().fg(colors.warning),
    }
}

/// Session panel: the official list plus context provenance and the last
/// compaction outcome. Every number is labelled with its source; occupancy is
/// never shown as exact usage.
fn draw_sessions(frame: &mut Frame, app: &App, area: Rect) {
    let title = match &app.sessions_panel.rename {
        Some(_) => " 会话 · 输入新标题 · Enter 应用，Esc 取消 ".to_string(),
        None if app.compact_in_flight || app.compact_maybe_running => {
            " 会话 · ↑↓ 选择 · Enter 切换 · n 改名 · c 压缩 · r 刷新 · Esc 取消压缩等待 "
                .to_string()
        }
        None => " 会话 · ↑↓ 选择 · Enter 切换 · n 改名 · c 压缩 · r 刷新 · Esc 关闭 ".to_string(),
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(app.theme.border_style())
        .title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let mut rows: Vec<Line<'static>> = Vec::new();
    if app.sessions_panel.loading {
        rows.push(Line::from(Span::styled(
            "正在读取官方会话列表…",
            Style::default().fg(app.theme.colors().muted),
        )));
    }
    if let Some(error) = &app.sessions_panel.error {
        rows.push(Line::from(Span::styled(
            error.clone(),
            Style::default().fg(app.theme.colors().error),
        )));
    }
    let prefix_rows = rows.len();
    let host_cwd = app.hello.as_ref().map(|hello| hello.cwd.as_str());
    push_session_row(
        &mut rows,
        app.sessions_panel.selected == 0,
        "＋ 新建会话（Nano 生成新 ID）".to_string(),
        app.theme,
    );
    for (index, row) in app.sessions_panel.rows.iter().enumerate() {
        let activity = row
            .updated_at
            .map(short_clock)
            .unwrap_or_else(|| "最近活动未知".to_string());
        let state = row.state_label();
        let id: String = row.session_id.chars().take(8).collect();
        let mut line = format!("{} · {} · {}", row.display_title(), activity, id);
        if !state.is_empty() {
            line.push_str(&format!(" · {state}"));
        }
        if row.blank == Some(true) {
            line.push_str(" · 空白");
        }
        if !row.switchable() {
            line.push_str(" · 子代理（不可作主会话）");
        } else if let (Some(host), Some(recorded)) = (host_cwd, row.cwd.as_deref()) {
            if host != recorded {
                let name = std::path::Path::new(recorded)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(recorded);
                line.push_str(&format!(" · 目录 {name}（不可切换）"));
            }
        }
        push_session_row(
            &mut rows,
            app.sessions_panel.selected == index + 1,
            line,
            app.theme,
        );
    }
    if let Some(rename) = &app.sessions_panel.rename {
        rows.push(Line::from(Span::styled(
            format!("新标题：{}", rename.buffer.text()),
            Style::default().fg(app.theme.colors().accent),
        )));
    }
    let mut footer: Vec<Line<'static>> = vec![Line::from("")];
    push_context_details(&mut footer, app);
    if let Some(compact) = &app.compact {
        footer.push(Line::from(Span::styled(
            format!("压缩：{}", compact.display_text()),
            Style::default().fg(if compact.kind == nano_sessions::CompactionKind::Success {
                app.theme.colors().success
            } else {
                app.theme.colors().warning
            }),
        )));
    }
    if app.compact_in_flight {
        footer.push(Line::from(Span::styled(
            "压缩：等待官方结果…（Esc 取消等待，历史以后端为准）",
            Style::default().fg(app.theme.colors().warning),
        )));
    } else if app.compact_maybe_running {
        footer.push(Line::from(Span::styled(
            "压缩：结果未知，可能仍在运行；Esc 取消等待并重读官方状态",
            Style::default().fg(app.theme.colors().warning),
        )));
    }
    if app.switch.state().failed() {
        footer.push(Line::from(Span::styled(
            format!(
                "{}；Alt+R 重试 / Alt+B 返回上一会话",
                app.switch.state().label()
            ),
            Style::default().fg(app.theme.colors().error),
        )));
    } else if app.switch.busy() {
        footer.push(Line::from(Span::styled(
            app.switch.state().label(),
            Style::default().fg(app.theme.colors().accent),
        )));
    }

    // Keep the selected row visible while reserving room for the context and
    // compaction footer. A long session list scrolls instead of hiding the
    // cursor.
    let viewport = inner.height as usize;
    let footer_height = footer.len().min(viewport.saturating_sub(1));
    let row_viewport = viewport.saturating_sub(footer_height).max(1);
    let selected_line = prefix_rows + app.sessions_panel.selected;
    let start = selected_line.saturating_add(1).saturating_sub(row_viewport);
    let visible: Vec<Line<'static>> = rows
        .into_iter()
        .skip(start)
        .take(row_viewport)
        .chain(footer.into_iter().take(footer_height))
        .collect();
    frame.render_widget(Paragraph::new(Text::from(visible)), inner);
}

fn push_session_row(lines: &mut Vec<Line<'static>>, selected: bool, text: String, theme: Theme) {
    let colors = theme.colors();
    let marker = if selected { "▶ " } else { "  " };
    let style = if selected {
        Style::default().fg(colors.fg).bg(colors.selected_bg)
    } else {
        Style::default()
    };
    lines.push(Line::from(Span::styled(
        format!("{marker}{}", truncate(&text, 120)),
        style,
    )));
}

fn push_context_details(lines: &mut Vec<Line<'static>>, app: &App) {
    match &app.context {
        Some(meter) => {
            let occupancy = meter.occupancy();
            lines.push(Line::from(Span::styled(
                format!("上下文占用（参考值）：{}", occupancy.label()),
                Style::default().fg(match occupancy {
                    Occupancy::Known { .. } => app.theme.colors().accent,
                    Occupancy::Unknown => app.theme.colors().warning,
                }),
            )));
            if occupancy == Occupancy::Unknown {
                lines.push(Line::from(Span::styled(
                    "  缺 projectedTokens 或 contextWindow；不补零、不用累计用量冒充",
                    Style::default().fg(app.theme.colors().warning),
                )));
            }
            lines.push(Line::from(Span::styled(
                format!("  {}", meter.provenance_label(now_ms())),
                Style::default().fg(app.theme.colors().muted),
            )));
            match meter.token_usage {
                Some(usage) => lines.push(Line::from(Span::styled(
                    format!(
                        "计费用量（整个日志）：输入 {} + 输出 {} + 缓存读 {} / 写 {} = {}",
                        usage.uncached_input_tokens,
                        usage.output_tokens,
                        usage.cache_read_tokens,
                        usage.cache_write_tokens,
                        usage.total()
                    ),
                    Style::default().fg(app.theme.colors().muted),
                ))),
                None => lines.push(Line::from(Span::styled(
                    "计费用量：未知（官方投影未提供）",
                    Style::default().fg(app.theme.colors().warning),
                ))),
            }
            if let Some(breakdown) = meter.breakdown {
                lines.push(Line::from(Span::styled(
                    format!(
                        "估算构成（启发式，CJK/JSON 可能低估）：系统 {} · 工具 {} · 消息 {}",
                        breakdown.system_tokens, breakdown.tools_tokens, breakdown.message_tokens
                    ),
                    Style::default().fg(app.theme.colors().muted),
                )));
            }
            if let Some(pressure) = meter.pressure_tokens {
                lines.push(Line::from(Span::styled(
                    format!("最近一次 provider 压力：{} tokens（非当前占用）", pressure),
                    Style::default().fg(app.theme.colors().muted),
                )));
            }
        }
        None => {
            lines.push(Line::from(Span::styled(
                match &app.context_error {
                    Some(error) => format!("上下文：未知（{error}）"),
                    None => "上下文：尚未读取".to_string(),
                },
                Style::default().fg(app.theme.colors().muted),
            )));
        }
    }
}

/// Current wall clock in Unix epoch milliseconds, for provenance ages.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// HH:MM from an official durable event time.
fn short_clock(epoch_ms: u64) -> String {
    let text = format_clock(epoch_ms);
    text.get(0..5).map(str::to_string).unwrap_or(text)
}

/// Bottom subagent dock: at most four direct children plus one overflow row.
fn draw_subagent_dock(frame: &mut Frame, app: &mut App, area: Rect) {
    let (rows, overflow) = app.subagents.dock();
    app.subagent_dock_area = area;
    app.subagent_dock_hits.clear();
    // The dock has no title: the design keeps the top edge as a plain rule and
    // moves the count to the all-agents list.
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(app.theme.border_style());
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let blink_on = app.reduced_motion || app.subagents.lifecycle().blink_on(Instant::now());
    let width = inner.width.max(1) as usize;
    let hover = app.theme.colors().hover_bg;
    let mut lines: Vec<Line<'static>> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let selected = app.subagents.nav().dock_focus && app.subagents.nav().dock_selected == index;
        let marker = if selected { "›" } else { " " };
        let lamp = app.subagents.lamp(row);
        let (dot, color) = lamp_glyph(lamp, blink_on, app.theme);
        let meta = row_status(lamp);
        let name = safe_text(row.display_label());
        let meta_width = meta.chars().map(display_width).sum::<usize>();
        // marker(1) + space(1) + dot(1) + space(1) + gap(1) + status.
        let name_room = width.saturating_sub(4 + 1 + meta_width).max(1);
        let name = truncate(&name, name_room);
        let left_width = 4 + name.chars().map(display_width).sum::<usize>();
        let pad = width.saturating_sub(left_width + meta_width).max(1);
        let row_style = if selected {
            Style::default().bg(hover)
        } else {
            Style::default()
        };
        let pointer_style = row_style.fg(app.theme.colors().accent);
        let dot_style = row_style.fg(color);
        let status_style = row_style.fg(app.theme.colors().muted);
        let spans = vec![
            Span::styled(format!("{marker} "), pointer_style),
            Span::styled(dot.to_string(), dot_style),
            Span::styled(format!(" {name}"), row_style),
            Span::styled(" ".repeat(pad), row_style),
            Span::styled(meta.to_string(), status_style),
        ];
        lines.push(Line::from(spans));
        app.subagent_dock_hits.push((index, inner.y + index as u16));
    }
    if overflow > 0 {
        let selected =
            app.subagents.nav().dock_focus && app.subagents.nav().dock_selected == rows.len();
        let marker = if selected { "›" } else { " " };
        let style = if selected {
            Style::default().fg(app.theme.colors().accent).bg(hover)
        } else {
            Style::default().fg(app.theme.colors().accent)
        };
        lines.push(Line::from(vec![
            Span::styled(format!("{marker} "), style),
            Span::styled("● ".to_string(), style),
            Span::styled(format!("还有 {overflow} 个子代理"), style),
        ]));
        app.subagent_dock_hits
            .push((rows.len(), inner.y + rows.len() as u16));
    }
    frame.render_widget(Paragraph::new(Text::from(lines)), inner);
}

fn muted_style(theme: Theme) -> Style {
    Style::default().fg(theme.colors().muted)
}

/// All-agents list: recursive descendants with parent relationships and
/// diagnostics for unreadable branches.
fn draw_subagent_list(frame: &mut Frame, app: &mut App, area: Rect) {
    let title = if app.subagent_list_loading {
        " 全部子代理 · 读取中… · ↑↓ 选择 · r 刷新 · Esc 关闭 ".to_string()
    } else {
        format!(
            " 全部子代理 · {} · ↑↓ 选择 · Enter 进入 · r 刷新 · Esc 关闭 ",
            app.subagents.local_count()
        )
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(app.theme.border_style())
        .title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    app.subagent_list_area = area;
    let rows = app.subagents.list_rows();
    let selected = app.subagents.nav().list_selected;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let width = inner.width.max(1) as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();
    if rows.is_empty() {
        lines.push(Line::from(Span::styled(
            if app.subagent_list_loading {
                "正在读取官方子代理目录…"
            } else {
                "没有已知子代理。"
            },
            Style::default().fg(app.theme.colors().muted),
        )));
    }
    for (index, row) in rows.iter().enumerate() {
        let indent = "  ".repeat(row.depth.saturating_sub(1) as usize);
        let branch = if row.depth > 1 { "└ " } else { "" };
        let mut text = format!(
            "{indent}{branch}{} · {} · {}",
            safe_text(row.display_label()),
            row.mode.label(),
            row.activity.label()
        );
        if row.mode == nano_subagents::AgentMode::External {
            text.push_str(" · 不可进入");
        }
        if let Some(duration) = row.duration_ms(now_ms) {
            text.push_str(&format!(" · {}", format_duration_ms(duration)));
        }
        if let Some(completed) = row.last_turn_completed {
            if completed {
                text.push_str(" · 上回合完成");
            }
        }
        let style = if index == selected {
            Style::default()
                .fg(app.theme.colors().fg)
                .bg(app.theme.colors().selected_bg)
        } else {
            Style::default()
        };
        for segment in wrap_segments(&truncate(&text, width.saturating_mul(2)), width) {
            lines.push(Line::from(Span::styled(segment.text, style)));
        }
    }
    for diagnostic in app.subagents.diagnostics() {
        let mut text = format!(
            "! 读不到 {}: {}",
            safe_text(&diagnostic.id),
            safe_text(&diagnostic.reason)
        );
        if let Some(parent) = &diagnostic.parent_id {
            text.push_str(&format!("（父 {}）", safe_text(parent)));
        }
        for segment in wrap_segments(&truncate(&text, width.saturating_mul(2)), width) {
            lines.push(Line::from(Span::styled(
                segment.text,
                Style::default().fg(app.theme.colors().error),
            )));
        }
    }
    if let Some(error) = app.subagents.last_error() {
        for segment in wrap_segments(&truncate(&safe_text(error), width.saturating_mul(2)), width) {
            lines.push(Line::from(Span::styled(
                segment.text,
                Style::default().fg(app.theme.colors().error),
            )));
        }
    }
    let viewport = inner.height as usize;
    let start = selected
        .saturating_add(1)
        .saturating_sub(viewport.max(1))
        .min(lines.len().saturating_sub(viewport.max(1)));
    let visible: Vec<Line<'static>> = lines.into_iter().skip(start).take(viewport).collect();
    frame.render_widget(Paragraph::new(Text::from(visible)), inner);
}

/// Replace terminal control characters with a visible marker. Labels come
/// from model/tool input and must never be able to inject escape sequences.
fn safe_text(text: &str) -> String {
    text.chars()
        .map(|character| {
            if character.is_control() {
                '?'
            } else {
                character
            }
        })
        .collect()
}

fn format_duration_ms(ms: u64) -> String {
    if ms < 1000 {
        format!("{ms}ms")
    } else if ms < 60_000 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        format!("{}m{:02}s", ms / 60_000, (ms % 60_000) / 1000)
    }
}

fn lamp_glyph(lamp: Lamp, blink_on: bool, theme: Theme) -> (&'static str, Color) {
    let colors = theme.colors();
    match lamp {
        Lamp::Running => (
            if blink_on { "●" } else { "○" },
            if blink_on {
                colors.accent
            } else {
                colors.muted
            },
        ),
        Lamp::Completed => ("●", colors.success),
        Lamp::Warned => ("●", colors.warning),
        Lamp::Error => ("●", colors.error),
        Lamp::Inactive => ("●", colors.muted),
    }
}

/// Right-hand status word for one dock row. The official terminal lamp is the
/// authority; `activity` alone cannot tell a finished child from a live one.
fn row_status(lamp: Lamp) -> &'static str {
    match lamp {
        Lamp::Running => "执行中",
        Lamp::Completed => "完成",
        Lamp::Warned => "终止",
        Lamp::Error => "错误",
        Lamp::Inactive => "未运行",
    }
}

fn draw_feed(frame: &mut Frame, app: &mut App, area: Rect) {
    app.feed_area = area;
    app.jump_area = Rect::default();
    app.feed_height = area.height as usize;
    if app.transcript_dirty || app.active_model().previews().has_live() {
        // The mounted child owns its own official model; the root model keeps
        // its history and previews untouched while the child view is active.
        if app.subagent_active() {
            if let Some(key) = app.active_child_key.clone() {
                if let Some(model) = app.child_models.get(&key) {
                    app.view.sync(model, Instant::now());
                }
            }
        } else {
            app.view.sync(&app.model, Instant::now());
        }
        app.transcript_dirty = false;
    }
    let render = app
        .view
        .render(area.width.max(1) as usize, area.height.max(1) as usize);
    app.feed_hits = render.hits;
    let mut lines = render.lines;
    // Local `!` records are S08 display data until the official synthetic
    // message is durable. Show them only while following the bottom.
    if !app.subagent_active() && app.view.scroll().sticky() && !app.bash_records.is_empty() {
        let before = lines.len();
        for record in &app.bash_records {
            push_bash_record(&mut lines, record, area.width.max(1) as usize, app.theme);
        }
        let added = lines.len().saturating_sub(before);
        app.feed_hits.extend(std::iter::repeat(None).take(added));
        let viewport = area.height as usize;
        if lines.len() > viewport {
            let extra = lines.len() - viewport;
            lines.drain(0..extra);
            app.feed_hits.drain(0..extra.min(app.feed_hits.len()));
        }
    }
    if lines.is_empty() {
        let empty = if app.subagent_active() {
            "正在读取子代理历史…"
        } else {
            "输入消息后按 Enter 发送。"
        };
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                empty,
                Style::default().fg(app.theme.colors().muted),
            ))),
            area,
        );
    } else {
        frame.render_widget(Paragraph::new(Text::from(lines)), area);
    }
    if let Some(rect) = jump_button_rect(area, !app.view.scroll().sticky()) {
        app.jump_area = rect;
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                " 回到最新 ",
                Style::default()
                    .fg(app.theme.colors().accent)
                    .bg(app.theme.colors().hover_bg),
            ))),
            rect,
        );
    }
}

/// Bottom-right "回到最新" button, 2 cells from the right edge.
fn jump_button_rect(area: Rect, visible: bool) -> Option<Rect> {
    if !visible || area.height == 0 || area.width < 12 {
        return None;
    }
    Some(Rect {
        x: area.right().saturating_sub(12),
        y: area.y.saturating_add(area.height.saturating_sub(1)),
        width: 10,
        height: 1,
    })
}
/// Skills catalog with an optional read-only instruction preview.
fn draw_skills_panel(frame: &mut Frame, app: &App, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(app.theme.border_style())
        .title(Span::styled(
            " 技能 ",
            Style::default().fg(app.theme.colors().accent),
        ));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height == 0 || inner.width == 0 {
        return;
    }
    let width = inner.width as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();
    let state = if !app.skills.loaded() {
        "未加载"
    } else if app.skills.may_be_incomplete() {
        "可能不完整"
    } else {
        "完整"
    };
    lines.push(Line::from(vec![
        Span::styled(
            format!("共 {} 个用户可调用技能", app.skills.entries().len()),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(" · {state} · 来源：官方技能目录"),
            Style::default().fg(app.theme.colors().muted),
        ),
    ]));
    if let Some(reason) = app.skills.stale_reason() {
        wrap_block(
            &mut lines,
            &format!("刷新失败：{reason}；保留上次可用目录"),
            width,
            300,
            app.theme.colors().warning,
        );
    }
    if app.skills.entries().is_empty() {
        lines.push(Line::from(Span::styled(
            "没有用户可调用的技能；/name 仍按普通文本提交。",
            Style::default().fg(app.theme.colors().muted),
        )));
    }

    let preview_open = app.skill_preview_target.is_some();
    let header_rows = lines.len();
    let preview_rows = if preview_open {
        (inner.height as usize).saturating_sub(header_rows) / 2
    } else {
        0
    };
    let list_rows = (inner.height as usize)
        .saturating_sub(header_rows)
        .saturating_sub(preview_rows);

    // Render each entry as its own block so the window follows real wrapped
    // heights instead of assuming one title line plus one detail line.
    let entries = app.skills.entries();
    let mut blocks: Vec<Vec<Line<'static>>> = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let selected = index == app.skill_selection;
        let marker = if selected { "▸ " } else { "  " };
        let mut spans = vec![
            Span::styled(
                format!("{marker}/{}", entry.name),
                Style::default()
                    .fg(if selected {
                        app.theme.colors().accent
                    } else {
                        app.theme.colors().fg
                    })
                    .add_modifier(if selected {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            ),
            Span::raw("  "),
            Span::styled(
                truncate(&entry.description, width.saturating_sub(16)),
                Style::default(),
            ),
        ];
        if entry.user_only() {
            spans.push(Span::styled(
                "  [仅用户可调用]",
                Style::default().fg(app.theme.colors().warning),
            ));
        }
        if entry.shadowed_by_command {
            spans.push(Span::styled(
                "  [命令优先]",
                Style::default().fg(app.theme.colors().accent),
            ));
        }
        let mut block = vec![Line::from(spans)];
        let mut detail = Vec::new();
        if let Some(when) = &entry.when_to_use {
            detail.push(format!("适用：{when}"));
        }
        if let Some(path) = &entry.path {
            detail.push(format!("文件：{path}"));
        } else {
            detail.push("无文件路径（不可预览）".to_string());
        }
        detail.push(format!("来源：{} / {}", entry.source, entry.provider));
        wrap_block(
            &mut block,
            &format!("    {}", detail.join(" · ")),
            width,
            usize::MAX,
            app.theme.colors().muted,
        );
        blocks.push(block);
    }

    if list_rows > 0 && !blocks.is_empty() {
        let selected = app.skill_selection.min(blocks.len() - 1);
        let heights: Vec<usize> = blocks.iter().map(Vec::len).collect();
        let start = visible_block_start(&heights, selected, list_rows);
        let mut drawn = 0;
        for (index, block) in blocks.iter().enumerate().skip(start) {
            if drawn + block.len() > list_rows && index != selected {
                break;
            }
            drawn += block.len();
            lines.extend(block.iter().cloned());
            if drawn >= list_rows {
                break;
            }
        }
    }

    if preview_open {
        while lines.len() < inner.height as usize - preview_rows {
            lines.push(Line::from(""));
        }
        draw_skill_preview(&mut lines, app, width);
        lines.truncate(inner.height as usize);
    }
    frame.render_widget(Paragraph::new(Text::from(lines)), inner);
}

/// Right-hand preview content appended below the skill list.
fn draw_skill_preview(lines: &mut Vec<Line<'static>>, app: &App, width: usize) {
    let name = app.skill_preview_target.clone().unwrap_or_default();
    let mut title = vec![Span::styled(
        format!("── 预览 /{name} "),
        Style::default().fg(app.theme.colors().accent),
    )];
    if let Some(preview) = &app.skill_preview {
        title.push(Span::styled(
            preview.path.clone(),
            Style::default().fg(app.theme.colors().muted),
        ));
    }
    lines.push(Line::from(title));
    if let Some(error) = &app.skill_preview_error {
        wrap_block(lines, error, width, 600, app.theme.colors().error);
        return;
    }
    let Some(preview) = &app.skill_preview else {
        lines.push(Line::from(Span::styled(
            "正在读取预览…",
            Style::default().fg(app.theme.colors().muted),
        )));
        return;
    };
    if let Some(label) = preview.truncation_label() {
        wrap_block(lines, &label, width, 200, app.theme.colors().warning);
    }
    if preview.empty() {
        lines.push(Line::from(Span::styled(
            "（文件为空）",
            Style::default().fg(app.theme.colors().muted),
        )));
        return;
    }
    if preview.text.chars().count() > 4_000 {
        lines.push(Line::from(Span::styled(
            "（面板只显示前 4000 字符；完整内容以官方文件为准）",
            Style::default().fg(app.theme.colors().warning),
        )));
    }
    wrap_block(lines, &preview.text, width, 4_000, app.theme.colors().fg);
}

/// One-time first-launch provenance panel: config patch, credential reference
/// and source label, and the official workspace-instruction paths. It never
/// shows a credential value.
fn draw_sources_panel(frame: &mut Frame, app: &App, area: Rect) {
    let colors = app.theme.colors();
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(app.theme.border_style())
        .title(Span::styled(" 来源 ", Style::default().fg(colors.accent)));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height == 0 || inner.width == 0 {
        return;
    }
    let width = inner.width as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();
    lines.push(Line::from(Span::styled(
        "本次启动报告的来源；凭据只显示引用，不显示值。",
        Style::default().fg(colors.muted),
    )));
    match app
        .provenance
        .as_ref()
        .and_then(|provenance| provenance.config.as_ref())
    {
        Some(config) => {
            lines.push(Line::from(Span::styled(
                "配置",
                Style::default().add_modifier(Modifier::BOLD),
            )));
            wrap_block(&mut lines, &config.path, width, 4_096, colors.fg);
        }
        None => lines.push(Line::from(vec![
            Span::styled("配置  ", Style::default().add_modifier(Modifier::BOLD)),
            Span::styled("宿主未报告", Style::default().fg(colors.warning)),
        ])),
    }
    match app
        .provenance
        .as_ref()
        .and_then(|provenance| provenance.credentials.as_ref())
    {
        Some(credentials) => {
            let state = if credentials.configured {
                credential_source_label(credentials.source.as_deref())
            } else {
                "未配置".to_string()
            };
            let prefix = "凭据（默认 DeepSeek）  ";
            let suffix = format!(" · {state}");
            let label_width: usize = prefix.chars().map(display_width).sum();
            let suffix_width: usize = suffix.chars().map(display_width).sum();
            let remaining = width
                .saturating_sub(label_width)
                .saturating_sub(suffix_width);
            if remaining < 4 {
                lines.push(Line::from(Span::styled(
                    truncate(&format!("{prefix}{}{suffix}", credentials.reference), width),
                    Style::default().fg(colors.fg),
                )));
            } else {
                lines.push(Line::from(vec![
                    Span::styled(prefix, Style::default().add_modifier(Modifier::BOLD)),
                    Span::raw(truncate(&credentials.reference, remaining)),
                    Span::styled(suffix, Style::default().fg(colors.muted)),
                ]));
            }
        }
        None => lines.push(Line::from(vec![
            Span::styled("凭据  ", Style::default().add_modifier(Modifier::BOLD)),
            Span::styled("宿主未报告", Style::default().fg(colors.warning)),
        ])),
    }
    if app.instructions.available {
        lines.push(Line::from(vec![
            Span::styled("规矩  ", Style::default().add_modifier(Modifier::BOLD)),
            Span::raw(format!("{} 份", app.instructions.sources.len())),
            Span::styled(" · Alt+R 查看完整来源", Style::default().fg(colors.muted)),
        ]));
        for source in app.instructions.sources.iter().take(4) {
            lines.push(Line::from(Span::styled(
                truncate(
                    &format!("  {} {}", source.action.label(), source.path),
                    width,
                ),
                Style::default().fg(colors.muted),
            )));
        }
        if app.instructions.sources.len() > 4 {
            lines.push(Line::from(Span::styled(
                format!("  … 还有 {} 份", app.instructions.sources.len() - 4),
                Style::default().fg(colors.muted),
            )));
        }
    } else if !app.instruction_candidates.is_empty() {
        lines.push(Line::from(vec![
            Span::styled("规矩  ", Style::default().add_modifier(Modifier::BOLD)),
            Span::raw(format!(
                "{} 份默认候选 · 以首轮实际加载为准",
                app.instruction_candidates.len()
            )),
        ]));
        for candidate in app.instruction_candidates.iter().take(4) {
            let suffix = candidate
                .skip
                .map(|note| format!(" · {note}"))
                .unwrap_or_default();
            wrap_block(
                &mut lines,
                &format!("  {}{suffix}", candidate.path),
                width,
                4_096,
                colors.muted,
            );
        }
        if app.instruction_candidates.len() > 4 {
            lines.push(Line::from(Span::styled(
                format!("  … 还有 {} 份", app.instruction_candidates.len() - 4),
                Style::default().fg(colors.muted),
            )));
        }
    } else {
        lines.push(Line::from(vec![
            Span::styled("规矩  ", Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(
                "尚未加载（未发现 AGENTS.md / CLAUDE.md）",
                Style::default().fg(colors.warning),
            ),
        ]));
    }
    lines.push(Line::from(Span::styled(
        "Enter / Esc 关闭",
        Style::default().fg(colors.muted),
    )));
    frame.render_widget(Paragraph::new(Text::from(lines)), inner);
}

fn credential_source_label(source: Option<&str>) -> String {
    match source {
        Some("file") => "凭据文件".to_string(),
        Some("env") => "启动环境".to_string(),
        Some("project-env") => "项目 .env".to_string(),
        Some("user-env") => "用户 .env".to_string(),
        Some(other) => other.to_string(),
        None => "来源未知".to_string(),
    }
}

/// Workspace-instruction sources, load time, and the official budget notice.
fn draw_instructions_panel(frame: &mut Frame, app: &mut App, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(app.theme.border_style())
        .title(Span::styled(
            " 项目规矩 ",
            Style::default().fg(app.theme.colors().accent),
        ));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height == 0 || inner.width == 0 {
        return;
    }
    let width = inner.width as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();
    if app.instructions.available {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        lines.push(Line::from(vec![
            Span::styled(
                format!("来源 {} 份", app.instructions.sources.len()),
                Style::default().add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!(
                    " · 最近一次加载 {} · {}",
                    app.instructions.age_label(now),
                    if app.instructions.baseline {
                        "基线"
                    } else {
                        "增量"
                    }
                ),
                Style::default().fg(app.theme.colors().muted),
            ),
        ]));
    } else {
        wrap_block(
            &mut lines,
            "本次会话尚未加载项目规矩（官方 agent-instructions 未产生消息）。",
            width,
            300,
            app.theme.colors().warning,
        );
    }
    if let Some(notice) = &app.instructions.budget_notice {
        // The bridge already bounds this at 8192 code points and sets
        // `truncated`; rendering the whole bound value avoids a second silent
        // cut without a marker.
        wrap_block(&mut lines, notice, width, 8_192, app.theme.colors().warning);
    }
    if app.instructions.truncated {
        lines.push(Line::from(Span::styled(
            "来源投影已截断：只显示部分来源与提示。",
            Style::default().fg(app.theme.colors().warning),
        )));
    }
    let order_hint = if app.instructions.baseline {
        "基线按官方加载顺序显示；同名内容已合并。"
    } else {
        "基线按官方加载顺序；增量来源按官方消息到达顺序追加；同名内容已合并。"
    };
    lines.push(Line::from(Span::styled(
        order_hint,
        Style::default().fg(app.theme.colors().muted),
    )));
    for source in &app.instructions.sources {
        lines.push(Line::from(vec![
            Span::styled(
                format!("  {:<4}", source.action.label()),
                Style::default().fg(app.theme.colors().success),
            ),
            Span::raw(" "),
            Span::raw(source.path.clone()),
        ]));
    }
    let max_scroll = lines.len().saturating_sub(inner.height as usize);
    app.instructions_max_scroll = max_scroll;
    let offset = app.instructions_scroll.min(max_scroll);
    let visible: Vec<Line<'static>> = lines.into_iter().skip(offset).collect();
    frame.render_widget(Paragraph::new(Text::from(visible)), inner);
}

/// First block of a window that keeps the selected block visible, using the
/// real wrapped height of each block.
fn visible_block_start(heights: &[usize], selected: usize, rows: usize) -> usize {
    if heights.is_empty() {
        return 0;
    }
    let selected = selected.min(heights.len() - 1);
    let mut start = selected;
    let mut used = heights[selected];
    while start > 0 {
        let height = heights[start - 1];
        if used + height > rows {
            break;
        }
        start -= 1;
        used += height;
    }
    start
}

fn push_bash_record(
    lines: &mut Vec<Line<'static>>,
    record: &BashRecord,
    width: usize,
    theme: Theme,
) {
    let colors = theme.colors();
    let color = match &record.state {
        BashState::Running => colors.warning,
        BashState::Done => match record.result.as_ref().and_then(|result| result.exit_code) {
            Some(0) => colors.success,
            _ => colors.error,
        },
        BashState::Failed(_) | BashState::Unknown(_) => colors.error,
    };
    lines.push(Line::from(vec![
        Span::styled("bash ", Style::default().fg(colors.warning)),
        Span::styled(
            format!("!{}", record.command),
            Style::default().fg(colors.warning),
        ),
        Span::raw(" · "),
        Span::styled(record.outcome_label(), Style::default().fg(color)),
    ]));
    let stdout = record.stdout();
    if !stdout.is_empty() {
        // Keep the tail: the official truncation/spill notice is appended at
        // the end and must not be cut away by the display bound.
        wrap_tail_block(lines, &stdout, width, 4_000, colors.fg, theme);
    }
    let stderr = record.stderr();
    if !stderr.is_empty() {
        lines.push(Line::from(Span::styled(
            "[stderr]",
            Style::default().fg(colors.error),
        )));
        wrap_tail_block(lines, &stderr, width, 4_000, colors.error, theme);
    }
    if let Some(error) = &record.inject_error {
        lines.push(Line::from(Span::styled(
            format!("（输出未注入会话：{error}）"),
            Style::default().fg(colors.warning),
        )));
    }
}

fn draw_jobs(frame: &mut Frame, app: &mut App, area: Rect) {
    let title = if app.monitor_form.is_some() {
        let form = app.monitor_form.as_ref().expect("form is present");
        format!(
            " 监听 · 附着到 {} · n 新输出 / a 从开头 / t 模式 / f 过滤 / r 正则 / Enter 创建 / Esc 取消 ",
            truncate(&form.job_label, 48)
        )
    } else if app.monitor_open {
        match app.monitor.selected_monitor() {
            Some(monitor) => format!(
                " 监听 · {} · {} · ↑↓ 切换，s 停止监听，b 重置预算，r 刷新，Esc 返回 ",
                monitor.job_id,
                monitor.mode.label()
            ),
            None => " 监听 · 暂无记录 · Esc 返回 ".to_string(),
        }
    } else if app.jobs.detail_open() {
        let job = app.jobs.detail_job();
        match job {
            Some(job) => format!(
                " 任务详情 · {} · {} · ↑↓ 滚动，m 监听，k 停止，r 重读，Esc 返回 ",
                job.id,
                job.status_line()
            ),
            None => " 任务详情 · 已移除 · Esc 返回 ".to_string(),
        }
    } else {
        format!(
            " 任务 · 官方 jobs · {} 个（{} 运行中） · ↑↓ 选择，Enter 详情，m 监听，k 停止，r 刷新，Esc 关闭 ",
            app.jobs.len(),
            app.jobs.active_count()
        )
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(app.theme.border_style())
        .title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let width = inner.width.max(1) as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();
    if app.monitor_form.is_some() {
        push_monitor_form(&mut lines, app, width);
    } else if app.monitor_open {
        push_monitor_view(&mut lines, app, width);
    } else if app.jobs.detail_open() {
        push_job_detail(&mut lines, app, width);
    } else if app.jobs.is_empty() {
        let message = if app.ready {
            "（没有可见任务。Agent 的前台命令在运行期间也会出现在这里。）"
        } else {
            "（宿主已断开；任务随宿主结束，不显示跨重启的运行状态）"
        };
        lines.push(Line::from(Span::styled(
            message,
            Style::default().fg(app.theme.colors().muted),
        )));
    } else {
        push_job_list(&mut lines, app);
    }
    let viewport = inner.height as usize;
    let total = lines.len();
    let offset = if app.monitor_form.is_some() {
        app.jobs_scroll_back = 0;
        0
    } else if app.monitor_open {
        let max_scroll = total.saturating_sub(viewport);
        app.jobs_scroll_back.min(max_scroll)
    } else if app.jobs.detail_open() {
        app.jobs_detail_lines = total;
        let max_scroll = total.saturating_sub(viewport);
        total
            .saturating_sub(viewport)
            .saturating_sub(app.jobs_scroll_back.min(max_scroll))
    } else {
        // Keep the selected row inside the viewport; the list itself is not a
        // tail view. Up/Down therefore scroll a long list with the selection.
        list_offset(app.jobs.selected(), total, viewport)
    };
    let visible: Vec<Line<'static>> = lines.into_iter().skip(offset).collect();
    frame.render_widget(Paragraph::new(Text::from(visible)), inner);
}

fn push_job_list(lines: &mut Vec<Line<'static>>, app: &App) {
    for (index, job) in app.jobs.jobs().iter().enumerate() {
        let marker = if index == app.jobs.selected() {
            "▶"
        } else {
            " "
        };
        let call = job
            .call_label()
            .map(|call| format!(" · 调用 {call}"))
            .unwrap_or_default();
        let mut spans = vec![
            Span::styled(
                format!("{marker} [{}] ", job.kind),
                Style::default().fg(app.theme.colors().accent),
            ),
            Span::raw(format!("{} · ", truncate(&job.label, 96))),
            Span::styled(
                job.status_line(),
                Style::default().fg(job_color(job.status(), app.theme)),
            ),
            Span::styled(
                format!(" · {}{}", job.id, call),
                Style::default().fg(app.theme.colors().muted),
            ),
        ];
        if let Some(monitor) = app.monitor.monitor_for_job(&job.id) {
            let budget = if monitor.exhausted {
                "预算用尽".to_string()
            } else {
                format!(
                    "{}/{}",
                    monitor.used.notifications, monitor.budgets.max_notifications
                )
            };
            let delivery = monitor
                .last_delivery()
                .map(|delivery| delivery.state.short_label())
                .unwrap_or("尚未投递");
            spans.push(Span::styled(
                format!(
                    " · 监听 {} · {} · {}",
                    monitor.mode.short_label(),
                    budget,
                    delivery
                ),
                Style::default().fg(if monitor.exhausted {
                    app.theme.colors().warning
                } else {
                    app.theme.colors().accent
                }),
            ));
        }
        lines.push(Line::from(spans));
    }
}

fn push_job_detail(lines: &mut Vec<Line<'static>>, app: &App, width: usize) {
    let Some(job) = app.jobs.detail_job() else {
        lines.push(Line::from(Span::styled(
            "（任务已从官方列表移除；按 Esc 返回）",
            Style::default().fg(app.theme.colors().error),
        )));
        return;
    };
    lines.push(Line::from(vec![
        Span::styled(
            format!("{} {}", job.kind, job.label),
            Style::default().fg(app.theme.colors().accent),
        ),
        Span::raw(" · "),
        Span::styled(
            job.status_line(),
            Style::default().fg(job_color(job.status(), app.theme)),
        ),
    ]));
    lines.push(Line::from(Span::styled(
        format!(
            "输出 ring：已写 {} 字节 · 最早保留 {} 字节（只读跟随，不影响模型的 job_output 游标）",
            job.output.total, job.output.earliest
        ),
        Style::default().fg(app.theme.colors().muted),
    )));
    if let Some(call) = &job.tool_call {
        lines.push(Line::from(Span::styled(
            format!("所属调用：{}（根调用 {}）", call.call_id, call.root_call_id),
            Style::default().fg(app.theme.colors().muted),
        )));
    }
    for path in &job.output.spill_paths {
        lines.push(Line::from(Span::styled(
            format!("完整输出：{path}"),
            Style::default().fg(app.theme.colors().warning),
        )));
    }
    if let Some(monitor) = app.monitor.monitor_for_job(&job.id) {
        lines.push(Line::from(Span::styled(
            format!(
                "监听 · {} · {}",
                monitor.mode.label(),
                monitor.stream.label()
            ),
            Style::default().fg(app.theme.colors().accent),
        )));
        lines.push(Line::from(Span::styled(
            monitor.budget_label(),
            Style::default().fg(if monitor.exhausted {
                app.theme.colors().warning
            } else {
                app.theme.colors().muted
            }),
        )));
        lines.push(Line::from(Span::styled(
            format!("{} · {}", monitor.identity_label(), monitor.offset_label()),
            Style::default().fg(app.theme.colors().muted),
        )));
    }
    if app.following.contains(&job.id) {
        lines.push(Line::from(Span::styled(
            "正在读取输出…",
            Style::default().fg(app.theme.colors().warning),
        )));
    }
    match app.jobs.output(&job.id) {
        Some(buffer) => {
            if buffer.head_truncated {
                lines.push(Line::from(Span::styled(
                    "（显示端已裁剪较早的本地缓存；完整输出以官方 ring/spill 为准）",
                    Style::default().fg(app.theme.colors().warning),
                )));
            }
            if buffer.lossy {
                lines.push(Line::from(Span::styled(
                    "（ring 已裁剪：更早字节不可读，不能用后续内容冒充连续输出）",
                    Style::default().fg(app.theme.colors().warning),
                )));
            }
            if buffer.text.is_empty() {
                lines.push(Line::from(Span::styled(
                    "（暂无输出）",
                    Style::default().fg(app.theme.colors().muted),
                )));
            } else {
                // The buffer keeps its tail; render the tail as well, never the
                // head of a tail buffer.
                wrap_tail_block(
                    lines,
                    &buffer.text,
                    width,
                    200_000,
                    app.theme.colors().fg,
                    app.theme,
                );
            }
        }
        None => lines.push(Line::from(Span::styled(
            "（尚未读取输出；按 r 读取）",
            Style::default().fg(app.theme.colors().muted),
        ))),
    }
}

fn push_monitor_form(lines: &mut Vec<Line<'static>>, app: &App, width: usize) {
    let Some(form) = &app.monitor_form else {
        return;
    };
    lines.push(Line::from(Span::styled(
        format!("附着监听 · {}", form.job_label),
        Style::default().fg(app.theme.colors().accent),
    )));
    lines.push(Line::from(Span::styled(
        format!("任务 {}", form.job_id),
        Style::default().fg(app.theme.colors().muted),
    )));
    lines.push(Line::from(Span::styled(
        format!(
            "已有 {} 字节未读；先选范围：n 只看新输出（跳过这些字节） / a 从开头（重放 retained head）",
            form.unread_bytes
        ),
        Style::default().fg(app.theme.colors().warning),
    )));
    lines.push(Line::from(Span::styled(
        if form.from_earliest {
            "当前范围：从开头；被 ring 裁掉的旧字节会标「已裁剪」，不会拼接假连续内容。"
        } else {
            "当前范围：只看新输出；附着后不会重放已有字节。"
        },
        Style::default().fg(app.theme.colors().fg),
    )));
    lines.push(Line::from(Span::styled(
        if form.quiet {
            "模式：quiet（官方 inject；不唤醒 Agent，空闲时可能一直等待；仍需 durable user/message 才算收件）"
        } else {
            "模式：notify（官方 followup；唤醒 Agent，会产生模型调用和费用）"
        },
        Style::default().fg(if form.quiet { app.theme.colors().muted } else { app.theme.colors().warning }),
    )));
    let filter = if form.filter.is_empty() {
        "过滤：无（每行都是候选）".to_string()
    } else if form.filter_regex {
        format!(
            "过滤：正则 /{}/{}",
            form.filter,
            if form.editing_filter {
                "（编辑中）"
            } else {
                ""
            }
        )
    } else {
        format!(
            "过滤：字面「{}」{}",
            form.filter,
            if form.editing_filter {
                "（编辑中）"
            } else {
                ""
            }
        )
    };
    push_wrapped(
        lines,
        &filter,
        width,
        Style::default().fg(app.theme.colors().fg),
    );
    lines.push(Line::from(Span::styled(
        "t 模式 · f 编辑过滤 · r 字面/正则 · Enter 创建 · Esc 取消",
        Style::default().fg(app.theme.colors().muted),
    )));
    lines.push(Line::from(Span::styled(
        "提示：同一任务已有活动监听时返回现有监听；停止监听不会停止任务。",
        Style::default().fg(app.theme.colors().muted),
    )));
}

fn push_monitor_view(lines: &mut Vec<Line<'static>>, app: &App, width: usize) {
    let Some(monitor) = app.monitor.selected_monitor() else {
        lines.push(Line::from(Span::styled(
            "（暂无监听。在任务列表选中任务后按 m 创建。）",
            Style::default().fg(app.theme.colors().muted),
        )));
        return;
    };
    lines.push(Line::from(vec![
        Span::styled(
            format!("监听 {}", monitor.job_id),
            Style::default().fg(app.theme.colors().accent),
        ),
        Span::raw(" · "),
        Span::styled(
            monitor.stream.label(),
            Style::default().fg(if monitor.stream.is_terminal() {
                app.theme.colors().warning
            } else {
                app.theme.colors().success
            }),
        ),
    ]));
    push_wrapped(
        lines,
        &monitor.identity_label(),
        width,
        Style::default().fg(app.theme.colors().warning),
    );
    push_wrapped(
        lines,
        &monitor.mode.label().to_string(),
        width,
        Style::default().fg(app.theme.colors().fg),
    );
    push_wrapped(
        lines,
        &format!(
            "范围：{} · {}",
            monitor.from.label(),
            monitor.offset_label()
        ),
        width,
        Style::default().fg(app.theme.colors().fg),
    );
    if matches!(monitor.from, nano_monitor::MonitorFrom::Earliest) && monitor.initial_offset > 0 {
        lines.push(Line::from(Span::styled(
            format!(
                "retained head 从字节 {} 开始；更早字节已被 ring 裁剪（已裁剪）。",
                monitor.initial_offset
            ),
            Style::default().fg(app.theme.colors().warning),
        )));
    }
    let filter = monitor
        .filter
        .as_ref()
        .map(|filter| filter.label())
        .unwrap_or_else(|| "无（每行都是候选）".to_string());
    push_wrapped(
        lines,
        &format!("合并窗口 {} ms · 过滤：{}", monitor.merge_window_ms, filter),
        width,
        Style::default().fg(app.theme.colors().fg),
    );
    let budget_color = if monitor.exhausted {
        app.theme.colors().warning
    } else {
        app.theme.colors().fg
    };
    push_wrapped(
        lines,
        &monitor.budget_label(),
        width,
        Style::default().fg(budget_color),
    );
    if monitor.exhausted {
        lines.push(Line::from(Span::styled(
            if monitor.exhaust_reason.as_deref() == Some("expired") {
                "监听有效期已过：普通行投递已停止，计数保留；按 b 显式重置有效期。"
            } else {
                "预算已用尽：普通行投递已停止，计数保留；按 b 显式重置后恢复。"
            },
            Style::default().fg(app.theme.colors().warning),
        )));
    }
    if monitor.stopped_by_user {
        lines.push(Line::from(Span::styled(
            "用户已停止监听；被观察任务未受影响。",
            Style::default().fg(app.theme.colors().warning),
        )));
    }
    if monitor.lossy {
        lines.push(Line::from(Span::styled(
            "已裁剪：监听的请求位置早于官方 ring 保留范围，更早字节不可读。",
            Style::default().fg(app.theme.colors().warning),
        )));
    }
    if monitor.gaps > 0 {
        lines.push(Line::from(Span::styled(
            format!(
                "输出缺口 {} 次：更早字节不可读，监听不会把缺口前后拼成假连续文本。",
                monitor.gaps
            ),
            Style::default().fg(app.theme.colors().warning),
        )));
    }
    if let Some(detail) = &monitor.stream_detail {
        push_wrapped(
            lines,
            &format!("流结束原因：{detail}"),
            width,
            Style::default().fg(app.theme.colors().muted),
        );
    }
    if let Some(error) = &monitor.last_error {
        push_wrapped(
            lines,
            &format!("最近错误：{error}"),
            width,
            Style::default().fg(app.theme.colors().error),
        );
    }
    lines.push(Line::from(Span::styled(
        "投递回执：submitted/inserted/claimed 都不证明模型收到；只有 durable user/message 是 accepted。",
        Style::default().fg(app.theme.colors().muted),
    )));
    if monitor.deliveries.is_empty() {
        lines.push(Line::from(Span::styled(
            "（还没有通知投递）",
            Style::default().fg(app.theme.colors().muted),
        )));
    } else {
        for delivery in monitor.deliveries.iter().rev().take(10) {
            let color = if delivery.state.is_proven() {
                app.theme.colors().success
            } else if delivery.state.is_failure() {
                app.theme.colors().error
            } else {
                app.theme.colors().warning
            };
            lines.push(Line::from(Span::styled(
                format!(
                    "· {} · {} 行 · {}..{} · {}",
                    delivery.state.label(),
                    delivery.lines,
                    delivery.first_offset,
                    delivery.last_offset,
                    delivery.message_id
                ),
                Style::default().fg(color),
            )));
            if let Some(detail) = &delivery.detail {
                push_wrapped(
                    lines,
                    &format!("  {detail}"),
                    width,
                    Style::default().fg(app.theme.colors().muted),
                );
            }
        }
    }
    lines.push(Line::from(Span::styled(
        "s 停止监听（不停止任务） · b 重置预算 · r 刷新 · Esc 返回",
        Style::default().fg(app.theme.colors().muted),
    )));
}

fn job_color(status: JobStatus, theme: Theme) -> Color {
    let colors = theme.colors();
    match status {
        JobStatus::Running => colors.warning,
        JobStatus::Stopping => colors.warning,
        JobStatus::Completed => colors.success,
        JobStatus::Killed => colors.error,
        JobStatus::Failed => colors.error,
        JobStatus::Unknown => colors.muted,
    }
}

fn decision_height(app: &App, width: u16, height: u16) -> u16 {
    let max = height.saturating_sub(8).max(6);
    let desired = match app.decisions.top() {
        Some(DecisionTop::Approval(card)) => {
            let reason = card
                .display_reason()
                .or(card.reason())
                .unwrap_or("官方请求未附原因");
            let reason_rows = display_rows(reason, width as usize).len().max(1);
            let command_rows = card
                .command()
                .map(|command| display_rows(command, width.saturating_sub(2) as usize).len())
                .unwrap_or(1);
            let state_rows = usize::from(
                matches!(card.state(), ApprovalCardState::Settled(_)) || card.notice().is_some(),
            );
            (1 + 1 + reason_rows + command_rows + 4 + 1 + state_rows) as u16
        }
        Some(DecisionTop::Question(card)) => question_height(card, width),
        None => 6,
    };
    desired.clamp(6, max)
}

fn question_height(card: &QuestionCard, width: u16) -> u16 {
    if card.state() == QuestionCardState::ReadOnly {
        return 4 + card.questions().len() as u16 * 3;
    }
    if card.plan_review().is_some() {
        let plan_rows = if card.plan_expanded() {
            card.questions()[0]
                .detail
                .as_deref()
                .map(|detail| display_rows(detail, width.saturating_sub(4) as usize).len())
                .unwrap_or(0)
                .min(10) as u16
        } else {
            0
        };
        return 10 + plan_rows;
    }
    let mut rows = 1u16; // top accent line
    if card.questions().len() > 1 {
        rows += 1; // tabs
    }
    if card.page() == card.questions().len() {
        rows += 1; // submit title
        rows += card.questions().len() as u16;
        rows += display_rows(&submit_footer(card), width as usize).len() as u16;
    } else if let Some(question) = card.questions().get(card.page()) {
        rows += capped_rows(&question.question, width as usize, 3).len() as u16;
        for option in &question.options {
            rows += 1;
            if option.description.is_some() {
                rows += 1;
            }
        }
        rows += 1; // Other row
        rows += display_rows(&question_footer(card, question), width as usize).len() as u16;
    } else {
        rows += 1;
    }
    if card.error().is_some() {
        rows += 1;
    }
    if card.notice().is_some() {
        rows += 1;
    }
    rows
}

fn draw_decision(frame: &mut Frame, app: &mut App, area: Rect) {
    app.decision_area = area;
    let flat = match app.decisions.top() {
        Some(DecisionTop::Approval(_)) => true,
        Some(DecisionTop::Question(card)) => {
            card.state() != QuestionCardState::ReadOnly && card.plan_review().is_none()
        }
        None => false,
    };
    let (title, lines, hits) = match app.decisions.top() {
        Some(DecisionTop::Approval(card)) => render_approval(card, area, app.theme),
        Some(DecisionTop::Question(card)) => render_question(card, area, app.theme),
        None => (String::new(), Vec::new(), Vec::new()),
    };
    let block = if flat {
        Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(app.theme.colors().accent))
    } else {
        Block::default()
            .borders(Borders::ALL)
            .border_style(app.theme.border_style())
            .title(title)
    };
    let inner = block.inner(area);
    let visible: Vec<Line<'static>> = lines.iter().take(inner.height as usize).cloned().collect();
    app.decision_hits = map_decision_hits(&hits, inner.height, area.height);
    frame.render_widget(block, area);
    frame.render_widget(Paragraph::new(Text::from(visible)), inner);
}

/// Map content-row hits onto the full card area. Row 0 is the top border and
/// the last row is the bottom border; hits past the inner height are clipped
/// with the text and must never answer a hidden option.
fn map_decision_hits(
    hits: &[Option<DecisionClick>],
    inner_height: u16,
    area_height: u16,
) -> Vec<Option<DecisionClick>> {
    let mut mapped = Vec::with_capacity(area_height as usize);
    mapped.push(None);
    mapped.extend(hits.iter().take(inner_height as usize).cloned());
    while mapped.len() < area_height as usize {
        mapped.push(None);
    }
    mapped.truncate(area_height as usize);
    mapped
}
fn render_approval(
    card: &nano_decisions::ApprovalCard,
    area: Rect,
    theme: Theme,
) -> (String, Vec<Line<'static>>, Vec<Option<DecisionClick>>) {
    let width = area.width.max(1) as usize;
    let title = String::new();
    let mut lines = Vec::new();
    let mut hits = Vec::new();
    let question = if card.tool_name().eq_ignore_ascii_case("bash") {
        "是否运行这条检查命令？".to_string()
    } else {
        format!("是否运行 {}？", card.tool_name())
    };
    lines.push(Line::from(Span::styled(
        question,
        Style::default()
            .fg(theme.colors().fg)
            .add_modifier(Modifier::BOLD),
    )));
    hits.push(None);
    let reason = card
        .display_reason()
        .or(card.reason())
        .unwrap_or("官方请求未附原因");
    for row in display_rows(reason, width) {
        lines.push(Line::from(Span::styled(
            row,
            Style::default().fg(theme.colors().muted),
        )));
        hits.push(None);
    }
    let content_height = area.height.saturating_sub(1) as usize;
    let option_rows = 4usize;
    let footer_rows = 1usize;
    let state_rows = usize::from(
        matches!(card.state(), ApprovalCardState::Settled(_)) || card.notice().is_some(),
    );
    let available = content_height
        .saturating_sub(lines.len() + option_rows + footer_rows + state_rows)
        .max(1);
    let command_rows = card
        .command()
        .map(|command| display_rows(command, width.saturating_sub(2).max(1)))
        .unwrap_or_default();
    if card.command().is_some() {
        let start = card.command_offset().min(command_rows.len());
        for row in command_rows.iter().skip(start).take(available) {
            lines.push(Line::from(Span::styled(
                format!("  {row}"),
                Style::default().fg(theme.colors().muted),
            )));
            hits.push(None);
        }
    } else {
        lines.push(Line::from(Span::styled(
            "官方请求没有可关联的命令；不猜测命令",
            Style::default().fg(theme.colors().muted),
        )));
        hits.push(None);
    }
    let allow_focused = card.focus() == ApprovalFocus::Allow;
    let reject_focused = card.focus() == ApprovalFocus::Reject;
    lines.push(option_line(
        allow_focused,
        "1.",
        "允许一次",
        None,
        false,
        theme,
    ));
    hits.push(Some(DecisionClick::ApprovalAllow));
    lines.push(Line::from(Span::styled(
        "     仅本次；不更改后续权限",
        Style::default().fg(theme.colors().muted),
    )));
    hits.push(Some(DecisionClick::ApprovalAllow));
    lines.push(option_line(
        reject_focused,
        "2.",
        "拒绝",
        None,
        false,
        theme,
    ));
    hits.push(Some(DecisionClick::ApprovalReject));
    lines.push(Line::from(Span::styled(
        "     不执行本次操作",
        Style::default().fg(theme.colors().muted),
    )));
    hits.push(Some(DecisionClick::ApprovalReject));
    let mut footer = String::from("↑↓ 切换 · Enter 确认 · Esc 取消");
    if command_rows.len() > available {
        footer.push_str(" · PgUp/PgDn");
    }
    lines.push(Line::from(Span::styled(
        footer,
        Style::default().fg(theme.colors().muted),
    )));
    hits.push(None);
    if let ApprovalCardState::Settled(outcome) = card.state() {
        lines.push(Line::from(Span::styled(
            outcome.label().to_string(),
            Style::default().fg(theme.colors().muted),
        )));
        hits.push(None);
    } else if let Some(notice) = card.notice() {
        lines.push(Line::from(Span::styled(
            notice.to_string(),
            Style::default().fg(theme.colors().warning),
        )));
        hits.push(None);
    }
    (title, lines, hits)
}

fn capped_rows(text: &str, width: usize, max_rows: usize) -> Vec<String> {
    let mut rows = display_rows(text, width);
    if rows.len() > max_rows {
        rows.truncate(max_rows);
        if let Some(last) = rows.last_mut() {
            *last = format!("{}…", truncate(last, width.saturating_sub(1)));
        }
    }
    rows
}

fn question_footer(card: &QuestionCard, question: &nano_decisions::Question) -> String {
    let action = if question.multi_select {
        "空格勾选 · Enter 确认"
    } else {
        "Enter 选择"
    };
    let mut footer = format!("↑↓ 移动 · {action} · Alt+N 跳过 · Alt+T 停止计时 · Esc 收起");
    if let Some(remaining) = card.timed().remaining_at(Instant::now()) {
        footer.push_str(&format!(" · 剩 {}", format_duration(remaining)));
    } else if card.timed().indefinite {
        footer.push_str(" · 计时已停");
    }
    footer
}

fn submit_footer(card: &QuestionCard) -> String {
    let mut footer = String::from("Enter 提交 · Tab/←→ 回看 · Esc 收起");
    if let Some(remaining) = card.timed().remaining_at(Instant::now()) {
        footer.push_str(&format!(" · 剩 {}", format_duration(remaining)));
    } else if card.timed().indefinite {
        footer.push_str(" · 计时已停");
    }
    footer
}

fn render_question(
    card: &QuestionCard,
    area: Rect,
    theme: Theme,
) -> (String, Vec<Line<'static>>, Vec<Option<DecisionClick>>) {
    let width = area.width.max(1) as usize;
    if card.state() == QuestionCardState::ReadOnly {
        return render_read_only(card, area, theme);
    }
    if card.plan_review().is_some() {
        return render_plan_review(card, area, theme);
    }
    let title = if card.timed().continued {
        " 问卷 · 可继续回答 ".to_string()
    } else if card.timed().remaining_ms.is_some() {
        " 问卷 · 限时 ".to_string()
    } else {
        " 问卷 ".to_string()
    };
    let mut lines = Vec::new();
    let mut hits = Vec::new();
    if card.questions().len() > 1 {
        let mut tabs = Vec::new();
        for (index, question) in card.questions().iter().enumerate() {
            let current = index == card.page();
            let answered = card.skipped(index)
                || card
                    .draft(index)
                    .map(|draft| !draft.selected.is_empty() || !draft.custom.trim().is_empty())
                    .unwrap_or(false);
            let label = question
                .header
                .clone()
                .unwrap_or_else(|| format!("{}", index + 1));
            tabs.push(Span::styled(
                format!("{}{} ", if answered { "[x]" } else { "[ ]" }, label),
                if current {
                    Style::default()
                        .fg(theme.colors().accent)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(theme.colors().muted)
                },
            ));
        }
        tabs.push(Span::styled(
            format!(
                "{}{} ",
                if card.page() == card.questions().len() {
                    "[x]"
                } else {
                    "[ ]"
                },
                "提交"
            ),
            if card.page() == card.questions().len() {
                Style::default()
                    .fg(theme.colors().accent)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme.colors().muted)
            },
        ));
        lines.push(Line::from(tabs));
        hits.push(Some(DecisionClick::QuestionPrev));
    }
    if card.page() == card.questions().len() {
        lines.push(Line::from(Span::styled(
            "提交这组答案",
            Style::default().add_modifier(Modifier::BOLD),
        )));
        hits.push(None);
        for (index, question) in card.questions().iter().enumerate() {
            let answer = card.review_answers().get(index).cloned();
            let text = answer
                .as_ref()
                .map(answer_text)
                .unwrap_or_else(|| "尚未回答".to_string());
            lines.push(Line::from(vec![
                Span::styled(
                    if text == "尚未回答" || text == "（跳过）" {
                        "[ ] "
                    } else {
                        "[x] "
                    },
                    Style::default().fg(theme.colors().muted),
                ),
                Span::styled(
                    question
                        .header
                        .clone()
                        .unwrap_or_else(|| question.id.clone()),
                    Style::default().add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  {text}"),
                    Style::default().fg(theme.colors().muted),
                ),
            ]));
            hits.push(Some(DecisionClick::QuestionOption(index)));
        }
        for row in display_rows(&submit_footer(card), width) {
            lines.push(Line::from(Span::styled(
                row,
                Style::default().fg(theme.colors().muted),
            )));
            hits.push(Some(DecisionClick::QuestionSubmit));
        }
    } else if let Some(question) = card.questions().get(card.page()) {
        for row in capped_rows(&question.question, width, 3) {
            lines.push(Line::from(Span::styled(
                row,
                Style::default().add_modifier(Modifier::BOLD),
            )));
            hits.push(None);
        }
        let draft = card.draft(card.page()).cloned().unwrap_or_default();
        for (index, option) in question.options.iter().enumerate() {
            let focused = card.focus() == index;
            let selected = draft.selected.iter().any(|label| label == &option.label);
            lines.push(option_line(
                focused,
                &format!("{}.", index + 1),
                &option.label,
                if question.multi_select {
                    Some(selected)
                } else {
                    None
                },
                selected,
                theme,
            ));
            hits.push(Some(DecisionClick::QuestionOption(index)));
            if let Some(description) = &option.description {
                let rows = display_rows(description, width.saturating_sub(5));
                let mut row = rows.first().cloned().unwrap_or_default();
                if rows.len() > 1 {
                    row = format!("{}…", truncate(&row, width.saturating_sub(6)));
                }
                lines.push(Line::from(Span::styled(
                    format!("     {row}"),
                    Style::default().fg(theme.colors().muted),
                )));
                hits.push(Some(DecisionClick::QuestionOption(index)));
            }
        }
        let other_focused = card.focus() == question.options.len();
        let caret = if other_focused { "|" } else { "" };
        lines.push(Line::from(vec![
            Span::styled(
                format!("{} ", if other_focused { ">" } else { " " }),
                Style::default().fg(theme.colors().accent),
            ),
            Span::styled(
                format!("{}. ", question.options.len() + 1),
                Style::default().fg(theme.colors().muted),
            ),
            Span::raw("其他："),
            Span::styled(
                format!("{}{caret}", draft.custom),
                Style::default().fg(theme.colors().warning),
            ),
        ]));
        hits.push(Some(DecisionClick::QuestionOther));
        for row in display_rows(&question_footer(card, question), width) {
            lines.push(Line::from(Span::styled(
                row,
                Style::default().fg(theme.colors().muted),
            )));
            hits.push(Some(DecisionClick::QuestionSkip));
        }
    }
    if let Some(error) = card.error() {
        lines.push(Line::from(Span::styled(
            error.to_string(),
            Style::default().fg(theme.colors().error),
        )));
        hits.push(None);
    }
    if let Some(notice) = card.notice() {
        lines.push(Line::from(Span::styled(
            notice.to_string(),
            Style::default().fg(theme.colors().muted),
        )));
        hits.push(None);
    }
    (title, lines, hits)
}

fn render_plan_review(
    card: &QuestionCard,
    area: Rect,
    theme: Theme,
) -> (String, Vec<Line<'static>>, Vec<Option<DecisionClick>>) {
    let width = area.width.saturating_sub(4) as usize;
    let question = &card.questions()[0];
    let intent = question.plan_review().unwrap();
    let title = " 计划审阅 ".to_string();
    let mut lines = Vec::new();
    let mut hits = Vec::new();
    let summary = question
        .detail
        .as_deref()
        .unwrap_or("")
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    lines.push(Line::from(Span::styled(
        format!("计划：{}", elide_plain(&summary, width)),
        Style::default().add_modifier(Modifier::BOLD),
    )));
    hits.push(Some(DecisionClick::PlanView));
    lines.push(Line::from(Span::styled(
        format!("批准选项：{}", intent.approve),
        Style::default().fg(theme.colors().muted),
    )));
    hits.push(None);
    if card.plan_expanded() {
        if let Some(detail) = question.detail.as_deref() {
            let rows = display_rows(detail, width);
            for row in rows.iter().skip(card.detail_offset()).take(10) {
                lines.push(Line::from(Span::styled(
                    row.clone(),
                    Style::default().fg(theme.colors().muted),
                )));
                hits.push(None);
            }
        }
    }
    let view_focused = card.plan_focus() == PlanFocus::View;
    let changes_focused = card.plan_focus() == PlanFocus::RequestChanges;
    let approve_focused = card.plan_focus() == PlanFocus::Approve;
    lines.push(option_line(
        view_focused,
        "1.",
        if card.plan_expanded() {
            "收起完整计划"
        } else {
            "查看完整计划"
        },
        None,
        false,
        theme,
    ));
    hits.push(Some(DecisionClick::PlanView));
    lines.push(option_line(
        changes_focused,
        "2.",
        "请求修改",
        None,
        false,
        theme,
    ));
    hits.push(Some(DecisionClick::PlanRequestChanges));
    lines.push(Line::from(Span::styled(
        "     取消本次等待，回到输入框说明修改（不提交批准）",
        Style::default().fg(theme.colors().muted),
    )));
    hits.push(Some(DecisionClick::PlanRequestChanges));
    lines.push(option_line(
        approve_focused,
        "3.",
        "批准",
        None,
        false,
        theme,
    ));
    hits.push(Some(DecisionClick::PlanApprove));
    lines.push(Line::from(Span::styled(
        "     返回官方批准标签",
        Style::default().fg(theme.colors().muted),
    )));
    hits.push(Some(DecisionClick::PlanApprove));
    lines.push(Line::from(Span::styled(
        "↑↓ 选择 · Enter 确认 · Esc 取消（不会批准）",
        Style::default().fg(theme.colors().muted),
    )));
    hits.push(None);
    (title, lines, hits)
}

fn render_read_only(
    card: &QuestionCard,
    area: Rect,
    theme: Theme,
) -> (String, Vec<Line<'static>>, Vec<Option<DecisionClick>>) {
    let width = area.width.saturating_sub(4) as usize;
    let title = " 问卷回看 · 只读 ".to_string();
    let mut lines = Vec::new();
    let mut hits = Vec::new();
    for (index, question) in card.questions().iter().enumerate() {
        let skipped = card.skipped(index);
        lines.push(Line::from(Span::styled(
            question
                .header
                .clone()
                .unwrap_or_else(|| question.question.clone()),
            Style::default().add_modifier(Modifier::BOLD),
        )));
        hits.push(None);
        if question.header.is_some() {
            for row in display_rows(&question.question, width) {
                lines.push(Line::from(Span::styled(
                    row,
                    Style::default().fg(theme.colors().muted),
                )));
                hits.push(None);
            }
        }
        let answer = card
            .draft(index)
            .map(|draft| {
                answer_text(&nano_decisions::AnswerItem {
                    id: question.id.clone(),
                    selected: draft.selected.clone(),
                    custom: Some(draft.custom.clone()).filter(|text| !text.trim().is_empty()),
                })
            })
            .unwrap_or_else(|| "（未记录）".to_string());
        let text = if skipped {
            "（跳过）".to_string()
        } else {
            answer
        };
        for row in display_rows(&format!("  {text}"), width) {
            lines.push(Line::from(Span::styled(
                row,
                Style::default().fg(theme.colors().muted),
            )));
            hits.push(None);
        }
    }
    lines.push(Line::from(Span::styled(
        "Esc 关闭",
        Style::default().fg(theme.colors().muted),
    )));
    hits.push(Some(DecisionClick::QuestionSubmit));
    (title, lines, hits)
}

fn option_line(
    focused: bool,
    number: &str,
    label: &str,
    checkbox: Option<bool>,
    selected: bool,
    theme: Theme,
) -> Line<'static> {
    let colors = theme.colors();
    let mut spans = vec![
        Span::styled(
            format!("{} ", if focused { ">" } else { " " }),
            Style::default().fg(colors.accent),
        ),
        Span::styled(format!("{number} "), Style::default().fg(colors.muted)),
    ];
    if let Some(checked) = checkbox {
        spans.push(Span::styled(
            format!("{} ", if checked { "[x]" } else { "[ ]" }),
            Style::default().fg(colors.muted),
        ));
    }
    let label_style = if focused {
        Style::default()
            .fg(colors.accent)
            .add_modifier(Modifier::BOLD)
    } else if selected {
        Style::default().fg(colors.success)
    } else {
        Style::default()
    };
    spans.push(Span::styled(label.to_string(), label_style));
    if checkbox.is_none() && selected {
        spans.push(Span::styled(" ✓", Style::default().fg(colors.success)));
    }
    Line::from(spans)
}

fn answer_text(answer: &nano_decisions::AnswerItem) -> String {
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

fn elide_plain(text: &str, width: usize) -> String {
    let text = text.replace('\n', " ");
    if text.chars().count() <= width {
        return text;
    }
    let mut value: String = text.chars().take(width.saturating_sub(1)).collect();
    value.push('…');
    value
}

fn display_rows(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut rows = Vec::new();
    for line in text.split('\n') {
        let line = line.replace('\r', "");
        if line.is_empty() {
            rows.push(String::new());
            continue;
        }
        let mut current = String::new();
        let mut used = 0usize;
        for character in line.chars() {
            let character_width = UnicodeWidthChar::width(character).unwrap_or(0);
            if used + character_width > width && !current.is_empty() {
                rows.push(std::mem::take(&mut current));
                used = 0;
            }
            current.push(character);
            used += character_width;
        }
        if !current.is_empty() {
            rows.push(current);
        }
    }
    if rows.is_empty() {
        rows.push(String::new());
    }
    rows
}

fn format_duration(duration: std::time::Duration) -> String {
    let seconds = duration.as_secs();
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

fn draw_queue(frame: &mut Frame, app: &App, area: Rect) {
    let focused = !app.scene.focus().input_focused();
    let total = app.model.inbox().total_count();
    let preview = if app.model.inbox().truncated {
        format!(" · 预览 {}/{}", app.model.inbox().len(), total)
    } else {
        String::new()
    };
    let title = format!(
        " 队列{}{} · 官方 inbox · {} 项（Alt+↑↓ 选择，Alt+E 编辑，Alt+D 删除，Alt+S 插话，Alt+X 清空并停止） ",
        if focused { "（焦点）" } else { "" },
        preview,
        total
    );
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(app.theme.border_style())
        .title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let items: Vec<_> = app.model.inbox().iter().collect();
    let visible = 4.min(items.len());
    let start = if items.len() <= visible {
        0
    } else {
        app.queue_selected
            .saturating_sub(visible.saturating_sub(1))
            .min(items.len() - visible)
    };
    let mut lines = Vec::new();
    for (offset, item) in items.iter().skip(start).take(visible).enumerate() {
        let index = start + offset;
        let selected = index == app.queue_selected;
        let marker = if selected { "▶" } else { " " };
        let text = truncate(&item.text.replace('\n', " "), 120);
        let style = if selected {
            Style::default()
                .fg(app.theme.colors().fg)
                .bg(app.theme.colors().selected_bg)
        } else {
            Style::default()
        };
        lines.push(Line::from(Span::styled(
            format!("{marker} [{}] {text}", item.target.label()),
            style,
        )));
    }
    frame.render_widget(Paragraph::new(Text::from(lines)), inner);
}

fn input_notice(app: &App) -> Option<(String, Color)> {
    if app.shell_confirm.is_some() {
        Some((
            "人工命令（用户权限，不是 Agent 授权）· Enter 执行 · Esc 取消".to_string(),
            app.theme.colors().warning,
        ))
    } else if app.picker.is_some() {
        Some((
            "附加文件 · 输入路径 · Enter 确认 · Esc 取消".to_string(),
            app.theme.colors().muted,
        ))
    } else if let Some(message_id) = app.editing_queue() {
        Some((
            format!("编辑队列项 {message_id} · Enter 应用 · Esc 取消"),
            app.theme.colors().muted,
        ))
    } else if app.subagent_active() {
        let gate = app
            .subagents
            .mounted_gate()
            .unwrap_or(ComposerGate::Resolving);
        if gate.can_send() {
            None
        } else {
            Some((
                format!("子代理 · {}", gate.hint()),
                app.theme.colors().warning,
            ))
        }
    } else {
        None
    }
}

pub(crate) fn input_text_width(width: u16) -> usize {
    width.saturating_sub(3).max(1) as usize
}

fn input_height(app: &App, width: u16) -> u16 {
    let notice = u16::from(input_notice(app).is_some());
    if app.picker.is_some() {
        return 2 + notice + 1;
    }
    let attachments = attachment_lines(app).len() as u16;
    let text_rows = wrapped_input_rows(app, input_text_width(width) as u16).clamp(1, 8) as u16;
    (2 + notice + attachments + text_rows).min(14)
}

/// The top and bottom composer lines. The left segment shows context
/// occupancy; the rest stays the plain rule so the fill is always visible.
fn draw_input_border(frame: &mut Frame, row: Rect, occupancy: Occupancy, theme: Theme) {
    let colors = theme.colors();
    let width = row.width as usize;
    let (segment, style) = match occupancy {
        Occupancy::Known { projected, window } if window > 0 => {
            let percent = projected.saturating_mul(100) / window;
            let color = if percent >= 95 {
                colors.error
            } else if percent >= 80 {
                colors.warning
            } else {
                colors.accent
            };
            let cells = ((width as u64).saturating_mul(projected.min(window)) / window) as usize;
            (cells.min(width), Style::default().fg(color))
        }
        _ => (0, Style::default()),
    };
    let mut spans = Vec::new();
    if segment > 0 {
        spans.push(Span::styled("─".repeat(segment), style));
    }
    if segment < width {
        spans.push(Span::styled(
            "─".repeat(width - segment),
            Style::default().fg(colors.rule),
        ));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), row);
}

fn draw_input(frame: &mut Frame, app: &mut App, area: Rect) {
    let gate = if app.subagent_active() {
        app.subagents
            .mounted_gate()
            .unwrap_or(ComposerGate::Resolving)
    } else {
        ComposerGate::Enabled
    };
    let sendable = gate.can_send();
    let occupancy = if app.subagent_active() {
        // The root meter does not describe the mounted child conversation.
        Occupancy::Unknown
    } else {
        app.context
            .as_ref()
            .map(|meter| meter.occupancy())
            .unwrap_or(Occupancy::Unknown)
    };
    app.send_area = Rect::default();
    let focused = app.scene.focus().input_focused();
    let prompt_style = if focused {
        Style::default()
            .fg(app.theme.colors().accent)
            .add_modifier(Modifier::BOLD)
    } else {
        muted_style(app.theme)
    };
    if area.height >= 2 {
        draw_input_border(frame, Rect { height: 1, ..area }, occupancy, app.theme);
        draw_input_border(
            frame,
            Rect {
                y: area.y.saturating_add(area.height - 1),
                height: 1,
                ..area
            },
            occupancy,
            app.theme,
        );
    }
    let inner = Rect::new(
        area.x,
        area.y.saturating_add(1),
        area.width,
        area.height.saturating_sub(2),
    );
    let width = inner.width.max(1) as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut cursor: Option<(usize, usize)> = None;
    let mut send_start: Option<usize> = None;
    let mut draft_rows = 0usize;
    if let Some((notice, color)) = input_notice(app) {
        lines.push(Line::from(Span::styled(
            truncate(&notice, width),
            Style::default().fg(color),
        )));
    }
    if let Some(picker) = &app.picker {
        let prefix = "路径：";
        let text = format!("{prefix}{}", picker.path);
        lines.push(Line::from(vec![
            Span::styled(prefix, muted_style(app.theme)),
            Span::raw(picker.path.clone()),
        ]));
        cursor = Some((lines.len() - 1, text.chars().map(display_width).sum()));
    } else {
        for (text, color) in attachment_lines(app) {
            lines.push(Line::from(Span::styled(text, Style::default().fg(color))));
        }
        let draft = app.drafts.current().text();
        if sendable {
            let text_width = input_text_width(area.width);
            let start = lines.len();
            send_start = Some(start);
            if draft.is_empty() {
                // Keep the same stable `> ` start whether or not a draft
                // exists; an empty composer must not show a vanishing hint.
                lines.push(Line::from(Span::styled("> ", prompt_style)));
                cursor = Some((start, 2));
                draft_rows = 1;
            } else {
                let (row, column) = input_cursor(app, text_width);
                let styled = input_styled_lines(app, text_width);
                draft_rows = styled.len();
                for (index, line) in styled.into_iter().enumerate() {
                    let prefix = if index == 0 { "> " } else { "  " };
                    let mut spans = vec![Span::styled(prefix, prompt_style)];
                    spans.extend(line.spans);
                    lines.push(Line::from(spans));
                }
                cursor = Some((start + row, 2 + column));
            }
        } else if draft.trim().is_empty() {
            lines.push(Line::from(Span::styled(
                "只读记录 · 没有可用的输入框",
                muted_style(app.theme),
            )));
        } else {
            for text in input_lines(app, width) {
                lines.push(Line::from(Span::styled(text, muted_style(app.theme))));
            }
        }
    }
    let viewport = inner.height as usize;
    let offset = match cursor {
        Some((row, _)) if viewport > 0 => row.saturating_sub(viewport.saturating_sub(1)),
        _ => 0,
    };
    app.input_area = inner;
    app.input_scroll = offset;
    app.input_draft_top = send_start.unwrap_or(0);
    app.input_draft_rows = if send_start.is_some() { draft_rows } else { 0 };
    // The send button rides the first visible draft row, so a long draft that
    // scrolls its first line out of view still shows a reachable button.
    if let (true, Some(start)) = (sendable, send_start) {
        if viewport > 0 {
            let visible_row = start.saturating_sub(offset).min(viewport - 1);
            let absolute_row = offset + visible_row;
            if let Some(line) = lines.get_mut(absolute_row) {
                let used = line.spans.iter().map(|span| span.width()).sum::<usize>();
                if used < width {
                    line.spans.push(Span::raw(" ".repeat(width - used - 1)));
                    line.spans.push(Span::styled(
                        "↑",
                        Style::default().fg(app.theme.colors().accent),
                    ));
                    app.send_area = Rect::new(
                        inner.x.saturating_add(width as u16 - 1),
                        inner.y.saturating_add(visible_row as u16),
                        1,
                        1,
                    );
                }
            }
        }
    }
    let visible: Vec<Line<'static>> = lines.into_iter().skip(offset).take(viewport).collect();
    frame.render_widget(Paragraph::new(Text::from(visible)), inner);
    if sendable && focused && !app.panel.is_open() && viewport > 0 {
        if let Some((row, column)) = cursor {
            let row = row.saturating_sub(offset).min(viewport.saturating_sub(1));
            let column = column.min(width.saturating_sub(2));
            frame.set_cursor_position((
                inner.x + column.min(u16::MAX as usize) as u16,
                inner.y + row.min(u16::MAX as usize) as u16,
            ));
        }
    }
}

/// Attachment card lines shown above the input text.
fn attachment_lines(app: &App) -> Vec<(String, Color)> {
    if app.subagent_active() && app.subagents.mounted_gate() == Some(ComposerGate::Resolving) {
        // The parent attachment draft must not appear in a child view before
        // the child's own address and draft are installed.
        return Vec::new();
    }
    if app.editing_queue().is_some() {
        // Queue edits carry only text; the draft's attachments stay in memory
        // but are not part of this edit.
        return Vec::new();
    }
    let cards = app.attachments.current().ordered_cards();
    let mut lines = Vec::new();
    for card in cards.iter().take(3) {
        let color = match &card.state {
            AttachmentState::Ready => app.theme.colors().success,
            AttachmentState::Uploading { .. } => app.theme.colors().warning,
            AttachmentState::Failed(_) | AttachmentState::Unknown(_) => app.theme.colors().error,
        };
        lines.push((format!("  {}", card.label()), color));
    }
    if cards.len() > 3 {
        lines.push((
            format!("  … 还有 {} 个附件", cards.len() - 3),
            app.theme.colors().muted,
        ));
    }
    lines
}

/// `/` command candidates above the input.
fn draw_command_completion(frame: &mut Frame, app: &App, area: Rect) {
    let title = format!(
        " 命令补全（{} 项）· ↑↓ 选择 · Tab 补全 · Enter 确认 · Esc 关闭 ",
        app.command_completion.candidates().len()
    );
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(app.theme.border_style())
        .title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let mut lines = Vec::new();
    let total = app.command_completion.candidates().len();
    let visible = total.min(6);
    let start = app
        .command_completion
        .selected()
        .saturating_sub(visible / 2)
        .min(total.saturating_sub(visible));
    let selected_style = Style::default()
        .fg(app.theme.colors().fg)
        .bg(app.theme.colors().selected_bg);
    for (index, candidate) in app
        .command_completion
        .candidates()
        .iter()
        .enumerate()
        .skip(start)
        .take(visible)
    {
        let selected = index == app.command_completion.selected();
        let base = if selected {
            selected_style
        } else if !candidate.available {
            Style::default().fg(app.theme.colors().muted)
        } else {
            Style::default()
        };
        let detail = if selected {
            selected_style
        } else {
            Style::default().fg(app.theme.colors().muted)
        };
        let mut spans = vec![Span::styled(if selected { "▶ " } else { "  " }, base)];
        spans.push(Span::styled(format!("/{}", candidate.name), base));
        if candidate.kind == crate::command_completion::CandidateKind::Skill {
            spans.push(Span::styled(" [技能]", detail));
        }
        spans.push(Span::styled("  ", detail));
        let mut description = candidate.description.clone();
        if let Some(hint) = &candidate.input_hint {
            description.push_str(" · 参数 ");
            description.push_str(hint);
        }
        spans.push(Span::styled(description, detail));
        if !candidate.available {
            if let Some(reason) = &candidate.reason {
                spans.push(Span::styled(format!(" · {reason}"), detail));
            }
        }
        lines.push(Line::from(spans));
    }
    frame.render_widget(Paragraph::new(Text::from(lines)), inner);
}

/// Completion candidates above the input: `/` commands or `@file` paths.
fn draw_completion(frame: &mut Frame, app: &App, area: Rect) {
    if app.command_completion.visible() {
        draw_command_completion(frame, app, area);
        return;
    }
    let title = format!(
        " 文件补全（{} 项）· ↑↓ 选择 · Enter/Tab 插入 · Esc 关闭 ",
        app.completion.candidates().len()
    );
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(app.theme.border_style())
        .title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let mut lines = Vec::new();
    for (index, candidate) in app.completion.candidates().iter().take(6).enumerate() {
        let selected = index == app.completion.selected();
        let marker = if selected { "▶" } else { " " };
        let suffix = match candidate.kind {
            CandidateKind::Directory => "/",
            CandidateKind::File => "",
        };
        let style = if selected {
            Style::default()
                .fg(app.theme.colors().fg)
                .bg(app.theme.colors().selected_bg)
        } else {
            Style::default()
        };
        // A filesystem path may contain control characters; never let them
        // reach the terminal as escape sequences.
        let display: String = candidate
            .path
            .chars()
            .map(|character| {
                if character.is_control() {
                    '?'
                } else {
                    character
                }
            })
            .collect();
        lines.push(Line::from(Span::styled(
            format!("{marker} {display}{suffix}"),
            style,
        )));
    }
    frame.render_widget(Paragraph::new(Text::from(lines)), inner);
}

fn draw_activity(frame: &mut Frame, app: &App, area: Rect) {
    let Some(kind) = app.activity_kind() else {
        return;
    };
    if area.height == 0 {
        return;
    }
    let glyph = if app.reduced_motion || !app.activity_phase {
        "●"
    } else {
        "○"
    };
    let color = match kind {
        ActivityKind::Running => app.theme.colors().accent,
        ActivityKind::AwaitingApproval | ActivityKind::AwaitingQuestion => {
            app.theme.colors().warning
        }
    };
    let spans = vec![
        Span::styled(format!("{glyph} "), Style::default().fg(color)),
        Span::styled(kind.label(), muted_style(app.theme)),
    ];
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn draw_status(frame: &mut Frame, app: &App, area: Rect, width: u16) {
    let width = width.max(1) as usize;
    let transient = safe_text(&app.status_transient());
    // A disconnected link or an error must stay visible even at 60 columns;
    // reserve a minimum middle slot before trimming either end.
    let critical = app.error.is_some() || !matches!(app.connection, Connection::Ready);
    let middle_min = if critical && !transient.is_empty() {
        12.min(width / 3)
    } else {
        0
    };
    let mut left = safe_text(&app.status_permission());
    if text_width(&left) > width {
        left = truncate(&left, width);
    }
    if middle_min > 0 {
        left = truncate(&left, (width / 3).max(8).min(width));
    }
    let mut right = safe_text(&app.display_path());
    let reserve = if middle_min > 0 { middle_min + 3 } else { 1 };
    let right_room = width.saturating_sub(text_width(&left) + reserve).max(1);
    if text_width(&right) > right_room {
        right = elide_left(&right, right_room);
    }
    let left_width = text_width(&left);
    let right_width = text_width(&right);
    let middle_room = width.saturating_sub(left_width + right_width + 3);
    let middle = if middle_room > 0 {
        format!("  {}", truncate(&transient, middle_room))
    } else {
        String::new()
    };
    let middle_width = text_width(&middle);
    let pad = width.saturating_sub(left_width + middle_width + right_width);
    let transient_color = if app.error.is_some() {
        app.theme.colors().error
    } else {
        app.theme.colors().muted
    };
    let spans = vec![
        Span::styled(left, muted_style(app.theme)),
        Span::styled(middle, Style::default().fg(transient_color)),
        Span::raw(" ".repeat(pad)),
        Span::styled(right, muted_style(app.theme)),
    ];
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

/// Keep the tail of a path when it does not fit, marking the cut with `…`.
fn elide_left(text: &str, width: usize) -> String {
    if text_width(text) <= width {
        return text.to_string();
    }
    if width == 0 {
        return String::new();
    }
    let mut tail = Vec::new();
    let mut used = 1usize;
    for character in text.chars().rev() {
        let character_width = display_width(character);
        if used + character_width > width {
            break;
        }
        used += character_width;
        tail.push(character);
    }
    let tail: String = tail.into_iter().rev().collect();
    format!("…{tail}")
}

/// Draw the command palette or one selection pane over the conversation.
fn draw_panel(frame: &mut Frame, app: &mut App, area: Rect) {
    let rows = app.panel.rows(&app.controls);
    app.panel.clamp(rows.len());
    let selected_index = app.panel.selected();
    let width = ((area.width as u32 * 3 / 4).clamp(40, 96)).min(area.width as u32) as u16;
    let inner_width = width.saturating_sub(4).max(1) as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();
    push_wrapped(
        &mut lines,
        &panel_header(app),
        inner_width,
        Style::default().fg(app.theme.colors().muted),
    );
    let mut selected_line = 0;
    if rows.is_empty() {
        push_wrapped(
            &mut lines,
            &empty_panel_reason(app),
            inner_width,
            Style::default().fg(app.theme.colors().warning),
        );
    } else {
        let mut previous_group: Option<String> = None;
        for (index, row) in rows.iter().enumerate() {
            if let Some(group) = row.group.as_deref() {
                if previous_group.as_deref() != Some(group) {
                    lines.push(Line::from(Span::styled(
                        group.to_string(),
                        Style::default()
                            .fg(app.theme.colors().muted)
                            .add_modifier(Modifier::BOLD),
                    )));
                    previous_group = Some(group.to_string());
                }
            }
            let selected = index == selected_index;
            if selected {
                selected_line = lines.len();
            }
            lines.push(panel_row_line(row, selected, inner_width, app.theme));
            if selected {
                if let Some(detail) = &row.detail {
                    for segment in wrap_segments(&detail.replace('\r', ""), inner_width) {
                        lines.push(Line::from(Span::styled(
                            segment.text,
                            Style::default().fg(app.theme.colors().muted),
                        )));
                    }
                }
            }
        }
    }
    let fixed_count = 1;
    let height = (lines.len() as u16 + fixed_count as u16 + 2)
        .min(area.height.saturating_sub(2))
        .max(3);
    let rect = centered(area, width, height);
    frame.render_widget(Clear, rect);
    frame.buffer_mut().set_style(rect, app.theme.base_style());
    let title = format!(
        " {} · 查询：{} ",
        app.panel.mode().title(),
        app.panel.query()
    );
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(app.theme.border_style())
        .title(title);
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let viewport = inner.height as usize;
    let list_height = viewport.saturating_sub(fixed_count).max(1);
    let offset = selected_line.saturating_sub(list_height.saturating_sub(1));
    let visible: Vec<Line<'static>> = lines.into_iter().skip(offset).take(list_height).collect();
    frame.render_widget(
        Paragraph::new(Text::from(visible)),
        Rect {
            height: list_height as u16,
            ..inner
        },
    );
    let mut fixed = Vec::new();
    fixed.push(Line::from(Span::styled(
        panel_footer(app),
        Style::default().fg(app.theme.colors().muted),
    )));
    frame.render_widget(
        Paragraph::new(Text::from(fixed)),
        Rect {
            y: inner.y.saturating_add(list_height as u16),
            height: fixed_count as u16,
            ..inner
        },
    );
}

/// Height of the anchored `/model` control layer.
fn models_panel_height(app: &App, available: u16) -> u16 {
    let rows = app.panel.rows(&app.controls).len().max(1) as u16;
    let effort_rows = match effort_area(app) {
        EffortArea::Levels { .. } => 2,
        _ => 1,
    };
    let warning_rows = u16::from(app.error.is_some());
    let minimum = 4 + effort_rows + warning_rows;
    let desired = 1 + 1 + rows + 1 + effort_rows + warning_rows;
    if available < minimum {
        available
    } else {
        desired.min(available)
    }
}

/// Draw `/model` as the bottom control layer that temporarily owns the
/// input, status, and dock band.
fn draw_models_panel(frame: &mut Frame, app: &mut App, area: Rect) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let colors = app.theme.colors();
    let width = area.width as usize;
    let rows = app.panel.rows(&app.controls);
    let selected = app.panel.selected();
    let effort = models_effort_lines(app, width);
    let warning = app.error.as_deref().map(|error| {
        Line::from(Span::styled(
            truncate(error, width),
            Style::default().fg(colors.warning),
        ))
    });
    let warning_rows = usize::from(warning.is_some());
    let mut lines = Vec::new();
    if (area.height as usize) < 4 + effort.len() + warning_rows {
        // A short terminal cannot hold the rules and the list; keep the header,
        // any panel-level error, the visible row, and the labels that make the
        // bar readable.
        lines.push(models_header_line(app, width));
        if let Some(warning) = warning {
            lines.push(warning);
        }
        let extra = (area.height as usize).saturating_sub(lines.len());
        let list_budget = extra.saturating_sub(effort.len());
        if list_budget > 0 {
            if rows.is_empty() {
                lines.push(Line::from(Span::styled(
                    truncate(&empty_panel_reason(app), width),
                    Style::default().fg(colors.warning),
                )));
            } else {
                let duplicates = duplicate_label_flags(&rows);
                let offset = selected.saturating_sub(list_budget.saturating_sub(1));
                for (index, row) in rows.iter().enumerate().skip(offset).take(list_budget) {
                    lines.push(models_row_line(
                        row,
                        index == selected,
                        width,
                        colors,
                        duplicates.get(index).copied().unwrap_or(false),
                    ));
                }
            }
        }
        let total_effort = effort.len();
        let keep = extra.min(total_effort);
        if keep > 0 {
            lines.extend(effort.into_iter().skip(total_effort - keep));
        }
        frame.render_widget(Paragraph::new(Text::from(lines)), area);
        return;
    }
    let fixed = 3 + warning_rows + effort.len();
    let list_height = (area.height as usize).saturating_sub(fixed).max(1);
    let offset = selected.saturating_sub(list_height.saturating_sub(1));
    lines.push(Line::from(Span::styled(
        "─".repeat(width),
        Style::default().fg(colors.accent),
    )));
    lines.push(models_header_line(app, width));
    if let Some(warning) = warning {
        lines.push(warning);
    }
    if rows.is_empty() {
        lines.push(Line::from(Span::styled(
            truncate(&empty_panel_reason(app), width),
            Style::default().fg(colors.warning),
        )));
    } else {
        let duplicates = duplicate_label_flags(&rows);
        for (index, row) in rows.iter().enumerate().skip(offset).take(list_height) {
            lines.push(models_row_line(
                row,
                index == selected,
                width,
                colors,
                duplicates.get(index).copied().unwrap_or(false),
            ));
        }
    }
    while lines.len() < 2 + warning_rows + list_height {
        lines.push(Line::from(""));
    }
    lines.push(Line::from(Span::styled(
        "─".repeat(width),
        Style::default().fg(colors.rule),
    )));
    lines.extend(effort);
    frame.render_widget(Paragraph::new(Text::from(lines)), area);
}

/// Which official effort choices the focused model advertises.
enum EffortArea {
    /// The focused row is unavailable or is not a model.
    Disabled,
    /// The route advertises no reasoning metadata.
    Unavailable,
    /// Official efforts in adapter order; `None` means the default state.
    Levels {
        levels: Vec<(String, String)>,
        selected: Option<usize>,
    },
}

fn effort_area(app: &App) -> EffortArea {
    let rows = app.panel.rows(&app.controls);
    let Some(row) = rows.get(app.panel.selected()) else {
        return EffortArea::Disabled;
    };
    if row.disabled.is_some() {
        return EffortArea::Disabled;
    }
    let (provider, model) = match &row.action {
        PanelAction::SelectModel {
            provider, model, ..
        } => (provider.as_str(), model.as_str()),
        _ => return EffortArea::Disabled,
    };
    let Some(model) = app
        .controls
        .catalog()
        .and_then(|catalog| catalog.find(provider, model))
    else {
        return EffortArea::Disabled;
    };
    let Some(reasoning) = &model.reasoning else {
        return EffortArea::Unavailable;
    };
    if reasoning.efforts.is_empty() {
        return EffortArea::Unavailable;
    }
    let selected = app.panel.effort().and_then(|current| {
        reasoning
            .efforts
            .iter()
            .position(|effort| effort.id == current)
    });
    EffortArea::Levels {
        levels: reasoning
            .efforts
            .iter()
            .map(|effort| (effort.id.clone(), effort.name.clone()))
            .collect(),
        selected,
    }
}

fn models_effort_lines(app: &App, width: usize) -> Vec<Line<'static>> {
    let colors = app.theme.colors();
    match effort_area(app) {
        EffortArea::Disabled => vec![Line::from(Span::styled(
            "强度：—",
            Style::default().fg(colors.muted),
        ))],
        EffortArea::Unavailable => vec![Line::from(Span::styled(
            "强度：该模型未声明（不可调）",
            Style::default().fg(colors.muted),
        ))],
        EffortArea::Levels { levels, selected } => {
            let sweep = is_sweep_level(&levels, selected);
            let phase = effort_phase(app, sweep);
            vec![
                effort_bar_line(app, &levels, selected, width, phase, sweep),
                effort_labels_line(&levels, selected, width, colors, phase, app.reduced_motion),
            ]
        }
    }
}

/// The original design's linear sweep period.
const SWEEP_PERIOD_MS: u64 = 1400;

/// The sweep level is the second-highest official effort (index `len - 2`)
/// when the set has at least three levels and that level is not `Max`.
fn sweep_level(levels: &[(String, String)]) -> Option<usize> {
    if levels.len() < 3 {
        return None;
    }
    let index = levels.len() - 2;
    if levels[index].0.eq_ignore_ascii_case("max") {
        None
    } else {
        Some(index)
    }
}

fn is_sweep_level(levels: &[(String, String)], selected: Option<usize>) -> bool {
    selected.is_some_and(|index| sweep_level(levels) == Some(index))
}

fn is_max_level(levels: &[(String, String)], selected: Option<usize>) -> bool {
    selected
        .and_then(|index| levels.get(index))
        .is_some_and(|(id, _)| id.eq_ignore_ascii_case("max"))
}

fn effort_phase(app: &App, sweep: bool) -> u64 {
    if app.reduced_motion {
        return 0;
    }
    let start = if sweep {
        app.sweep_anim_start
    } else {
        Some(app.effort_anim_start)
    };
    start.map_or(0, |start| start.elapsed().as_millis() as u64)
}

/// One cell-high bar. The unfilled track uses the rule role; the filled part
/// uses the official level role. The sweep level (the second-highest effort)
/// sweeps a highlight and `Max` pulses between two palette shades; reduced
/// motion freezes both.
fn effort_bar_line(
    app: &App,
    levels: &[(String, String)],
    selected: Option<usize>,
    width: usize,
    phase: u64,
    sweep: bool,
) -> Line<'static> {
    let colors = app.theme.colors();
    let level_id = selected.map(|index| levels[index].0.as_str()).unwrap_or("");
    let filled = match selected {
        Some(index) if levels.len() > 1 => {
            ((index as f64 / (levels.len() - 1) as f64) * width as f64).round() as usize
        }
        Some(_) => width,
        None => 0,
    };
    let highlight = if !app.reduced_motion && sweep && filled > 0 {
        let radius = (filled as f32 * 0.25).max(1.0);
        let progress = (phase % SWEEP_PERIOD_MS) as f32 / SWEEP_PERIOD_MS as f32;
        Some((progress * filled as f32, radius))
    } else {
        None
    };
    let pulse = if !app.reduced_motion && level_id.eq_ignore_ascii_case("max") {
        effort_pulse(phase)
    } else {
        0.0
    };
    let fill_style = |column: usize| -> Style {
        let base = if sweep {
            colors.effort_xhigh
        } else {
            match level_id.to_ascii_lowercase().as_str() {
                "low" => colors.muted,
                "high" => colors.effort_high,
                "xhigh" => colors.effort_xhigh,
                "max" => mix_color(colors.effort_max, colors.effort_max_bright, pulse),
                _ => colors.muted,
            }
        };
        let color = match highlight {
            Some((center, radius)) => {
                let span = filled as f32;
                let mut distance = (column as f32 + 0.5 - center).abs();
                if distance > span / 2.0 {
                    distance = span - distance;
                }
                let intensity = (1.0 - distance / radius).clamp(0.0, 1.0);
                mix_color(base, colors.effort_xhigh_highlight, intensity)
            }
            None => base,
        };
        Style::default().bg(color)
    };
    let track = Style::default().bg(colors.rule);
    if width == 0 {
        return Line::from("");
    }
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut start = 0usize;
    let mut current = if filled > 0 { fill_style(0) } else { track };
    for column in 1..=width {
        let style = if column == width || column >= filled {
            track
        } else {
            fill_style(column)
        };
        if style != current {
            spans.push(Span::styled(" ".repeat(column - start), current));
            start = column;
            current = style;
        }
    }
    if start < width {
        spans.push(Span::styled(" ".repeat(width - start), current));
    }
    Line::from(spans)
}

/// Official labels positioned over the same anchors as the bar fill.
fn effort_labels_line(
    levels: &[(String, String)],
    selected: Option<usize>,
    width: usize,
    colors: &nano_theme::Palette,
    phase: u64,
    reduced_motion: bool,
) -> Line<'static> {
    if width == 0 {
        return Line::from("");
    }
    let mut cells = vec![' '; width];
    let mut styles = vec![Style::default().fg(colors.muted); width];
    let mut covered = vec![false; width];
    let mut placed_end = 0usize;
    for index in 0..levels.len() {
        if selected == Some(index) {
            continue;
        }
        let name = &levels[index].1;
        let (start, end) = label_span(name, index, levels.len(), width);
        if placed_end > 0 && start <= placed_end {
            continue;
        }
        write_label(
            &mut cells,
            &mut styles,
            &mut covered,
            name,
            start,
            Style::default().fg(colors.muted),
        );
        placed_end = end;
    }
    if let Some(index) = selected {
        let name = &levels[index].1;
        let (start, _) = label_span(name, index, levels.len(), width);
        let id = levels[index].0.to_ascii_lowercase();
        let color = if id == "max" {
            if reduced_motion {
                colors.effort_max_label
            } else {
                mix_color(
                    colors.effort_max_label,
                    colors.fg,
                    effort_pulse(phase) * 0.45,
                )
            }
        } else {
            colors.accent
        };
        write_label(
            &mut cells,
            &mut styles,
            &mut covered,
            name,
            start,
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        );
    }
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut run = String::new();
    let mut current = styles[0];
    for x in 0..width {
        if covered[x] {
            continue;
        }
        if styles[x] != current && !run.is_empty() {
            spans.push(Span::styled(std::mem::take(&mut run), current));
            current = styles[x];
        }
        run.push(cells[x]);
    }
    if !run.is_empty() {
        spans.push(Span::styled(run, current));
    }
    if spans.is_empty() {
        spans.push(Span::raw(""));
    }
    Line::from(spans)
}

fn label_span(name: &str, index: usize, count: usize, width: usize) -> (usize, usize) {
    let len = text_width(name).min(width);
    if width == 0 {
        return (0, 0);
    }
    let start = if count <= 1 {
        width.saturating_sub(len) / 2
    } else if index == 0 {
        0
    } else if index + 1 == count {
        width.saturating_sub(len)
    } else {
        let anchor = ((index as f64 / (count - 1) as f64) * (width.saturating_sub(1)) as f64)
            .round() as usize;
        anchor.saturating_sub(len / 2)
    };
    let start = start.min(width.saturating_sub(len));
    (start, start + len)
}

fn write_label(
    cells: &mut [char],
    styles: &mut [Style],
    covered: &mut [bool],
    name: &str,
    start: usize,
    style: Style,
) {
    let span = text_width(name).min(cells.len().saturating_sub(start));
    let mut clear_start = start;
    while clear_start > 0 && covered[clear_start] {
        clear_start -= 1;
    }
    let clear_end = (start + span).min(cells.len());
    for index in clear_start..clear_end {
        covered[index] = false;
        cells[index] = ' ';
        styles[index] = style;
    }
    let mut x = start;
    for character in name.chars() {
        let character_width = character.width().unwrap_or(0);
        if character_width == 0 {
            continue;
        }
        if x + character_width > cells.len() {
            break;
        }
        cells[x] = character;
        styles[x] = style;
        for offset in 1..character_width {
            covered[x + offset] = true;
        }
        x += character_width;
    }
}

fn effort_pulse(phase: u64) -> f32 {
    let period = 1200.0;
    let angle = (phase as f64 % period) / period * std::f64::consts::TAU;
    ((1.0 - angle.cos()) / 2.0) as f32
}

fn mix_color(from: Color, to: Color, factor: f32) -> Color {
    match (from, to) {
        (Color::Rgb(fr, fg, fb), Color::Rgb(tr, tg, tb)) => {
            let factor = factor.clamp(0.0, 1.0);
            let blend =
                |a: u8, b: u8| -> u8 { (a as f32 + (b as f32 - a as f32) * factor).round() as u8 };
            Color::Rgb(blend(fr, tr), blend(fg, tg), blend(fb, tb))
        }
        _ => from,
    }
}

/// `true` when this row shares its label with another provider's row, so the
/// provider name must be appended to keep the two choices distinct.
fn duplicate_label_flags(rows: &[PanelRow]) -> Vec<bool> {
    rows.iter()
        .map(|row| {
            row.group.is_some() && rows.iter().filter(|other| other.label == row.label).count() > 1
        })
        .collect()
}

fn models_row_line(
    row: &PanelRow,
    selected: bool,
    width: usize,
    colors: &nano_theme::Palette,
    show_provider: bool,
) -> Line<'static> {
    let marker = if selected { "▶ " } else { "  " };
    let style = if row.disabled.is_some() {
        Style::default().fg(colors.muted)
    } else if selected {
        Style::default()
            .fg(colors.accent)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(colors.fg)
    };
    let base = truncate(&format!("{marker}{}", row.label), width);
    let mut used = text_width(&base);
    let mut spans = vec![Span::styled(base, style)];
    if used < width {
        if show_provider {
            if let Some(group) = &row.group {
                let suffix = truncate(&format!(" · {group}"), width - used);
                used += text_width(&suffix);
                spans.push(Span::styled(suffix, Style::default().fg(colors.muted)));
            }
        }
    }
    if used < width {
        if let Some(reason) = &row.disabled {
            let suffix = truncate(&format!(" · {reason}"), width - used);
            spans.push(Span::styled(suffix, Style::default().fg(colors.muted)));
        }
    }
    Line::from(spans)
}

fn models_header_line(app: &App, width: usize) -> Line<'static> {
    let colors = app.theme.colors();
    let left = "模型";
    let right = models_header_text(app);
    let left_width = text_width(left);
    let right = truncate(&right, width.saturating_sub(left_width + 2).max(1));
    let gap = width.saturating_sub(left_width + text_width(&right)).max(1);
    Line::from(vec![
        Span::styled(
            left.to_string(),
            Style::default()
                .fg(colors.accent)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" ".repeat(gap)),
        Span::styled(right, Style::default().fg(colors.muted)),
    ])
}

fn models_header_text(app: &App) -> String {
    let mut text = format!(
        "当前：{} · {}",
        current_model_label(app),
        current_effort_label(app)
    );
    if let Some(suffix) = stale_suffix(app) {
        text.push_str(suffix);
    }
    text
}

/// The current model's display name. The provider is appended only when two
/// catalog models share the same name and the identity would be ambiguous.
fn current_model_label(app: &App) -> String {
    let Some(selection) = app.controls.model.next.as_ref() else {
        return app.controls.model_label();
    };
    let Some(catalog) = app.controls.catalog() else {
        return app.controls.model_label();
    };
    let Some(model) = catalog.find(&selection.provider, &selection.model) else {
        return app.controls.model_label();
    };
    let duplicate = catalog
        .groups
        .iter()
        .flat_map(|group| group.models.iter())
        .filter(|candidate| candidate.name == model.name)
        .count()
        > 1;
    if duplicate {
        format!("{} · {}", model.name, selection.provider)
    } else {
        model.name.clone()
    }
}

fn current_effort_label(app: &App) -> String {
    let Some(selection) = app.controls.model.next.as_ref() else {
        return "默认".to_string();
    };
    if let Some(effort) = selection.reasoning_effort.as_deref() {
        let advertised = app
            .controls
            .catalog()
            .and_then(|catalog| catalog.reasoning_for(selection))
            .is_some_and(|reasoning| {
                reasoning
                    .efforts
                    .iter()
                    .any(|candidate| candidate.id == effort)
            });
        let label = app.controls.effort_label();
        return if advertised {
            label
        } else {
            format!("{label}（目录未声明，提交将用默认）")
        };
    }
    app.controls
        .catalog()
        .and_then(|catalog| catalog.reasoning_for(selection))
        .and_then(|reasoning| reasoning.default_effort_name())
        .map(|name| format!("默认（模型默认：{name}）"))
        .unwrap_or_else(|| "默认".to_string())
}

fn stale_suffix(app: &App) -> Option<&'static str> {
    if app.controls.catalog_stale() {
        Some(" · 目录可能过期")
    } else if app.controls.state_error().is_some() {
        Some(" · 状态可能过期")
    } else {
        None
    }
}

/// Whether the focused effort currently needs animation frames.
pub(crate) fn effort_animation_active(app: &App) -> bool {
    if app.reduced_motion
        || app.schedule.open
        || app.terminal_active()
        || !app.panel.is_open()
        || !matches!(app.panel.mode(), PanelMode::Models)
    {
        return false;
    }
    match effort_area(app) {
        EffortArea::Levels { levels, selected } => {
            is_sweep_level(&levels, selected) || is_max_level(&levels, selected)
        }
        _ => false,
    }
}

/// Whether the sweep specifically needs animation frames.
pub(crate) fn sweep_animation_active(app: &App) -> bool {
    if !effort_animation_active(app) {
        return false;
    }
    match effort_area(app) {
        EffortArea::Levels { levels, selected } => is_sweep_level(&levels, selected),
        _ => false,
    }
}

fn panel_footer(_app: &App) -> &'static str {
    "↑↓ 选择 · Enter 确认 · Esc 返回 · 输入筛选"
}

/// One-line header describing the current official value for this pane.
fn panel_header(app: &App) -> String {
    match app.panel.mode() {
        PanelMode::Models => models_header_text(app),
        PanelMode::Permissions => {
            let permission = app.controls.permission();
            let default = if permission.catalog.default_preset.is_empty() {
                String::new()
            } else {
                format!(" · 新会话默认 {}", permission.catalog.default_preset)
            };
            let stale = if app.controls.state_error().is_some() {
                " · 状态可能过期"
            } else {
                ""
            };
            format!("当前：{}{default}{stale}", app.controls.permission_label())
        }
        PanelMode::Commands => "官方命令优先于同名技能；不可用命令显示原因".to_string(),
    }
}

/// Explicit reason for an empty pane.
fn empty_panel_reason(app: &App) -> String {
    match app.panel.mode() {
        PanelMode::Commands => {
            if !app.controls.commands_available() {
                "官方命令服务未组合：没有可执行命令".to_string()
            } else if let Some(error) = app.controls.state_error() {
                format!("控制状态读取失败：{error}（命令列表未知）")
            } else if app.panel.query().is_empty() {
                "没有可用命令".to_string()
            } else {
                format!("没有匹配「{}」的命令", app.panel.query())
            }
        }
        PanelMode::Models => {
            if let Some(error) = app.controls.catalog_error() {
                format!("模型目录读取失败：{error}（上次值保留，可能过期）")
            } else if !app.controls.catalog_attempted() {
                "模型目录尚未加载".to_string()
            } else {
                format!("官方模型目录为空（或没有匹配「{}」）", app.panel.query())
            }
        }
        PanelMode::Permissions => {
            if let Some(error) = app.controls.state_error() {
                format!("控制状态读取失败：{error}（保留上次值，可能过期）")
            } else if app.controls.permission().available == Some(false) {
                "官方权限服务未组合".to_string()
            } else if !app.controls.permission().loaded {
                "权限状态尚未读取".to_string()
            } else if app.panel.query().is_empty() {
                "官方权限预设为空".to_string()
            } else {
                format!("没有匹配「{}」的权限预设", app.panel.query())
            }
        }
    }
}

/// One row: marker, label, current flag, and either the inline detail or the
/// unavailability reason.
fn panel_row_line(row: &PanelRow, selected: bool, width: usize, theme: Theme) -> Line<'static> {
    let marker = if selected { "▶ " } else { "  " };
    let current = if row.current { "（当前）" } else { "" };
    let mut text = format!("{marker}{}{current}", row.label);
    if let Some(reason) = &row.disabled {
        text.push_str(" · ");
        text.push_str(reason);
    } else if !selected {
        if let Some(detail) = &row.detail {
            text.push_str("  ");
            text.push_str(detail);
        }
    }
    let style = if row.disabled.is_some() {
        Style::default().fg(theme.colors().muted)
    } else if selected {
        Style::default()
            .fg(theme.colors().fg)
            .bg(theme.colors().selected_bg)
    } else {
        Style::default()
    };
    Line::from(Span::styled(truncate(&text, width), style))
}

/// Center a rectangle inside the frame area.
fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect {
        x: area.x + (area.width - width) / 2,
        y: area.y + (area.height - height) / 2,
        width,
        height,
    }
}

/// Push display-wrapped lines with one style.
fn push_wrapped(lines: &mut Vec<Line<'static>>, text: &str, width: usize, style: Style) {
    for segment in wrap_segments(&text.replace('\r', ""), width.max(1)) {
        lines.push(Line::from(Span::styled(segment.text, style)));
    }
}

/// Input lines after display-cell wrapping, with `\r` hidden.
fn input_lines(app: &App, width: usize) -> Vec<String> {
    let buffer = app.drafts.current();
    let mut rows = Vec::new();
    for line in buffer.text().split('\n') {
        let line = line.replace('\r', "");
        let segments = wrap_segments(&line, width);
        for segment in segments {
            rows.push(line[segment.start..segment.end].to_string());
        }
    }
    if rows.is_empty() {
        rows.push(String::new());
    }
    rows
}

fn wrapped_input_rows(app: &App, width: u16) -> usize {
    input_lines(app, width.max(1) as usize).len().max(1)
}

/// Styled draft rows: carriage returns are hidden, and selected bytes carry
/// the selected background. The caller prepends the two-cell line prefix.
fn input_styled_lines(app: &App, width: usize) -> Vec<Line<'static>> {
    let text = app.drafts.current().text();
    let cursor = app.drafts.current().cursor();
    let selection = app.drafts.current().selection();
    let ghost = if app.scene.focus().input_focused()
        && !app.panel.is_open()
        && !app.drafts.current().has_selection()
    {
        app.command_completion.ghost()
    } else {
        None
    };
    let selected_style = Style::default()
        .fg(app.theme.colors().fg)
        .bg(app.theme.colors().selected_bg);
    let mut rows = Vec::new();
    let mut line_start = 0;
    for line in text.split('\n') {
        for segment in wrap_segments(line, width) {
            let mut spans = Vec::new();
            let mut run = String::new();
            let mut run_selected = false;
            let mut ghost_inserted = false;
            for (offset, character) in line[segment.start..segment.end].char_indices() {
                if character == '\r' {
                    continue;
                }
                let byte = line_start + segment.start + offset;
                if !ghost_inserted && byte == cursor {
                    if !run.is_empty() {
                        spans.push(styled_run(
                            std::mem::take(&mut run),
                            run_selected,
                            selected_style,
                        ));
                    }
                    if let Some(ghost) = ghost {
                        let room = width.saturating_sub(segment.width).saturating_sub(1);
                        let suffix = truncate_width(ghost, room);
                        if !suffix.is_empty() {
                            spans.push(Span::styled(suffix, muted_style(app.theme)));
                        }
                    }
                    ghost_inserted = true;
                }
                let selected = selection.is_some_and(|(start, end)| byte >= start && byte < end);
                if !run.is_empty() && selected != run_selected {
                    spans.push(styled_run(
                        std::mem::take(&mut run),
                        run_selected,
                        selected_style,
                    ));
                }
                run_selected = selected;
                run.push(character);
            }
            if !ghost_inserted && cursor == line_start + segment.end {
                if !run.is_empty() {
                    spans.push(styled_run(
                        std::mem::take(&mut run),
                        run_selected,
                        selected_style,
                    ));
                }
                if let Some(ghost) = ghost {
                    let room = width.saturating_sub(segment.width).saturating_sub(1);
                    let suffix = truncate_width(ghost, room);
                    if !suffix.is_empty() {
                        spans.push(Span::styled(suffix, muted_style(app.theme)));
                    }
                }
            } else if !run.is_empty() {
                spans.push(styled_run(run, run_selected, selected_style));
            }
            rows.push(Line::from(spans));
        }
        line_start += line.len() + 1;
    }
    if rows.is_empty() {
        rows.push(Line::from(""));
    }
    rows
}

fn truncate_width(text: &str, max: usize) -> String {
    let mut output = String::new();
    let mut used = 0;
    for character in text.chars() {
        let width = display_width(character);
        if used + width > max {
            break;
        }
        output.push(character);
        used += width;
    }
    output
}

fn styled_run(text: String, selected: bool, selected_style: Style) -> Span<'static> {
    if selected {
        Span::styled(text, selected_style)
    } else {
        Span::raw(text)
    }
}

/// Map a terminal cell inside the composer to a byte offset in the draft.
/// Returns `None` for rows that are not part of the draft (notice, attachments,
/// picker). Clicking below the last draft row lands at the buffer end.
pub(crate) fn input_offset_at(
    text: &str,
    width: usize,
    area: Rect,
    scroll: usize,
    draft_top: usize,
    draft_rows: usize,
    column: u16,
    row: u16,
) -> Option<usize> {
    if area.width == 0 || area.height == 0 || draft_rows == 0 {
        return None;
    }
    if column < area.x
        || column >= area.x.saturating_add(area.width)
        || row < area.y
        || row >= area.y.saturating_add(area.height)
    {
        return None;
    }
    let local = (row - area.y) as usize;
    let absolute = scroll.saturating_add(local);
    if absolute < draft_top {
        return None;
    }
    let target_row = absolute - draft_top;
    if target_row >= draft_rows {
        return Some(text.len());
    }
    let width = width.max(1);
    let mut rows = Vec::new();
    let mut line_start = 0;
    for line in text.split('\n') {
        for segment in wrap_segments(line, width) {
            rows.push((line_start + segment.start, line_start + segment.end));
        }
        line_start += line.len() + 1;
    }
    if rows.is_empty() {
        rows.push((0, 0));
    }
    let Some((start, end)) = rows.get(target_row).copied() else {
        return Some(text.len());
    };
    let text_x = area.x.saturating_add(2);
    if column < text_x {
        return Some(start);
    }
    let target = (column - text_x) as usize;
    let mut used = 0usize;
    for (offset, character) in text[start..end].char_indices() {
        if character == '\r' {
            continue;
        }
        let character_width = display_width(character);
        if used + character_width > target {
            return Some(if target > used {
                start + offset + character.len_utf8()
            } else {
                start + offset
            });
        }
        used += character_width;
    }
    Some(end)
}

/// Cursor row and display column after wrapping.
fn input_cursor(app: &App, width: usize) -> (usize, usize) {
    let buffer = app.drafts.current();
    let text = buffer.text();
    let cursor = buffer.cursor().min(text.len());
    let mut line_start = 0;
    let mut rows = 0;
    for line in text.split('\n') {
        let line_end = line_start + line.len();
        if cursor <= line_end {
            let display = line.replace('\r', "");
            let local = cursor.saturating_sub(line_start).min(line.len());
            let char_index = text[line_start..line_start + local]
                .replace('\r', "")
                .chars()
                .count();
            let segments = wrap_segments(&display, width);
            for (index, segment) in segments.iter().enumerate() {
                let is_last = index + 1 == segments.len();
                if char_index < segment.display_start + segment.char_count || is_last {
                    let consumed = char_index.saturating_sub(segment.display_start);
                    let column = segment.text.chars().take(consumed).map(display_width).sum();
                    return (rows + index, column);
                }
            }
            return (rows, 0);
        }
        let display = line.replace('\r', "");
        rows += wrap_segments(&display, width).len();
        line_start = line_end + 1;
    }
    (rows, 0)
}

fn text_width(text: &str) -> usize {
    text.chars().map(display_width).sum()
}

fn display_width(character: char) -> usize {
    UnicodeWidthChar::width(character).unwrap_or(0)
}

/// One wrapped display segment.
#[derive(Debug, Clone)]
struct Segment {
    /// Byte start in the (CR-stripped) line.
    start: usize,
    /// Byte end.
    end: usize,
    /// Character index of the segment start.
    display_start: usize,
    /// Number of characters in the segment.
    char_count: usize,
    /// Display width of the segment (kept for wrapping assertions).
    #[allow(dead_code)]
    width: usize,
    /// Segment text.
    text: String,
}

/// Greedy display-cell wrapping. Wide characters are never split.
fn wrap_segments(line: &str, width: usize) -> Vec<Segment> {
    let width = width.max(1);
    if line.is_empty() {
        return vec![Segment {
            start: 0,
            end: 0,
            display_start: 0,
            char_count: 0,
            width: 0,
            text: String::new(),
        }];
    }
    let mut segments = Vec::new();
    let mut start = 0;
    let mut start_display = 0;
    let mut characters = 0;
    let mut current_width = 0;
    let mut end = 0;
    for (offset, character) in line.char_indices() {
        let character_width = display_width(character);
        if current_width + character_width > width && offset > start {
            segments.push(Segment {
                start,
                end: offset,
                display_start: start_display,
                char_count: characters - start_display,
                width: current_width,
                text: line[start..offset].to_string(),
            });
            start = offset;
            start_display = characters;
            current_width = 0;
        }
        current_width += character_width;
        characters += 1;
        end = offset + character.len_utf8();
    }
    segments.push(Segment {
        start,
        end,
        display_start: start_display,
        char_count: characters - start_display,
        width: current_width,
        text: line[start..end].to_string(),
    });
    segments
}

/// First visible row that keeps the selected list item on screen.
fn list_offset(selected: usize, total: usize, viewport: usize) -> usize {
    let visible = viewport.max(1);
    selected
        .saturating_sub(visible.saturating_sub(1))
        .min(total.saturating_sub(visible))
}

/// Wrap the tail of a block and mark display-side truncation explicitly.
/// Output tail semantics matter: the newest bytes and the official
/// truncation/spill notice live at the end.
fn wrap_tail_block(
    lines: &mut Vec<Line<'static>>,
    text: &str,
    width: usize,
    max_chars: usize,
    color: Color,
    theme: Theme,
) {
    let characters = text.chars().count();
    if characters > max_chars {
        let tail: String = text.chars().skip(characters - max_chars).collect();
        lines.push(Line::from(Span::styled(
            format!("[显示已截断：仅显示最后 {max_chars} 字符；完整输出以官方输出为准]"),
            Style::default().fg(theme.colors().warning),
        )));
        wrap_block(lines, &tail, width, max_chars, color);
    } else {
        wrap_block(lines, text, width, max_chars, color);
    }
}

fn wrap_block(
    lines: &mut Vec<Line<'static>>,
    text: &str,
    width: usize,
    max_chars: usize,
    color: Color,
) {
    let text: String = text.chars().take(max_chars).collect();
    for logical in text.split('\n') {
        let logical = logical.replace('\r', "");
        for segment in wrap_segments(&logical, width.max(1)) {
            lines.push(Line::from(Span::styled(
                segment.text,
                Style::default().fg(color),
            )));
        }
    }
}

fn truncate(text: &str, max: usize) -> String {
    // `max` is a display-cell budget, not a character count: CJK labels must
    // not overflow or lose their tail because each glyph takes two cells.
    let total: usize = text.chars().map(display_width).sum();
    if total <= max {
        return text.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let budget = max.saturating_sub(1);
    let mut value = String::new();
    let mut width = 0;
    for character in text.chars() {
        let character_width = display_width(character);
        if width + character_width > budget {
            break;
        }
        value.push(character);
        width += character_width;
    }
    value.push('…');
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{
        KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use nano_decisions::contract::parse_questions;
    use nano_decisions::{ApprovalCard, QuestionCard, TimedState};
    use serde_json::json;
    use std::time::Duration;

    #[test]
    fn the_window_keeps_the_selected_block_visible() {
        let heights = [3usize; 12];
        assert_eq!(visible_block_start(&heights, 0, 9), 0);
        assert_eq!(visible_block_start(&heights, 11, 9), 9);
        assert_eq!(visible_block_start(&heights, 5, 100), 0);
        assert_eq!(visible_block_start(&[], 0, 9), 0);
    }

    #[test]
    fn wrapping_never_splits_wide_characters() {
        let segments = wrap_segments("你好世界", 3);
        assert_eq!(
            segments
                .iter()
                .map(|segment| segment.text.as_str())
                .collect::<Vec<_>>(),
            vec!["你", "好", "世", "界"]
        );
        assert!(segments.iter().all(|segment| segment.width <= 3));
    }

    #[test]
    fn wrapping_keeps_byte_offsets_on_char_boundaries() {
        let line = "a你b";
        for segment in wrap_segments(line, 2) {
            assert!(line.is_char_boundary(segment.start));
            assert!(line.is_char_boundary(segment.end));
            assert_eq!(&line[segment.start..segment.end], segment.text);
        }
    }

    #[test]
    fn truncation_uses_display_cells_not_character_count() {
        let truncated = truncate("你好世界", 5);
        assert_eq!(truncated, "你好…");
        let width: usize = truncated.chars().map(display_width).sum();
        assert!(width <= 5);
        assert_eq!(truncate("abc", 3), "abc");
    }

    #[test]
    fn empty_line_has_one_segment() {
        let segments = wrap_segments("", 10);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].width, 0);
    }

    #[test]
    fn the_tail_renderer_keeps_the_newest_text_and_marks_truncation() {
        let mut lines = Vec::new();
        wrap_tail_block(&mut lines, "abcdef", 10, 3, Color::White, Theme::Dark);
        let joined: String = lines
            .iter()
            .flat_map(|line| line.spans.iter().map(|span| span.content.as_ref()))
            .collect();
        assert!(joined.contains("显示已截断"));
        assert!(joined.contains("def"));
        assert!(!joined.contains("abc"));
    }

    #[test]
    fn the_list_offset_keeps_the_selection_visible() {
        assert_eq!(list_offset(0, 40, 10), 0);
        assert_eq!(list_offset(20, 40, 10), 11);
        assert_eq!(list_offset(39, 40, 10), 30);
        assert_eq!(list_offset(0, 3, 10), 0);
    }

    fn screen(app: &mut App, width: u16, height: u16) -> Vec<String> {
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal
            .draw(|frame| draw(frame, app))
            .expect("draw the frame");
        let buffer = terminal.backend().buffer();
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect()
    }

    fn screen_with_cursor(app: &mut App, width: u16, height: u16) -> (Vec<String>, (u16, u16)) {
        use ratatui::backend::{Backend, TestBackend};
        use ratatui::Terminal;
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal
            .draw(|frame| draw(frame, app))
            .expect("draw the frame");
        let buffer = terminal.backend().buffer().clone();
        let rows = (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect();
        let position = terminal
            .backend_mut()
            .get_cursor_position()
            .expect("test backend cursor");
        (rows, (position.x, position.y))
    }

    fn app() -> App {
        App::new(crate::cli::Cli::default(), "root".to_string(), false)
    }

    #[test]
    fn the_sources_panel_shows_sources_without_credential_values() {
        let mut app = app();
        app.provenance = Some(nano_runtime::Provenance {
            config: Some(nano_runtime::ConfigSource {
                path: "/tmp/profile/cordis.patch.yml".into(),
            }),
            credentials: Some(nano_runtime::CredentialSource {
                reference: "DEEPSEEK_API_KEY".into(),
                configured: true,
                source: Some("env".into()),
            }),
        });
        app.sources_visible = true;
        let rows = compact(&screen(&mut app, 100, 30));
        assert!(rows.iter().any(|row| row.contains("来源")));
        assert!(rows
            .iter()
            .any(|row| row.contains("/tmp/profile/cordis.patch.yml")));
        assert!(rows.iter().any(|row| row.contains("DEEPSEEK_API_KEY")));
        assert!(rows.iter().any(|row| row.contains("启动环境")));
        assert!(rows.iter().any(|row| row.contains("Enter/Esc")));
    }

    #[test]
    fn the_sources_panel_reports_missing_sources_and_skipped_candidates() {
        let mut app = app();
        app.sources_visible = true;
        app.provenance = None;
        app.instruction_candidates = vec![
            crate::app::InstructionCandidate {
                path: "/tmp/AGENTS.md".into(),
                skip: None,
            },
            crate::app::InstructionCandidate {
                path: "/tmp/CLAUDE.md".into(),
                skip: Some("不可读，首轮跳过"),
            },
        ];
        let rows = compact(&screen(&mut app, 100, 30));
        assert!(rows.iter().filter(|row| row.contains("宿主未报告")).count() >= 2);
        assert!(rows.iter().any(|row| row.contains("不可读")));
        assert!(rows.iter().any(|row| row.contains("以首轮实际加载为准")));
        assert!(rows.iter().any(|row| row.contains("/tmp/AGENTS.md")));
    }

    /// TestBackend repeats a wide character's cell as a symbol plus a blank
    /// continuation cell; compacting whitespace makes CJK text easy to match.
    fn compact(rows: &[String]) -> Vec<String> {
        rows.iter()
            .map(|row| {
                row.chars()
                    .filter(|character| !character.is_whitespace())
                    .collect()
            })
            .collect()
    }

    #[test]
    fn the_main_screen_keeps_two_cell_margins_and_a_stable_composer() {
        let mut app = app();
        let rows = screen(&mut app, 100, 30);
        assert!(rows[0].starts_with("  nano"), "{:?}", rows[0]);
        assert!(rows[1].trim().is_empty(), "one blank row under the title");
        let quiet: Vec<&String> = rows.iter().filter(|row| row.contains('─')).collect();
        assert_eq!(quiet.len(), 2, "composer has a top and bottom line");
        let compact = compact(&rows);
        assert!(
            !compact.iter().any(|row| row.contains("继续提问")),
            "the vanishing placeholder is gone: {compact:?}"
        );
        assert!(
            compact.iter().any(|row| row.starts_with('>')),
            "the stable prompt is still drawn: {compact:?}"
        );
        let status = compact.last().expect("status row");
        assert!(status.contains("权限："));
        assert!(status.ends_with(&app.display_path()), "{status:?}");
        assert!(!status.contains("·权限"));
    }

    #[test]
    fn the_empty_composer_keeps_a_visible_terminal_cursor() {
        let mut app = app();
        let (rows, cursor) = screen_with_cursor(&mut app, 100, 30);
        let border_y = rows
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                row.chars()
                    .skip(2)
                    .take(96)
                    .all(|character| character == '─')
            })
            .map(|(y, _)| y)
            .next()
            .expect("composer top border");
        assert_eq!(cursor.0, 4, "cursor sits after the `> ` prompt");
        assert_eq!(cursor.1 as usize, border_y + 1);
    }

    #[test]
    fn the_composer_focus_changes_the_prompt_style() {
        use nano_conversation::scene::FocusId;

        let mut app = app();
        let focused = buffer(&mut app, 100, 30);
        app.scene.focus_mut().reset(FocusId::queue());
        let blurred = buffer(&mut app, 100, 30);
        let border_y = |frame: &ratatui::buffer::Buffer| {
            (0..30)
                .find(|y| (2..98).all(|x| frame[(x, *y)].symbol() == "─"))
                .expect("composer top border")
        };
        let colors = *app.theme.colors();
        let focused_y = border_y(&focused);
        let blurred_y = border_y(&blurred);
        // The border stays the plain rule so the occupancy fill is visible.
        assert_eq!(focused[(50, focused_y)].fg, colors.rule);
        assert_eq!(blurred[(50, blurred_y)].fg, colors.rule);

        let prompt_cell = |frame: &ratatui::buffer::Buffer, y: u16| {
            (0..100)
                .find(|x| frame[(*x, y)].symbol() == ">")
                .expect("prompt cell")
        };
        let focused_x = prompt_cell(&focused, focused_y + 1);
        let blurred_x = prompt_cell(&blurred, blurred_y + 1);
        assert_eq!(focused[(focused_x, focused_y + 1)].fg, colors.accent);
        assert!(focused[(focused_x, focused_y + 1)]
            .modifier
            .contains(Modifier::BOLD));
        assert_eq!(blurred[(blurred_x, blurred_y + 1)].fg, colors.muted);
        assert!(!blurred[(blurred_x, blurred_y + 1)]
            .modifier
            .contains(Modifier::BOLD));
    }

    #[test]
    fn empty_input_and_the_first_character_share_the_same_height() {
        let mut app = app();
        let empty = input_height(&app, 100);
        app.drafts.current_mut().set_text("x");
        let typed = input_height(&app, 100);
        assert_eq!(empty, typed);
    }

    #[test]
    fn a_dock_keeps_one_blank_row_from_the_status() {
        let mut app = app();
        install_subagents(
            &mut app,
            serde_json::json!([subagent_row("child", "continuable")]),
        );
        let rows = screen(&mut app, 100, 30);
        let compact = compact(&rows);
        let status = compact
            .iter()
            .position(|row| row.contains("权限："))
            .expect("status row");
        assert!(compact[status + 1].is_empty(), "{:?}", &compact[status..]);
        assert!(rows[status + 2].contains('─'), "{:?}", &rows[status..]);
    }

    #[test]
    fn bottom_gaps_respect_the_feed_minimum() {
        assert_eq!(bottom_gaps(3, false), (0, 0));
        assert_eq!(bottom_gaps(4, false), (1, 0));
        assert_eq!(bottom_gaps(4, true), (1, 0));
        assert_eq!(bottom_gaps(8, true), (1, 1));
    }

    #[test]
    fn a_tight_terminal_drops_bottom_gaps_before_the_status() {
        let mut app = app();
        let rows = screen(&mut app, 100, 9);
        let compact = compact(&rows);
        let border_y = rows
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                row.chars()
                    .skip(2)
                    .take(96)
                    .all(|character| character == '─')
            })
            .map(|(y, _)| y)
            .last()
            .expect("composer bottom border");
        assert!(compact[border_y + 1].contains("权限："));
    }

    #[test]
    fn bottom_rows_keep_one_blank_separator_when_height_allows() {
        let mut app = app();
        let rows = screen(&mut app, 100, 30);
        let compact = compact(&rows);
        let border_y = rows
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                row.chars()
                    .skip(2)
                    .take(96)
                    .all(|character| character == '─')
            })
            .map(|(y, _)| y)
            .last()
            .expect("composer bottom border");
        assert!(
            compact[border_y + 1].is_empty(),
            "one blank row between composer and status: {:?}",
            &compact[border_y..]
        );
        assert!(compact[border_y + 2].contains("权限："));
    }

    #[test]
    fn the_jump_button_only_appears_above_the_minimum_width() {
        let area = Rect::new(2, 0, 100, 20);
        assert!(jump_button_rect(area, false).is_none());
        let rect = jump_button_rect(area, true).expect("visible");
        assert_eq!(rect.y, 19);
        assert_eq!(rect.right(), area.right() - 2);
        assert!(jump_button_rect(Rect::new(0, 0, 11, 20), true).is_none());
    }

    #[test]
    fn the_jump_button_follows_the_actual_scroll_state() {
        let mut app = app();
        let text = (1..=40)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let payload = json!({
            "address": {"rootSessionId": "root"},
            "seq": 1,
            "type": "assistant/message",
            "data": {
                "turn": 1,
                "step": 1,
                "message": {
                    "id": "a-1",
                    "role": "assistant",
                    "content": [{"type": "text", "text": text}]
                }
            }
        });
        app.model.apply_event("session.event", &payload);
        app.view.sync(&app.model, Instant::now());
        app.transcript_dirty = false;
        app.view.scroll_mut().to_top(200, 10);
        let rows = compact(&screen(&mut app, 100, 30));
        assert!(rows.iter().any(|row| row.contains("回到最新")));
    }

    #[test]
    fn a_single_select_question_hides_checkboxes_and_renders_the_description_once() {
        let questions = parse_questions(Some(&json!([{
            "id": "q",
            "question": "Pick one",
            "options": [
                {"label": "A", "description": "first description"},
                {"label": "B"}
            ]
        }])));
        let card = QuestionCard::new(None, None, questions, None);
        let (_, lines, _) = render_question(&card, Rect::new(0, 0, 60, 20), Theme::Dark);
        let text = lines
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("Pick one"));
        assert!(!text.contains("[ ]"));
        assert!(!text.contains("[x]"));
        assert_eq!(text.matches("first description").count(), 1);
        assert!(text.contains("Alt+N 跳过"));
        assert!(
            lines.iter().all(|line| text_width(&line.to_string()) <= 60),
            "card must fit 60 columns"
        );
    }

    #[test]
    fn a_selected_single_option_shows_a_check_mark() {
        let single = option_line(false, "1.", "A", None, true, Theme::Dark).to_string();
        assert!(single.contains("✓"));
        assert!(!single.contains("[ ]"));
        let multi = option_line(false, "1.", "A", Some(true), true, Theme::Dark).to_string();
        assert!(multi.contains("[x]"));
    }

    #[test]
    fn an_approval_card_uses_the_bash_question_and_shows_the_full_command() {
        let command = "line1\nline2\nline3\nline4\nline5\nline6\nline7";
        let card = ApprovalCard::new(
            "r".into(),
            "bash".into(),
            None,
            Default::default(),
            None,
            Some(command.into()),
            Instant::now(),
        );
        let (_, lines, _) = render_approval(&card, Rect::new(0, 0, 60, 30), Theme::Dark);
        let text = lines
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("是否运行这条检查命令？"));
        assert!(text.contains("line7"), "full command, not a 5-row window");
        assert!(!text.contains("始终允许"));
        assert!(
            lines.iter().all(|line| text_width(&line.to_string()) <= 60),
            "card must fit 60 columns"
        );
    }

    #[test]
    fn a_timed_multi_select_footer_wraps_within_sixty_columns() {
        let questions = parse_questions(Some(&json!([{
            "id": "q",
            "question": "Pick many",
            "multi_select": true,
            "options": [{"label": "A"}, {"label": "B"}]
        }])));
        let card = QuestionCard::new(
            None,
            None,
            questions,
            Some(TimedState::start(30_000, Instant::now())),
        );
        let (_, lines, _) = render_question(&card, Rect::new(0, 0, 60, 24), Theme::Dark);
        let text = lines
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("Alt+T"));
        assert!(text.contains("剩"));
        assert!(lines.iter().all(|line| text_width(&line.to_string()) <= 60));
    }

    #[test]
    fn a_long_question_keeps_every_option_and_the_footer_visible() {
        let long = "很长的题目。".repeat(30);
        let detail = "很长的描述。".repeat(20);
        let questions = parse_questions(Some(&json!([{
            "id": "q",
            "question": long,
            "options": [
                {"label": "A", "description": detail},
                {"label": "B", "description": detail},
                {"label": "C", "description": detail},
                {"label": "D", "description": detail}
            ]
        }])));
        let card = QuestionCard::new(None, None, questions, None);
        let (_, lines, _) = render_question(&card, Rect::new(0, 0, 60, 24), Theme::Dark);
        let visible: Vec<String> = lines.iter().take(23).map(ToString::to_string).collect();
        let text = visible.join("\n");
        assert!(text.contains("4. D"), "fourth option stays visible");
        assert!(text.contains("其他"));
        assert!(text.contains("Alt+N 跳过"));
        assert!(visible.iter().all(|line| text_width(line) <= 60));
    }

    #[test]
    fn the_status_bar_right_aligns_the_path_and_truncates_the_middle_first() {
        let mut app = app();
        app.notice = Some("这是一个需要先截断的中段提示".to_string());
        let rows = screen(&mut app, 60, 20);
        let status = compact(&rows).last().expect("status row").clone();
        assert!(status.contains("权限："));
        // Both ends survive; the right path keeps its tail and the middle
        // notice is the first thing to go.
        assert!(status.ends_with("nano-app"), "{status:?}");
        assert!(status.contains('…'));
        assert!(!status.contains("中段提示"));
    }

    fn meter(projected: u64, window: u64) -> nano_sessions::ContextMeter {
        nano_sessions::ContextMeter {
            session_id: "root".into(),
            as_of_seq: 1,
            approximate: true,
            projected_tokens: Some(projected),
            context_window: Some(window),
            pressure_tokens: None,
            pressure_at: None,
            context_window_at: None,
            token_usage: None,
            breakdown: None,
        }
    }

    fn border_colors(app: &mut App) -> Vec<(usize, Color)> {
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let width = 100;
        let height = 30;
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal.draw(|frame| draw(frame, app)).expect("draw");
        let buffer = terminal.backend().buffer();
        let row = (0..height)
            .find(|y| {
                (0..width)
                    .filter(|x| buffer[(*x, *y)].symbol() == "─")
                    .count()
                    > width as usize / 2
            })
            .expect("composer border row");
        (2..(width as usize - 2))
            .map(|x| (x, buffer[(x as u16, row)].fg))
            .collect()
    }

    fn border_rows(app: &mut App) -> Vec<Vec<Color>> {
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let width = 100;
        let height = 30;
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal.draw(|frame| draw(frame, app)).expect("draw");
        let buffer = terminal.backend().buffer();
        (0..height)
            .filter(|y| (2..98).all(|x| buffer[(x, *y)].symbol() == "─"))
            .map(|y| (2..98).map(|x| buffer[(x, y)].fg).collect())
            .collect()
    }

    #[test]
    fn the_context_bar_keeps_fill_and_rest_distinct_at_boundaries() {
        let mut app = app();
        let colors = *app.theme.colors();
        for projected in [0u64, 1] {
            app.context = Some(meter(projected, 100));
            let row = border_colors(&mut app);
            assert!(
                row.iter().all(|(_, color)| *color == colors.rule),
                "{projected}% has no fill: {row:?}"
            );
        }
        for (projected, expected) in [
            (79u64, colors.accent),
            (80, colors.warning),
            (94, colors.warning),
            (95, colors.error),
        ] {
            app.context = Some(meter(projected, 100));
            let row = border_colors(&mut app);
            let first = row.iter().position(|(_, color)| *color == expected);
            assert_eq!(
                first,
                Some(0),
                "{projected}% fill starts at the left: {row:?}"
            );
            assert!(
                row.iter().any(|(_, color)| *color == colors.rule),
                "{projected}% keeps the rest distinct: {row:?}"
            );
        }
        app.context = Some(meter(100, 100));
        let full = border_colors(&mut app);
        assert!(full.iter().all(|(_, color)| *color == colors.error));

        app.context = Some(meter(50, 100));
        let rows = border_rows(&mut app);
        assert!(rows.len() >= 2, "top and bottom borders: {rows:?}");
        assert_eq!(rows[0], rows[1], "both composer borders match");
    }

    #[test]
    fn the_context_line_uses_accent_warning_error_and_a_plain_unknown_border() {
        let mut app = app();
        let colors = border_colors(&mut app);
        let accent = app.theme.colors().accent;
        let warning = app.theme.colors().warning;
        let error = app.theme.colors().error;
        let rule = app.theme.colors().rule;
        // An unknown occupancy leaves the whole border plain.
        assert!(colors.iter().all(|(_, color)| *color == rule));

        app.context = Some(meter(50, 100));
        let half = border_colors(&mut app);
        let filled = half.iter().filter(|(_, color)| *color == accent).count();
        let free = half.iter().filter(|(_, color)| *color == rule).count();
        assert!(filled > 40, "filled half: {half:?}");
        assert!(free > 40, "free half: {half:?}");

        app.context = Some(meter(80, 100));
        assert!(border_colors(&mut app)
            .iter()
            .any(|(_, color)| *color == warning));
        app.context = Some(meter(95, 100));
        assert!(border_colors(&mut app)
            .iter()
            .any(|(_, color)| *color == error));

        use nano_conversation::scene::FocusId;
        app.scene.focus_mut().reset(FocusId::queue());
        app.context = None;
        assert!(border_colors(&mut app)
            .iter()
            .all(|(_, color)| *color == rule));
    }

    #[test]
    fn the_frame_uses_theme_foreground_over_terminal_background() {
        let mut app = app();
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal
            .draw(|frame| draw(frame, &mut app))
            .expect("draw the frame");
        let cell = &terminal.backend().buffer()[(0, 15)];
        assert_eq!(cell.fg, app.theme.colors().fg);
        assert_eq!(cell.bg, Color::Reset);
    }

    #[test]
    fn the_light_theme_uses_the_light_foreground() {
        let mut app = App::with_theme(
            crate::cli::Cli::default(),
            "root".to_string(),
            false,
            Theme::Light,
        );
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal
            .draw(|frame| draw(frame, &mut app))
            .expect("draw the frame");
        let cell = &terminal.backend().buffer()[(0, 15)];
        assert_eq!(cell.fg, Theme::Light.colors().fg);
        assert_ne!(Theme::Light.colors().fg, Theme::Dark.colors().fg);
    }

    #[test]
    fn the_approval_first_line_uses_the_theme_foreground() {
        let card = ApprovalCard::new(
            "call".into(),
            "bash".into(),
            None,
            Default::default(),
            None,
            Some("echo".into()),
            Instant::now(),
        );
        let (_, lines, _) = render_approval(&card, Rect::new(0, 0, 60, 30), Theme::Light);
        let first = lines.first().expect("approval question");
        assert_eq!(first.spans[0].style.fg, Some(Theme::Light.colors().fg));
        assert!(first.spans[0].style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn self_drawn_colors_are_explicit_rgb_over_terminal_background() {
        let mut app = app();
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal
            .draw(|frame| draw(frame, &mut app))
            .expect("draw the frame");
        let mut skip = 0usize;
        for (index, cell) in terminal.backend().buffer().content().iter().enumerate() {
            let x = index % 100;
            let y = index / 100;
            if skip > 0 {
                // The backend does not receive cells hidden by a preceding
                // multi-width glyph; their color is not rendered.
                skip -= 1;
                continue;
            }
            assert!(
                matches!(cell.fg, Color::Rgb(..)),
                "foreground must be explicit RGB at ({x},{y}): {cell:?}"
            );
            assert_eq!(
                cell.bg,
                Color::Reset,
                "ordinary frame background stays Reset at ({x},{y}): {cell:?}"
            );
            skip = cell
                .symbol()
                .chars()
                .next()
                .map(display_width)
                .unwrap_or(0)
                .saturating_sub(1);
        }
    }

    #[test]
    fn theme_roles_are_wired_on_surface_helpers() {
        for theme in [Theme::Dark, Theme::Light] {
            let colors = theme.colors();
            assert_eq!(
                schedule_style(RowKind::Title, theme).fg,
                Some(colors.accent)
            );
            assert_eq!(schedule_style(RowKind::Dim, theme).fg, Some(colors.muted));
            assert_eq!(schedule_style(RowKind::Error, theme).fg, Some(colors.error));
            assert_eq!(
                schedule_style(RowKind::Notice, theme).fg,
                Some(colors.warning)
            );
            assert_eq!(
                schedule_style(RowKind::Selected, theme).bg,
                Some(colors.selected_bg)
            );
            assert_eq!(
                schedule_style(RowKind::SelectedDim, theme).fg,
                Some(colors.muted)
            );
            assert_eq!(
                schedule_style(RowKind::SelectedDim, theme).bg,
                Some(colors.selected_bg)
            );
            assert_eq!(job_color(JobStatus::Completed, theme), colors.success);
            assert_eq!(job_color(JobStatus::Failed, theme), colors.error);
            assert_eq!(job_color(JobStatus::Unknown, theme), colors.muted);
            assert_eq!(lamp_glyph(Lamp::Completed, true, theme).1, colors.success);
            assert_eq!(lamp_glyph(Lamp::Warned, true, theme).1, colors.warning);
            assert_eq!(lamp_glyph(Lamp::Inactive, true, theme).1, colors.muted);
            let focused = option_line(true, "1.", "A", None, false, theme);
            assert_eq!(focused.spans[0].style.fg, Some(colors.accent));
            let selected = option_line(false, "1.", "A", None, true, theme);
            assert_eq!(
                selected.spans.last().expect("checkmark").style.fg,
                Some(colors.success)
            );
        }
    }

    #[test]
    fn the_light_theme_renders_60_columns_with_theme_roles() {
        let mut app = App::with_theme(
            crate::cli::Cli::default(),
            "root".to_string(),
            false,
            Theme::Light,
        );
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal
            .draw(|frame| draw(frame, &mut app))
            .expect("wide frame");
        terminal
            .resize(Rect::new(0, 0, 60, 20))
            .expect("resize to 60 columns");
        terminal
            .draw(|frame| draw(frame, &mut app))
            .expect("60-column frame");
        let mut skip = 0usize;
        let mut saw_focus = false;
        for (index, cell) in terminal.backend().buffer().content().iter().enumerate() {
            let x = index % 60;
            let y = index / 60;
            if skip > 0 {
                skip -= 1;
                continue;
            }
            assert!(
                matches!(cell.fg, Color::Rgb(..)),
                "foreground must be explicit RGB at ({x},{y}): {cell:?}"
            );
            assert_eq!(
                cell.bg,
                Color::Reset,
                "ordinary frame background stays Reset at ({x},{y}): {cell:?}"
            );
            if cell.symbol() == ">" && cell.fg == Theme::Light.colors().accent {
                saw_focus = true;
            }
            skip = cell
                .symbol()
                .chars()
                .next()
                .map(display_width)
                .unwrap_or(0)
                .saturating_sub(1);
        }
        assert!(saw_focus, "composer prompt uses the light accent role");
    }

    #[test]
    fn the_panel_overlay_and_close_keep_explicit_theme_colors() {
        let mut app = app();
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let mut draw_once = |app: &mut App| {
            let backend = TestBackend::new(100, 30);
            let mut terminal = Terminal::new(backend).expect("test terminal");
            terminal
                .draw(|frame| draw(frame, app))
                .expect("draw the frame");
            terminal.backend().buffer().clone()
        };
        assert!(app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL)));
        let open = draw_once(&mut app);
        let allowed_bg = [
            Color::Reset,
            app.theme.colors().selected_bg,
            app.theme.colors().hover_bg,
        ];
        let mut skip = 0usize;
        for cell in open.content() {
            if skip > 0 {
                skip -= 1;
                continue;
            }
            assert!(
                matches!(cell.fg, Color::Rgb(..)),
                "overlay foreground must be explicit RGB: {cell:?}"
            );
            assert!(
                allowed_bg.contains(&cell.bg),
                "overlay background is a local highlight or Reset: {cell:?}"
            );
            skip = cell
                .symbol()
                .chars()
                .next()
                .map(display_width)
                .unwrap_or(0)
                .saturating_sub(1);
        }
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        let closed = draw_once(&mut app);
        let mut skip = 0usize;
        for cell in closed.content() {
            if skip > 0 {
                skip -= 1;
                continue;
            }
            assert!(
                matches!(cell.fg, Color::Rgb(..)),
                "closed frame foreground must be explicit RGB: {cell:?}"
            );
            assert_eq!(
                cell.bg,
                Color::Reset,
                "no overlay background may remain after close: {cell:?}"
            );
            skip = cell
                .symbol()
                .chars()
                .next()
                .map(display_width)
                .unwrap_or(0)
                .saturating_sub(1);
        }
    }

    fn running_event() -> serde_json::Value {
        serde_json::json!({
            "address": {"rootSessionId": "root"},
            "status": "running"
        })
    }

    #[test]
    fn the_activity_row_has_idle_running_and_waiting_states_and_a_phase() {
        let mut base = app();
        assert_eq!(base.activity_kind(), None);

        base.model
            .apply_event("conversation.status", &running_event());
        assert_eq!(base.activity_kind(), Some(ActivityKind::Running));
        assert!(base.tick());
        assert!(!base.activity_phase);
        base.activity_at = Some(Instant::now() - Duration::from_millis(1));
        assert!(base.tick());
        assert!(base.activity_phase);
        let rows = compact(&screen(&mut base, 100, 30));
        assert!(rows.iter().any(|row| row.contains("○正在运行…·Esc可停止")));

        let mut approval = app();
        approval.decisions.apply_event(
            "decisions.approval",
            &serde_json::json!({
                "address": {"rootSessionId": "root"},
                "state": "pending",
                "requestId": "a-1",
                "toolName": "bash",
                "reason": "sandbox"
            }),
        );
        assert_eq!(
            approval.activity_kind(),
            Some(ActivityKind::AwaitingApproval)
        );
        let rows = compact(&screen(&mut approval, 100, 30));
        assert!(rows.iter().any(|row| row.contains("等待你的授权")));

        let mut question = app();
        question.decisions.apply_event(
            "decisions.question",
            &serde_json::json!({
                "address": {"rootSessionId": "root"},
                "state": "pending",
                "requestId": "q-1",
                "callId": "c-1",
                "timed": false,
                "questions": [{"id": "q1", "question": "Pick", "options": [{"label": "A"}]}]
            }),
        );
        assert_eq!(
            question.activity_kind(),
            Some(ActivityKind::AwaitingQuestion)
        );
        let rows = compact(&screen(&mut question, 100, 30));
        assert!(rows.iter().any(|row| row.contains("等待你的选择")));

        base.model.apply_event(
            "conversation.status",
            &serde_json::json!({
                "address": {"rootSessionId": "root"},
                "status": "idle"
            }),
        );
        base.tick();
        assert_eq!(base.activity_kind(), None);
        assert!(base.activity_at.is_none());
    }

    fn subagent_row(id: &str, mode: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "parentId": "root",
            "depth": 1,
            "mode": mode,
            "label": format!("task {id}"),
            "activity": "inactive",
            "hasChildren": false
        })
    }

    fn install_subagents(app: &mut App, agents: serde_json::Value) {
        app.subagents
            .apply_snapshot(&serde_json::json!({
                "agents": agents,
                "diagnostics": [],
                "parentLive": true
            }))
            .expect("valid snapshot");
    }

    #[test]
    fn the_dock_sits_below_the_status_bar_without_a_title_and_counts_in_the_list() {
        let mut app = app();
        let mut one_shot = subagent_row("c", "one-shot");
        one_shot["settledMs"] = serde_json::json!(2400);
        one_shot["activeThrough"] = serde_json::json!(5000);
        install_subagents(
            &mut app,
            serde_json::json!([
                subagent_row("a", "continuable"),
                subagent_row("b", "continuable"),
                one_shot,
                subagent_row("d", "continuable"),
                subagent_row("e", "continuable"),
                subagent_row("f", "external"),
            ]),
        );
        let rows = screen(&mut app, 100, 30);
        let rows_compact = compact(&rows);
        let dock = app.subagent_dock_area.y as usize;
        let status = rows_compact
            .iter()
            .position(|row| row.contains("权限："))
            .expect("status row");
        assert!(status < dock, "status row stays above the dock");
        assert!(rows_compact.last().unwrap().contains("还有1个子代理"));
        let dock_text = rows_compact[dock..].join("");
        assert!(!dock_text.contains("localagents"), "dock has no title");
        assert!(!dock_text.contains("用时"), "dock has no duration label");
        assert!(!dock_text.contains("2.4s"), "dock has no duration value");
        assert!(!dock_text.contains("一次性"), "dock has no mode suffix");
        assert!(
            !dock_text.contains("taskf"),
            "external rows stay out of the dock"
        );
        assert!(dock_text.contains("taska"));
        assert!(dock_text.contains("未运行"));

        app.enter_subagent_overflow();
        let list = compact(&screen(&mut app, 100, 30));
        assert!(
            list.iter().any(|row| row.contains("全部子代理·5·↑↓选择")),
            "list title keeps its hints and adds the local-only count"
        );
    }

    #[test]
    fn the_child_view_header_keeps_the_main_title_and_adds_a_child_row() {
        let mut app = app();
        install_subagents(
            &mut app,
            serde_json::json!([subagent_row("child", "continuable")]),
        );
        assert!(app.enter_subagent(0));
        app.apply_subagent_description(&serde_json::json!({
            "id": "child",
            "parentId": "root",
            "mode": "continuable",
            "label": "task child",
            "activity": "inactive",
            "parentLive": true,
            "seq": 1
        }));
        let rows = compact(&screen(&mut app, 100, 30));
        assert!(rows[0].starts_with("nano"));
        assert!(rows[1].contains("←子代理taskchild"));
        let status = rows.last().expect("status row");
        assert!(status.contains("权限：子代理审批由官方拒绝"));
        assert!(!status.contains("Enter发送"));
    }

    #[test]
    fn the_activity_row_sits_below_an_open_decision_card() {
        let mut app = app();
        app.decisions.apply_event(
            "decisions.approval",
            &serde_json::json!({
                "address": {"rootSessionId": "root"},
                "state": "pending",
                "requestId": "a-1",
                "toolName": "bash"
            }),
        );
        let rows = compact(&screen(&mut app, 100, 30));
        let activity = rows
            .iter()
            .position(|row| row.contains("等待你的授权"))
            .expect("activity row");
        let card_bottom = (app.decision_area.y + app.decision_area.height) as usize;
        assert_eq!(activity, card_bottom, "decision card, then activity");
        let status = rows
            .iter()
            .position(|row| row.contains("权限："))
            .expect("status row");
        assert!(status > activity);
    }

    #[test]
    fn a_long_draft_keeps_a_visible_send_button() {
        let mut app = app();
        app.drafts.current_mut().set_text(
            "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12",
        );
        let rows = screen(&mut app, 40, 24);
        assert_eq!(app.send_area.height, 1, "send hit area is set");
        let row = rows
            .get(app.send_area.y as usize)
            .expect("send row is on screen");
        assert!(row.contains('↑'), "{row:?}");
        assert_eq!(rows.iter().filter(|row| row.contains('↑')).count(), 1);
    }

    #[test]
    fn a_critical_error_stays_visible_in_the_narrow_status_bar() {
        let mut app = app();
        app.error = Some("通信已断开（会话 root）".to_string());
        let rows = compact(&screen(&mut app, 60, 20));
        let status = rows.last().expect("status row");
        assert!(status.contains("通信已断开"), "{status:?}");
        assert!(status.contains("权限："));
    }

    #[test]
    fn safety_and_mode_notices_stay_visible_in_the_composer() {
        let mut shell = app();
        shell.shell_confirm = Some("echo hi".to_string());
        let rows = compact(&screen(&mut shell, 100, 30));
        assert!(rows
            .iter()
            .any(|row| row.contains("用户权限，不是Agent授权")));

        let mut editing = app();
        editing.edit_target = Some("m-1".to_string());
        editing.drafts.current_mut().set_text("queued");
        let rows = compact(&screen(&mut editing, 100, 30));
        assert!(rows.iter().any(|row| row.contains("编辑队列项m-1")));

        let mut child = app();
        install_subagents(
            &mut child,
            serde_json::json!([subagent_row("child", "one-shot")]),
        );
        assert!(child.enter_subagent(0));
        let rows = compact(&screen(&mut child, 100, 30));
        assert!(rows.iter().any(|row| row.contains("正在读取子代理历史")));
    }

    #[test]
    fn the_header_is_followed_by_one_blank_row() {
        let mut app = app();
        let rows = screen(&mut app, 100, 20);
        assert!(rows[0].starts_with("  nano"));
        assert!(rows[1].trim().is_empty(), "{:?}", rows[1]);
    }

    #[test]
    fn dock_status_words_follow_the_official_lamp() {
        let mut app = app();
        let mut running = subagent_row("run", "continuable");
        running["activity"] = serde_json::json!("running");
        install_subagents(
            &mut app,
            serde_json::json!([
                running,
                subagent_row("ok", "continuable"),
                subagent_row("bad", "one-shot"),
                subagent_row("stop", "continuable"),
            ]),
        );
        for (id, reason) in [("ok", "completed"), ("bad", "error"), ("stop", "aborted")] {
            app.subagents
                .apply_event(&serde_json::json!({
                    "type": "end",
                    "childId": id,
                    "stopReason": reason
                }))
                .expect("valid lifecycle event");
        }
        let rows = compact(&screen(&mut app, 100, 30));
        let dock = rows[app.subagent_dock_area.y as usize..].join("");
        assert!(dock.contains("执行中"), "{dock:?}");
        assert!(dock.contains("完成"), "{dock:?}");
        assert!(dock.contains("错误"), "{dock:?}");
        assert!(dock.contains("终止"), "{dock:?}");

        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        let rows = compact(&screen(&mut app, 100, 30));
        let dock = rows[app.subagent_dock_area.y as usize..].join("");
        assert!(dock.contains('›'), "{dock:?}");
    }

    #[test]
    fn unknown_terminal_reason_uses_the_inactive_status_word() {
        let mut app = app();
        install_subagents(
            &mut app,
            serde_json::json!([subagent_row("mystery", "continuable")]),
        );
        app.subagents
            .apply_event(&serde_json::json!({
                "type": "end",
                "childId": "mystery",
                "stopReason": "future-reason"
            }))
            .expect("valid lifecycle event");
        let rows = compact(&screen(&mut app, 100, 30));
        let dock = rows[app.subagent_dock_area.y as usize..].join("");
        assert!(dock.contains("未运行"), "{dock:?}");
    }

    #[test]
    fn dock_hover_uses_theme_tokens() {
        assert_eq!(Theme::Dark.colors().hover_bg, Color::Rgb(36, 43, 53));
        assert_eq!(Theme::Light.colors().hover_bg, Color::Rgb(232, 232, 229));
    }

    fn screen_bg(app: &mut App, width: u16, height: u16, x: u16, y: u16) -> Color {
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal
            .draw(|frame| draw(frame, app))
            .expect("draw the frame");
        terminal.backend().buffer()[(x, y)].bg
    }

    #[test]
    fn input_offset_at_maps_ascii_and_cjk_cells() {
        let area = Rect::new(10, 5, 40, 3);
        let width = input_text_width(area.width);
        let text = "你好abc";
        assert_eq!(input_offset_at(text, width, area, 0, 0, 1, 10, 5), Some(0));
        assert_eq!(input_offset_at(text, width, area, 0, 0, 1, 12, 5), Some(0));
        assert_eq!(input_offset_at(text, width, area, 0, 0, 1, 13, 5), Some(3));
        assert_eq!(input_offset_at(text, width, area, 0, 0, 1, 16, 5), Some(6));
        assert_eq!(input_offset_at(text, width, area, 0, 0, 1, 19, 5), Some(9));
        assert_eq!(input_offset_at(text, width, area, 0, 0, 1, 12, 4), None);
        assert_eq!(input_offset_at(text, width, area, 0, 2, 1, 12, 5), None);
    }

    #[test]
    fn input_offset_at_maps_wrapped_rows() {
        let area = Rect::new(0, 0, 7, 2);
        let width = input_text_width(area.width);
        let text = "abcdefghij";
        assert_eq!(input_offset_at(text, width, area, 0, 0, 3, 2, 0), Some(0));
        assert_eq!(input_offset_at(text, width, area, 0, 0, 3, 2, 1), Some(4));
        assert_eq!(input_offset_at(text, width, area, 0, 0, 3, 6, 1), Some(8));
    }

    #[test]
    fn the_completion_window_follows_the_selected_row() {
        let mut app = app();
        app.controls.set_capabilities(true, true, true);
        let commands: Vec<_> = (0..10)
            .map(|index| json!({"name": format!("c{index}"), "description": "test"}))
            .collect();
        app.controls
            .apply_state(&json!({
                "address": {"rootSessionId": "root"},
                "model": {"lastUsed": null, "next": null},
                "permission": {"current": null, "catalog": {"options": [], "defaultOptions": [], "defaultPreset": ""}},
                "commands": commands
            }))
            .expect("state");
        app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
        for _ in 0..7 {
            app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        assert_eq!(app.command_completion.selected(), 7);
        let rows = screen(&mut app, 100, 30);
        assert!(
            rows.iter().any(|row| row.trim_start().starts_with("▶ /c7")),
            "selected row must be visible: {rows:?}"
        );
    }

    fn open_models(app: &mut App) {
        open_models_with_efforts(
            app,
            json!([
                {"id": "low", "name": "Low"},
                {"id": "high", "name": "High"},
                {"id": "xhigh", "name": "XHigh"},
                {"id": "max", "name": "Max"}
            ]),
        );
    }

    fn open_models_with_efforts(app: &mut App, efforts: serde_json::Value) {
        app.controls.set_capabilities(true, true, true);
        app.controls
            .apply_state(&json!({
                "address": {"rootSessionId": "root"},
                "model": {"lastUsed": null, "next": {"provider": "p", "model": "chat"}},
                "permission": {"current": null, "catalog": {"options": [], "defaultOptions": [], "defaultPreset": ""}},
                "commands": []
            }))
            .expect("state");
        app.controls
            .apply_catalog(&json!({
                "default": {"provider": "p", "model": "chat"},
                "routableProviders": ["p"],
                "groups": [{
                    "id": "p",
                    "name": "Provider",
                    "models": [
                        {
                            "id": "chat",
                            "name": "Chat",
                            "description": "long description",
                            "reasoning": {
                                "efforts": efforts,
                                "defaultEffort": "high"
                            }
                        },
                        {"id": "plain", "name": "Plain"}
                    ]
                }],
                "failures": [{"id": "third-party", "name": "Third Party", "message": "no credentials"}]
            }))
            .expect("catalog");
        app.panel.open(PanelMode::Models);
        app.panel.reset_effort_for_focus(&app.controls);
    }

    fn buffer(app: &mut App, width: u16, height: u16) -> ratatui::buffer::Buffer {
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal
            .draw(|frame| draw(frame, app))
            .expect("draw the frame");
        terminal.backend().buffer().clone()
    }

    #[test]
    fn the_models_panel_is_a_bottom_layer_with_official_rows_only() {
        let mut app = app();
        open_models(&mut app);
        let rows = screen(&mut app, 100, 30);
        let joined = compact(&rows);
        assert!(
            !joined.iter().any(|row| row.contains("权限：工作区写入")),
            "status bar hidden: {joined:?}"
        );
        assert!(
            !joined.iter().any(|row| row.contains(">继续提问")),
            "composer hidden: {joined:?}"
        );
        assert!(
            joined.iter().any(|row| {
                row.contains("模型")
                    && row.contains("当前：Chat")
                    && row.contains("默认（模型默认：High）")
            }),
            "header names the model default: {joined:?}"
        );
        assert!(
            joined.iter().any(|row| {
                row.contains("Low")
                    && row.contains("High")
                    && row.contains("XHigh")
                    && row.contains("Max")
            }),
            "official labels drawn: {joined:?}"
        );
        assert!(
            !joined.iter().any(|row| row.contains("（当前）")),
            "no current marker: {joined:?}"
        );
        assert!(
            !joined.iter().any(|row| row.contains("Provider")),
            "no provider group title: {joined:?}"
        );
        assert!(
            !joined.iter().any(|row| row.contains("longdescription")),
            "no model detail: {joined:?}"
        );
        assert!(
            joined.iter().any(|row| {
                row.contains("ThirdParty（目录读取失败）") && row.contains("nocredentials")
            }),
            "failure row keeps its reason: {joined:?}"
        );
    }

    #[test]
    fn the_default_effort_keeps_the_official_track_unlit() {
        let mut app = app();
        open_models(&mut app);
        let colors = *app.theme.colors();
        let frame = buffer(&mut app, 100, 30);
        let labels_y = (0..30)
            .find(|y| {
                (0..100)
                    .map(|x| frame[(x, *y)].symbol())
                    .collect::<String>()
                    .contains("XHigh")
            })
            .expect("labels row");
        let bar_y = labels_y - 1;
        for x in 2..98 {
            assert_eq!(
                frame[(x, bar_y)].bg,
                colors.rule,
                "default track is unlit at {x}"
            );
        }
        assert!(!effort_animation_active(&app));
    }

    #[test]
    fn effort_cycles_drive_the_fill_labels_and_animation_gate() {
        let mut app = app();
        open_models(&mut app);
        let colors = *app.theme.colors();
        app.panel.cycle_effort(&app.controls, 1);
        assert!(matches!(
            effort_area(&app),
            EffortArea::Levels {
                selected: Some(0),
                ..
            }
        ));
        assert!(!effort_animation_active(&app));
        app.panel.cycle_effort(&app.controls, 1);
        app.panel.cycle_effort(&app.controls, 1);
        assert!(effort_animation_active(&app));
        let levels = match effort_area(&app) {
            EffortArea::Levels { levels, .. } => levels,
            _ => unreachable!("chat advertises efforts"),
        };
        let backgrounds = |line: &Line<'static>| -> Vec<Color> {
            line.spans.iter().filter_map(|span| span.style.bg).collect()
        };
        let sweep_a = effort_bar_line(&app, &levels, Some(2), 40, 350, true);
        let sweep_b = effort_bar_line(&app, &levels, Some(2), 40, 700, true);
        let sweep_c = effort_bar_line(&app, &levels, Some(2), 40, 1050, true);
        assert_ne!(backgrounds(&sweep_a), backgrounds(&sweep_b));
        assert_ne!(backgrounds(&sweep_b), backgrounds(&sweep_c));
        assert!(
            backgrounds(&sweep_b).iter().any(|color| {
                *color != colors.effort_xhigh
                    && *color != colors.effort_xhigh_highlight
                    && *color != colors.rule
            }),
            "the sweep interpolates its edges: {:?}",
            backgrounds(&sweep_b)
        );
        app.panel.cycle_effort(&app.controls, 1);
        let pulse_a = effort_bar_line(&app, &levels, Some(3), 40, 0, false);
        let pulse_b = effort_bar_line(&app, &levels, Some(3), 40, 600, false);
        assert_ne!(backgrounds(&pulse_a), backgrounds(&pulse_b));
        app.reduced_motion = true;
        assert!(!effort_animation_active(&app));
        let still = effort_bar_line(&app, &levels, Some(2), 40, 600, true);
        assert!(!backgrounds(&still).contains(&colors.effort_xhigh_highlight));
    }

    #[test]
    fn the_real_catalog_sweeps_on_the_second_highest_level() {
        let mut app = app();
        open_models_with_efforts(
            &mut app,
            json!([
                {"id": "off", "name": "Off"},
                {"id": "low", "name": "Low"},
                {"id": "high", "name": "High"},
                {"id": "max", "name": "Max"}
            ]),
        );
        let colors = *app.theme.colors();
        for _ in 0..3 {
            app.panel.cycle_effort(&app.controls, 1);
        }
        assert!(matches!(
            effort_area(&app),
            EffortArea::Levels {
                selected: Some(2),
                ..
            }
        ));
        assert!(effort_animation_active(&app));
        assert!(sweep_animation_active(&app));
        assert!(app.sweep_anim_start.is_none());
        app.tick();
        assert!(
            app.sweep_anim_start.is_some(),
            "High starts the sweep clock"
        );

        let levels = match effort_area(&app) {
            EffortArea::Levels { levels, .. } => levels,
            _ => unreachable!("real catalog advertises efforts"),
        };
        let backgrounds = |line: &Line<'static>| -> Vec<Color> {
            line.spans.iter().filter_map(|span| span.style.bg).collect()
        };
        let left = effort_bar_line(&app, &levels, Some(2), 40, 350, true);
        let middle = effort_bar_line(&app, &levels, Some(2), 40, 700, true);
        assert_ne!(backgrounds(&left), backgrounds(&middle));
        assert!(
            backgrounds(&left).contains(&colors.effort_xhigh),
            "the sweep uses the deep-blue base"
        );
        assert!(
            !backgrounds(&left).contains(&colors.effort_high),
            "High drops its gray-blue while sweeping"
        );
    }

    #[test]
    fn sets_without_a_second_highest_level_do_not_sweep() {
        let two = vec![
            ("low".to_string(), "Low".to_string()),
            ("high".to_string(), "High".to_string()),
        ];
        assert_eq!(sweep_level(&two), None);
        assert!(!is_sweep_level(&two, Some(0)));
        assert!(!is_sweep_level(&two, Some(1)));

        let app = app();
        let colors = *app.theme.colors();
        let line = effort_bar_line(&app, &two, Some(1), 40, 700, false);
        let backgrounds: Vec<Color> = line.spans.iter().filter_map(|span| span.style.bg).collect();
        assert!(
            !backgrounds.contains(&colors.effort_xhigh_highlight),
            "a two-level set has no sweep highlight"
        );
    }

    #[test]
    fn a_max_second_to_last_keeps_the_pulse_without_the_sweep() {
        let levels = vec![
            ("low".to_string(), "Low".to_string()),
            ("max".to_string(), "Max".to_string()),
            ("ultra".to_string(), "Ultra".to_string()),
        ];
        assert_eq!(sweep_level(&levels), None);
        assert!(!is_sweep_level(&levels, Some(1)));
        assert!(is_max_level(&levels, Some(1)));

        let app = app();
        let colors = *app.theme.colors();
        let backgrounds = |line: &Line<'static>| -> Vec<Color> {
            line.spans.iter().filter_map(|span| span.style.bg).collect()
        };
        let bar = effort_bar_line(&app, &levels, Some(1), 40, 700, false);
        assert!(!backgrounds(&bar).contains(&colors.effort_xhigh_highlight));
        let pulse_a = effort_bar_line(&app, &levels, Some(1), 40, 0, false);
        let pulse_b = effort_bar_line(&app, &levels, Some(1), 40, 600, false);
        assert_ne!(
            backgrounds(&pulse_a),
            backgrounds(&pulse_b),
            "Max still pulses"
        );
    }

    #[test]
    fn an_xhigh_that_is_not_second_to_last_stays_static() {
        let levels = vec![
            ("low".to_string(), "Low".to_string()),
            ("xhigh".to_string(), "XHigh".to_string()),
            ("high".to_string(), "High".to_string()),
            ("max".to_string(), "Max".to_string()),
        ];
        assert_eq!(sweep_level(&levels), Some(2));
        assert!(!is_sweep_level(&levels, Some(1)));
        assert!(is_sweep_level(&levels, Some(2)));

        let app = app();
        let colors = *app.theme.colors();
        let line = effort_bar_line(&app, &levels, Some(1), 40, 700, false);
        let backgrounds: Vec<Color> = line.spans.iter().filter_map(|span| span.style.bg).collect();
        assert!(!backgrounds.contains(&colors.effort_xhigh_highlight));
    }

    fn fill_colors(line: &Line<'static>, filled: usize) -> Vec<Color> {
        let mut colors = Vec::new();
        for span in &line.spans {
            let count = span.content.chars().count();
            let bg = span.style.bg.unwrap_or(Color::Reset);
            colors.extend(std::iter::repeat(bg).take(count));
        }
        colors.truncate(filled);
        colors
    }

    fn brightest_cell(line: &Line<'static>, filled: usize, base: Color, highlight: Color) -> usize {
        let distance = |color: Color| -> i64 {
            match (color, base, highlight) {
                (Color::Rgb(r, g, b), Color::Rgb(br, bg, bb), Color::Rgb(hr, hg, hb)) => {
                    (r as i64 - br as i64) * (hr as i64 - br as i64)
                        + (g as i64 - bg as i64) * (hg as i64 - bg as i64)
                        + (b as i64 - bb as i64) * (hb as i64 - bb as i64)
                }
                _ => 0,
            }
        };
        fill_colors(line, filled)
            .iter()
            .enumerate()
            .max_by_key(|(_, color)| distance(**color))
            .map(|(index, _)| index)
            .unwrap_or(0)
    }

    #[test]
    fn the_sweep_runs_on_a_fixed_1400ms_period_at_any_width() {
        let app = app();
        let levels = vec![
            ("low".to_string(), "Low".to_string()),
            ("high".to_string(), "High".to_string()),
            ("xhigh".to_string(), "XHigh".to_string()),
            ("max".to_string(), "Max".to_string()),
        ];
        for width in [40, 96] {
            let start = effort_bar_line(&app, &levels, Some(2), width, 0, true);
            let wrapped = effort_bar_line(&app, &levels, Some(2), width, 1400, true);
            let middle = effort_bar_line(&app, &levels, Some(2), width, 700, true);
            assert_eq!(
                fill_colors(&start, width),
                fill_colors(&wrapped, width),
                "width {width} wraps at 1400ms"
            );
            assert_ne!(
                fill_colors(&start, width),
                fill_colors(&middle, width),
                "width {width} moves within the period"
            );
        }
    }

    #[test]
    fn the_sweep_is_visible_from_the_first_frame_and_never_blanks() {
        let app = app();
        let colors = *app.theme.colors();
        let levels = vec![
            ("low".to_string(), "Low".to_string()),
            ("high".to_string(), "High".to_string()),
            ("xhigh".to_string(), "XHigh".to_string()),
            ("max".to_string(), "Max".to_string()),
        ];
        let width = 40;
        for phase in (0..SWEEP_PERIOD_MS).step_by(50) {
            let line = effort_bar_line(&app, &levels, Some(2), width, phase, true);
            assert!(
                fill_colors(&line, 27)
                    .iter()
                    .any(|color| { *color != colors.effort_xhigh && *color != colors.rule }),
                "the sweep must be visible at {phase}ms"
            );
        }
    }

    #[test]
    fn the_sweep_moves_left_to_right_over_the_fill() {
        let app = app();
        let colors = *app.theme.colors();
        let levels = vec![
            ("low".to_string(), "Low".to_string()),
            ("high".to_string(), "High".to_string()),
            ("xhigh".to_string(), "XHigh".to_string()),
            ("max".to_string(), "Max".to_string()),
        ];
        let width = 40;
        let filled = ((2.0 / 3.0) * width as f64).round() as usize;
        let center = |phase: u64| {
            brightest_cell(
                &effort_bar_line(&app, &levels, Some(2), width, phase, true),
                filled,
                colors.effort_xhigh,
                colors.effort_xhigh_highlight,
            )
        };
        let left = center(350);
        let middle = center(700);
        let right = center(1050);
        assert!(left < middle, "left {left} should precede middle {middle}");
        assert!(
            middle < right,
            "middle {middle} should precede right {right}"
        );
    }

    #[test]
    fn the_sweep_evidence_helper_sets_the_sweep_clock() {
        let phase_560 = effort_phase(&evidence_sweep_fixture(app(), 560), true);
        let phase_1050 = effort_phase(&evidence_sweep_fixture(app(), 1050), true);
        assert!((560..700).contains(&phase_560), "phase {phase_560}");
        assert!((1050..1200).contains(&phase_1050), "phase {phase_1050}");
    }

    #[test]
    fn the_sweep_clock_restarts_on_entry_and_reopen_but_not_on_repaint() {
        let mut app = app();
        open_models(&mut app);
        for _ in 0..3 {
            app.panel.cycle_effort(&app.controls, 1);
        }
        assert!(matches!(
            effort_area(&app),
            EffortArea::Levels {
                selected: Some(2),
                ..
            }
        ));
        assert!(app.sweep_anim_start.is_none());
        let max_clock = app.effort_anim_start;
        app.tick();
        assert!(app.sweep_anim_start.is_some(), "entry starts the clock");
        assert_eq!(
            app.effort_anim_start, max_clock,
            "the sweep entry must not reset the Max clock"
        );

        app.sweep_anim_start = Some(Instant::now() - Duration::from_millis(900));
        app.tick();
        let kept = app.sweep_anim_start.expect("clock keeps running");
        assert!(
            kept.elapsed() >= Duration::from_millis(900),
            "a repaint must not restart the sweep"
        );

        app.panel.close();
        app.tick();
        assert!(app.sweep_anim_start.is_none(), "closing stops the clock");

        app.panel.open(PanelMode::Models);
        for _ in 0..3 {
            app.panel.cycle_effort(&app.controls, 1);
        }
        app.tick();
        let restarted = app.sweep_anim_start.expect("reopen starts the clock");
        assert!(
            restarted.elapsed() < Duration::from_millis(200),
            "reopening restarts from the left"
        );
    }

    #[test]
    fn the_drawn_sweep_bar_follows_the_sweep_clock() {
        let mut app = app();
        open_models(&mut app);
        for _ in 0..3 {
            app.panel.cycle_effort(&app.controls, 1);
        }
        let bar_row = |app: &mut App| -> Vec<Color> {
            let frame = buffer(app, 100, 30);
            let labels_y = (0..30)
                .find(|y| {
                    (0..100)
                        .map(|x| frame[(x, *y)].symbol())
                        .collect::<String>()
                        .contains("XHigh")
                })
                .expect("labels row");
            (2..98).map(|x| frame[(x, labels_y - 1)].bg).collect()
        };
        app.sweep_anim_start = Some(Instant::now() - Duration::from_millis(350));
        let left = bar_row(&mut app);
        app.sweep_anim_start = Some(Instant::now() - Duration::from_millis(700));
        let middle = bar_row(&mut app);
        assert_ne!(left, middle, "the drawn bar must follow the sweep clock");
    }

    #[test]
    fn effort_labels_keep_the_current_level_visible_at_narrow_widths() {
        let colors = Theme::Dark.colors();
        let levels = vec![
            ("low".to_string(), "Low".to_string()),
            ("high".to_string(), "High".to_string()),
            ("xhigh".to_string(), "XHigh".to_string()),
            ("max".to_string(), "Max".to_string()),
        ];
        let line = effort_labels_line(&levels, Some(2), 60, colors, 0, true);
        assert!(line.to_string().contains("XHigh"), "{line:?}");
        assert!(line.spans.iter().any(|span| {
            span.style.fg == Some(colors.accent) && span.content.contains("XHigh")
        }));
        let narrow = effort_labels_line(&levels, Some(2), 16, colors, 0, true);
        assert!(
            narrow.to_string().contains("XHigh"),
            "current label survives a narrow track: {narrow:?}"
        );
    }

    #[test]
    fn duplicate_model_names_gain_the_provider_name() {
        let rows = vec![
            PanelRow {
                group: Some("Alpha".into()),
                label: "Chat".into(),
                detail: None,
                current: false,
                disabled: None,
                action: PanelAction::Close,
            },
            PanelRow {
                group: Some("Beta".into()),
                label: "Chat".into(),
                detail: None,
                current: false,
                disabled: None,
                action: PanelAction::Close,
            },
            PanelRow {
                group: Some("Alpha".into()),
                label: "Solo".into(),
                detail: None,
                current: false,
                disabled: None,
                action: PanelAction::Close,
            },
        ];
        assert_eq!(duplicate_label_flags(&rows), vec![true, true, false]);
        let colors = Theme::Dark.colors();
        let line = models_row_line(&rows[0], true, 80, colors, true);
        assert!(
            line.spans
                .iter()
                .any(|span| span.content.contains("Alpha") && span.style.fg == Some(colors.muted)),
            "provider suffix stays muted: {line:?}"
        );
    }

    #[test]
    fn shrinking_the_catalog_clamps_the_models_selection() {
        let mut app = app();
        open_models(&mut app);
        app.panel.move_down(3);
        app.panel.move_down(3);
        assert_eq!(app.panel.selected(), 2);
        app.controls
            .apply_catalog(&json!({
                "default": {"provider": "p", "model": "chat"},
                "routableProviders": ["p"],
                "groups": [{
                    "id": "p",
                    "name": "Provider",
                    "models": [{"id": "chat", "name": "Chat"}]
                }],
                "failures": []
            }))
            .expect("smaller catalog");
        let rows = screen(&mut app, 100, 30);
        let joined = compact(&rows);
        assert_eq!(app.panel.selected(), 0);
        assert!(
            joined.iter().any(|row| row.contains("▶Chat")),
            "the surviving row stays visible: {joined:?}"
        );
        assert!(
            joined
                .iter()
                .any(|row| row.contains("强度：该模型未声明（不可调）")),
            "the effort area follows the clamped row: {joined:?}"
        );
    }

    #[test]
    fn an_unadvertised_explicit_effort_is_labelled_as_default_on_submit() {
        let mut app = app();
        app.controls.set_capabilities(true, true, true);
        app.controls
            .apply_state(&json!({
                "address": {"rootSessionId": "root"},
                "model": {"lastUsed": null, "next": {"provider": "p", "model": "chat", "reasoningEffort": "max"}},
                "permission": {"current": null, "catalog": {"options": [], "defaultOptions": [], "defaultPreset": ""}},
                "commands": []
            }))
            .expect("state");
        app.controls
            .apply_catalog(&json!({
                "default": {"provider": "p", "model": "chat"},
                "routableProviders": ["p"],
                "groups": [{
                    "id": "p",
                    "name": "Provider",
                    "models": [{"id": "chat", "name": "Chat", "reasoning": {
                        "efforts": [{"id": "low", "name": "Low"}, {"id": "high", "name": "High"}],
                        "defaultEffort": "low"
                    }}]
                }],
                "failures": []
            }))
            .expect("catalog");
        app.panel.open(PanelMode::Models);
        let header = models_header_text(&app);
        assert!(
            header.contains("max（目录未声明，提交将用默认）"),
            "the panel warns before the silent default: {header}"
        );
    }

    #[test]
    fn unavailable_and_disabled_models_explain_the_missing_track() {
        let mut app = app();
        open_models(&mut app);
        app.panel.move_down(3);
        assert!(matches!(effort_area(&app), EffortArea::Unavailable));
        let lines = models_effort_lines(&app, 40);
        assert!(
            lines[0].to_string().contains("该模型未声明（不可调）"),
            "{lines:?}"
        );
        app.panel.move_down(3);
        assert!(matches!(effort_area(&app), EffortArea::Disabled));
        let lines = models_effort_lines(&app, 40);
        assert!(lines[0].to_string().contains("强度：—"), "{lines:?}");
    }

    #[test]
    fn enter_on_a_failed_provider_shows_its_reason_inside_the_panel() {
        let mut app = app();
        open_models(&mut app);
        app.panel.move_down(3);
        app.panel.move_down(3);
        assert!(app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        assert!(app.error.is_some());
        let rows = screen(&mut app, 100, 30);
        let joined = compact(&rows);
        assert!(
            joined.iter().any(|row| row.contains("nocredentials")),
            "the failure reason is visible while the status bar is hidden: {joined:?}"
        );
    }

    #[test]
    fn overlapping_wide_effort_labels_keep_the_active_label() {
        let colors = Theme::Dark.colors();
        let levels = vec![
            ("low".to_string(), "低".to_string()),
            ("mid".to_string(), "中".to_string()),
            ("high".to_string(), "高".to_string()),
            ("max".to_string(), "极高".to_string()),
        ];
        let line = effort_labels_line(&levels, Some(3), 5, colors, 0, true);
        assert!(
            line.to_string().contains("极高"),
            "the active label stays whole: {line:?}"
        );
    }

    #[test]
    fn effort_animation_stops_when_full_screen_views_cover_the_panel() {
        let mut app = app();
        open_models(&mut app);
        for _ in 0..3 {
            app.panel.cycle_effort(&app.controls, 1);
        }
        assert!(effort_animation_active(&app));
        app.schedule.open = true;
        assert!(!effort_animation_active(&app));
        app.schedule.open = false;
        assert!(effort_animation_active(&app));
    }

    #[test]
    fn a_short_terminal_keeps_the_effort_labels() {
        let mut app = app();
        open_models(&mut app);
        let rows = screen(&mut app, 100, 10);
        let joined = compact(&rows);
        assert!(
            joined.iter().any(|row| row.contains("模型")),
            "header survives: {joined:?}"
        );
        assert!(
            joined.iter().any(|row| row.contains("LowHighXHighMax")),
            "labels survive a short terminal: {joined:?}"
        );
    }

    #[test]
    fn the_command_ghost_renders_after_the_caret_without_changing_the_draft() {
        let mut app = app();
        app.controls.set_capabilities(true, true, true);
        for character in "/perm".chars() {
            app.handle_key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
        }
        let rows = screen(&mut app, 100, 30);
        let row = rows
            .iter()
            .find(|row| row.contains("> /perm"))
            .expect("draft row");
        assert!(row.contains("> /permission"), "{row:?}");
        assert_eq!(app.drafts.current().text(), "/perm");
    }

    #[test]
    fn a_click_places_the_caret_and_a_drag_selects() {
        let mut app = app();
        app.drafts.current_mut().set_text("hello world");
        let _ = screen(&mut app, 100, 30);
        let area = app.input_area;
        let x = area.x + 2 + 2;
        let y = area.y;
        app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: x,
            row: y,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(app.drafts.current().cursor(), 2);
        app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Drag(MouseButton::Left),
            column: x + 3,
            row: y,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(app.drafts.current().selected_text(), Some("llo"));
        app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column: x + 3,
            row: y,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(app.drafts.current().selected_text(), Some("llo"));
    }

    #[test]
    fn selected_input_text_uses_the_selected_background() {
        let mut app = app();
        app.drafts.current_mut().set_text("hello world");
        app.drafts.current_mut().set_cursor(0);
        app.drafts.current_mut().select_to(5);
        let rows = screen(&mut app, 100, 30);
        let (y, x) = rows
            .iter()
            .enumerate()
            .find_map(|(y, row)| row.find("hello world").map(|x| (y as u16, x as u16)))
            .expect("draft row");
        let selected = app.theme.colors().selected_bg;
        for offset in 0..5 {
            let bg = screen_bg(&mut app, 100, 30, x + offset, y);
            assert_eq!(bg, selected, "selected cell {offset} uses selected_bg");
        }
        let unselected = screen_bg(&mut app, 100, 30, x + 5, y);
        assert_ne!(
            unselected, selected,
            "the space after the selection is plain"
        );
    }

    #[test]
    fn a_focused_dock_row_uses_a_hover_background() {
        let mut app = app();
        install_subagents(
            &mut app,
            serde_json::json!([subagent_row("child", "continuable")]),
        );
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        let _ = screen(&mut app, 100, 30);
        let y = app.subagent_dock_area.y + 1;
        let bg = screen_bg(&mut app, 100, 30, 5, y);
        let hover = app.theme.colors().hover_bg;
        assert!(
            bg == hover,
            "focused dock row uses the hover token, got {bg:?}"
        );
    }

    /// Thinking-expanded evidence lives outside the large scenario match so
    /// its extra App temporaries do not grow that function's stack frame.
    fn evidence_thinking_scenario(name: &str) -> Option<(App, u16, u16, bool)> {
        let light = || {
            App::with_theme(
                crate::cli::Cli::default(),
                "root".to_string(),
                false,
                Theme::Light,
            )
        };
        match name {
            "process-thinking-expanded-100-dark" => {
                Some((evidence_process_thinking(app()), 100, 36, false))
            }
            "process-thinking-expanded-60-light" => {
                Some((evidence_process_thinking(light()), 60, 30, false))
            }
            "process-thinking-expanded-100-light" => {
                Some((evidence_process_thinking(light()), 100, 36, false))
            }
            "process-thinking-expanded-60-dark" => {
                Some((evidence_process_thinking(app()), 60, 30, false))
            }
            _ => None,
        }
    }

    fn evidence_process_thinking(mut app: App) -> App {
        let mut app = evidence_process_display(app, false);
        app.view.reveal("preview-a-1");
        app.transcript_dirty = true;
        app
    }

    /// Evidence-only renderer. It draws a synthetic state through the real
    /// `draw` path and prints the buffer as ANSI so a PTY capture can archive
    /// deterministic frames (including states a live host rarely reaches).
    /// Run with `NANO_EVIDENCE_SCENARIO=<name> cargo test -p nano-app
    /// evidence_frame -- --ignored --nocapture`.
    #[test]
    #[ignore = "evidence frame renderer; run with NANO_EVIDENCE_SCENARIO"]
    fn evidence_frame() {
        let scenario = std::env::var("NANO_EVIDENCE_SCENARIO").unwrap_or_default();
        let Some((mut app, width, height, show_cursor)) =
            evidence_thinking_scenario(&scenario).or_else(|| evidence_scenario(&scenario))
        else {
            panic!("unknown evidence scenario: {scenario}");
        };
        use ratatui::backend::{Backend, TestBackend};
        use ratatui::Terminal;
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal
            .draw(|frame| draw(frame, &mut app))
            .expect("draw the evidence frame");
        let buffer = terminal.backend().buffer().clone();
        let cursor = terminal
            .backend_mut()
            .get_cursor_position()
            .expect("test backend cursor");
        emit_ansi(&buffer, (cursor.x, cursor.y), show_cursor);
        std::thread::sleep(std::time::Duration::from_millis(3000));
    }

    /// Evidence-only sweep loop. It drives the real tick clock and prints
    /// time-stamped ANSI bar frames for at least two full 1400ms cycles.
    /// Run with `NANO_EVIDENCE_SCENARIO=xhigh-sweep-<width>-<theme>
    /// cargo test -p nano-app evidence_sweep -- --ignored --nocapture`.
    #[test]
    #[ignore = "evidence sweep loop; run with NANO_EVIDENCE_SCENARIO"]
    fn evidence_sweep() {
        let scenario = std::env::var("NANO_EVIDENCE_SCENARIO").unwrap_or_default();
        let light = || {
            App::with_theme(
                crate::cli::Cli::default(),
                "root".to_string(),
                false,
                Theme::Light,
            )
        };
        let (mut app, width) = match scenario.as_str() {
            "xhigh-sweep-100-dark" => (app(), 100u16),
            "xhigh-sweep-60-dark" => (app(), 60),
            "xhigh-sweep-100-light" => (light(), 100),
            "xhigh-sweep-60-light" => (light(), 60),
            other => panic!("unknown sweep scenario: {other}"),
        };
        open_models(&mut app);
        for _ in 0..3 {
            app.panel.cycle_effort(&app.controls, 1);
        }
        app.tick();
        let start = app.sweep_anim_start.expect("sweep clock");
        let levels = match effort_area(&app) {
            EffortArea::Levels { levels, .. } => levels,
            _ => panic!("expected effort levels"),
        };
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let mut terminal = Terminal::new(TestBackend::new(width, 2)).expect("sweep terminal");
        println!("# scenario={scenario} width={width} fixture=synthetic");
        let mut index = 0u64;
        while start.elapsed() < std::time::Duration::from_millis(3200) {
            app.tick();
            let phase = effort_phase(&app, true);
            let bar = effort_bar_line(&app, &levels, Some(2), width as usize, phase, true);
            let labels = effort_labels_line(
                &levels,
                Some(2),
                width as usize,
                app.theme.colors(),
                phase,
                app.reduced_motion,
            );
            terminal
                .draw(|f| {
                    f.render_widget(
                        Paragraph::new(Text::from(vec![bar.clone(), labels.clone()])),
                        f.area(),
                    );
                })
                .expect("draw sweep frame");
            let buffer = terminal.backend().buffer().clone();
            println!(
                "frame {index} t={}ms cycle={}ms",
                start.elapsed().as_millis(),
                phase % SWEEP_PERIOD_MS
            );
            emit_ansi(&buffer, (0, 0), false);
            println!();
            index += 1;
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        println!("# frames={index} elapsed={}ms", start.elapsed().as_millis());
    }

    fn evidence_scenario(name: &str) -> Option<(App, u16, u16, bool)> {
        let light = || {
            App::with_theme(
                crate::cli::Cli::default(),
                "root".to_string(),
                false,
                Theme::Light,
            )
        };
        match name {
            "main-empty" => Some((app(), 100, 36, true)),
            "main-typed" => {
                let mut app = app();
                app.drafts.current_mut().set_text("x");
                Some((app, 100, 36, true))
            }
            "main-60-light" => Some((light(), 60, 30, true)),
            "spacing-tool-thinking-answer-100-dark" => {
                Some((evidence_process_answer(app()), 100, 36, false))
            }
            "spacing-tool-thinking-answer-60-light" => {
                Some((evidence_process_answer(light()), 60, 30, false))
            }
            "spacing-tool-thinking-answer-100-light" => {
                Some((evidence_process_answer(light()), 100, 36, false))
            }
            "spacing-tool-thinking-answer-60-dark" => {
                Some((evidence_process_answer(app()), 60, 30, false))
            }
            "spacing-preview-answer-100-dark" => {
                Some((evidence_preview_section(app()), 100, 36, false))
            }
            "spacing-preview-answer-60-light" => {
                Some((evidence_preview_section(light()), 60, 30, false))
            }
            "main-dock-100-dark" => {
                let mut app = app();
                install_subagents(
                    &mut app,
                    serde_json::json!([subagent_row("child", "continuable")]),
                );
                Some((app, 100, 36, false))
            }
            "main-dock-60-light" => {
                let mut app = light();
                install_subagents(
                    &mut app,
                    serde_json::json!([subagent_row("child", "continuable")]),
                );
                Some((app, 60, 30, false))
            }
            "table-100" => Some((evidence_table(app()), 100, 36, false)),
            "table-60" => Some((evidence_table(light()), 60, 30, false)),
            "tool-unknown" => Some((evidence_tool(app(), "hello", None, false), 100, 36, false)),
            "tool-success-100-dark" => Some((
                evidence_tool(app(), "hello", Some(false), false),
                100,
                36,
                false,
            )),
            "tool-success-60-light" => Some((
                evidence_tool(light(), "hello", Some(false), false),
                60,
                30,
                false,
            )),
            "tool-success-expanded-100-dark" => Some((
                evidence_tool(app(), "hello", Some(false), true),
                100,
                36,
                false,
            )),
            "tool-failure-100-dark" => Some((
                evidence_tool(app(), "bad", Some(true), false),
                100,
                36,
                false,
            )),
            "tool-failure-60-light" => Some((
                evidence_tool(light(), "bad", Some(true), false),
                60,
                30,
                false,
            )),
            "tool-failure-expanded-100-dark" => Some((
                evidence_tool(app(), "bad", Some(true), true),
                100,
                36,
                false,
            )),
            "tool-unknown-60-light" => {
                Some((evidence_tool(light(), "hello", None, false), 60, 30, false))
            }
            "tool-unknown-expanded-100-dark" => {
                Some((evidence_tool(app(), "hello", None, true), 100, 36, false))
            }
            "tool-success-100-light" => Some((
                evidence_tool(light(), "hello", Some(false), false),
                100,
                36,
                false,
            )),
            "tool-success-60-dark" => Some((
                evidence_tool(app(), "hello", Some(false), false),
                60,
                30,
                false,
            )),
            "tool-failure-100-light" => Some((
                evidence_tool(light(), "bad", Some(true), false),
                100,
                36,
                false,
            )),
            "tool-failure-60-dark" => Some((
                evidence_tool(app(), "bad", Some(true), false),
                60,
                30,
                false,
            )),
            "tool-unknown-100-light" => {
                Some((evidence_tool(light(), "hello", None, false), 100, 36, false))
            }
            "tool-unknown-60-dark" => {
                Some((evidence_tool(app(), "hello", None, false), 60, 30, false))
            }
            "model-default-100-dark" => {
                let mut app = app();
                open_models(&mut app);
                Some((app, 100, 36, false))
            }
            "model-max-100-dark" => {
                let mut app = app();
                open_models(&mut app);
                for _ in 0..4 {
                    app.panel.cycle_effort(&app.controls, 1);
                }
                Some((app, 100, 36, false))
            }
            "model-reduced-motion-100-dark" => {
                let mut app = app();
                open_models(&mut app);
                for _ in 0..3 {
                    app.panel.cycle_effort(&app.controls, 1);
                }
                app.reduced_motion = true;
                Some((app, 100, 36, false))
            }
            "preview-live-gap-100" => Some((evidence_preview_gap(app()), 100, 36, false)),
            "preview-live-gap-60" => Some((evidence_preview_gap(light()), 60, 30, false)),
            "preview-live-truncated-100" => Some((evidence_preview_truncated(), 100, 36, false)),
            "preview-finished-unknown-100" => {
                Some((evidence_preview_finished(app(), "unknown"), 100, 36, false))
            }
            "preview-finished-unknown-60" => {
                Some((evidence_preview_finished(light(), "unknown"), 60, 30, false))
            }
            "preview-finished-abandoned-100" => Some((
                evidence_preview_finished(app(), "abandoned"),
                100,
                36,
                false,
            )),
            "preview-finished-abandoned-60" => Some((
                evidence_preview_finished(light(), "abandoned"),
                60,
                30,
                false,
            )),
            "model-default-100" => {
                let mut app = app();
                open_models(&mut app);
                Some((app, 100, 36, false))
            }
            "model-xhigh-100-560" => Some((evidence_sweep_fixture(app(), 560), 100, 36, false)),
            "model-xhigh-100-1050" => Some((evidence_sweep_fixture(app(), 1050), 100, 36, false)),
            "model-xhigh-100-light-560" => {
                Some((evidence_sweep_fixture(light(), 560), 100, 36, false))
            }
            "model-xhigh-100-light-1050" => {
                Some((evidence_sweep_fixture(light(), 1050), 100, 36, false))
            }
            "model-xhigh-60-light-560" => {
                Some((evidence_sweep_fixture(light(), 560), 60, 30, false))
            }
            "model-xhigh-60-light-1050" => {
                Some((evidence_sweep_fixture(light(), 1050), 60, 30, false))
            }
            "model-xhigh-60-dark-560" => Some((evidence_sweep_fixture(app(), 560), 60, 30, false)),
            "model-xhigh-60-dark-1050" => {
                Some((evidence_sweep_fixture(app(), 1050), 60, 30, false))
            }
            "process-collapsed-100-dark" => {
                Some((evidence_process_display(app(), false), 100, 36, false))
            }
            "process-collapsed-60-light" => {
                Some((evidence_process_display(light(), false), 60, 30, false))
            }
            "process-collapsed-100-light" => {
                Some((evidence_process_display(light(), false), 100, 36, false))
            }
            "process-collapsed-60-dark" => {
                Some((evidence_process_display(app(), false), 60, 30, false))
            }
            "process-expanded-100-dark" => {
                Some((evidence_process_group_expanded(app()), 100, 36, false))
            }
            "process-expanded-60-light" => {
                Some((evidence_process_group_expanded(light()), 60, 30, false))
            }
            "process-expanded-100-light" => {
                Some((evidence_process_group_expanded(light()), 100, 36, false))
            }
            "process-expanded-60-dark" => {
                Some((evidence_process_group_expanded(app()), 60, 30, false))
            }
            _ => None,
        }
    }

    /// A compact expanded group so the summary row and its body fit one frame.
    fn evidence_process_group_expanded(mut app: App) -> App {
        app.model.apply_event(
            "session.event",
            &serde_json::json!({
                "address": {"rootSessionId": "root"},
                "seq": 1,
                "type": "user/message",
                "data": {
                    "id": "u-1",
                    "role": "user",
                    "content": [{"type": "text", "text": "检查配置读取，修复空配置报错。"}],
                    "source": {"kind": "user"}
                }
            }),
        );
        for (seq, call_id, name, arguments, result) in [
            (
                2,
                "c-1",
                "read",
                r#"{"file_path":"src/tuiSettingsFile.ts"}"#,
                "export function readValues(raw) {\n  const doc = JSON.parse(raw)\n  return doc?.values ?? {}\n}",
            ),
            (
                4,
                "c-2",
                "read",
                r#"{"file_path":"src/config-reader.ts"}"#,
                "export function readValues(raw) {\n  return JSON.parse(raw)?.values ?? {}\n}",
            ),
            (
                6,
                "c-3",
                "grep",
                r#"{"pattern":"values ?? {}"}"#,
                "src/tuiSettingsFile.ts:3: return doc?.values ?? {}\nsrc/config-reader.ts:2: return JSON.parse(raw)?.values ?? {}",
            ),
        ] {
            app.model.apply_event(
                "session.event",
                &serde_json::json!({
                    "address": {"rootSessionId": "root"},
                    "seq": seq,
                    "type": "tool/call",
                    "data": {
                        "turn": 1,
                        "step": 1,
                        "callId": call_id,
                        "name": name,
                        "arguments": arguments
                    }
                }),
            );
            app.model.apply_event(
                "session.event",
                &serde_json::json!({
                    "address": {"rootSessionId": "root"},
                    "seq": seq + 1,
                    "type": "tool/result",
                    "data": {
                        "turn": 1,
                        "step": 1,
                        "message": {
                            "id": format!("t-{call_id}"),
                            "role": "tool",
                            "toolCallId": call_id,
                            "isError": false,
                            "content": [{"type": "text", "text": result}]
                        }
                    }
                }),
            );
        }
        app.view.reveal("call-c-1");
        app.transcript_dirty = true;
        app
    }

    /// Deterministic process-display scene: grouped reads/searches, one
    /// successful Bash card, one failed read that splits the run, and a live
    /// thinking stream with its body.
    fn evidence_process_display(mut app: App, expanded: bool) -> App {
        app.model.apply_event(
            "session.event",
            &serde_json::json!({
                "address": {"rootSessionId": "root"},
                "seq": 1,
                "type": "user/message",
                "data": {
                    "id": "u-1",
                    "role": "user",
                    "content": [{"type": "text", "text": "检查配置读取，修复空配置报错，再跑验证。"}],
                    "source": {"kind": "user"}
                }
            }),
        );
        let mut seq = 2;
        let mut call = |app: &mut App,
                        seq: &mut u64,
                        call_id: &str,
                        name: &str,
                        arguments: &str,
                        result: &str,
                        is_error: bool| {
            app.model.apply_event(
                "session.event",
                &serde_json::json!({
                    "address": {"rootSessionId": "root"},
                    "seq": *seq,
                    "type": "tool/call",
                    "data": {
                        "turn": 1,
                        "step": 1,
                        "callId": call_id,
                        "name": name,
                        "arguments": arguments
                    }
                }),
            );
            *seq += 1;
            let mut message = serde_json::json!({
                "id": format!("t-{call_id}"),
                "role": "tool",
                "toolCallId": call_id,
                "content": [{"type": "text", "text": result}]
            });
            message["isError"] = serde_json::json!(is_error);
            app.model.apply_event(
                "session.event",
                &serde_json::json!({
                    "address": {"rootSessionId": "root"},
                    "seq": *seq,
                    "type": "tool/result",
                    "data": {"turn": 1, "step": 1, "message": message}
                }),
            );
            *seq += 1;
        };
        call(
            &mut app,
            &mut seq,
            "c-1",
            "read",
            r#"{"file_path":"src/tuiSettingsFile.ts"}"#,
            "export function readValues(raw) {\n  const doc = JSON.parse(raw)\n  return doc?.values ?? {}\n}",
            false,
        );
        call(
            &mut app,
            &mut seq,
            "c-2",
            "read",
            r#"{"file_path":"src/config-reader.ts"}"#,
            "export function readValues(raw) {\n  return JSON.parse(raw)?.values ?? {}\n}",
            false,
        );
        call(
            &mut app,
            &mut seq,
            "c-3",
            "grep",
            r#"{"pattern":"values ?? {}"}"#,
            "src/tuiSettingsFile.ts:3: return doc?.values ?? {}\nsrc/config-reader.ts:2: return JSON.parse(raw)?.values ?? {}",
            false,
        );
        call(
            &mut app,
            &mut seq,
            "c-4",
            "list",
            r#"{"path":"src"}"#,
            "config-reader.ts\ntuiSettingsFile.ts\nmain.ts",
            false,
        );
        call(
            &mut app,
            &mut seq,
            "c-5",
            "bash",
            r#"{"command":"node scripts/check-config.mjs"}"#,
            "PASS 空配置使用默认值\nPASS 无效 JSON 返回明确错误\n2 项检查通过",
            false,
        );
        call(
            &mut app,
            &mut seq,
            "c-6",
            "read",
            r#"{"file_path":"src/missing.ts"}"#,
            "Error: fixture file was not found\nThe requested test input could not be read.\nProcess exited with code 1.\nExtra detail stays hidden.",
            true,
        );
        call(
            &mut app,
            &mut seq,
            "c-7",
            "read",
            r#"{"file_path":"src/after-failure.ts"}"#,
            "export const afterFailure = true",
            false,
        );
        call(
            &mut app,
            &mut seq,
            "c-8",
            "toolsearch",
            "{}",
            "matched 2 tools\ntool schema loaded",
            false,
        );
        if expanded {
            app.view.reveal("call-c-1");
            app.transcript_dirty = true;
        }
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 1, "type": "start", "turn": 2, "step": 1
            }),
        );
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 2, "type": "chunk", "index": 0,
                "chunk": {"type": "reasoning-delta", "index": 0, "text": "先核对读取入口和两次检查结果。"}
            }),
        );
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 3, "type": "chunk", "index": 1,
                "chunk": {"type": "text-delta", "index": 0, "text": "我会先核对读取入口，再检查空配置和解析失败两条路径。"}
            }),
        );
        app
    }

    fn evidence_table(mut app: App) -> App {
        assistant_event(
            &mut app,
            1,
            "| 名称很长很长很长很长 | 状态说明文字 | 说明很长很长很长很长 | 备注很长很长很长很长 |\n| :--- | :---: | ---: | --- |\n| 内容很长很长很长很长 | 完成 | 更多说明很长很长很长很长 | 无 |\n| short | 失败 | 需要关注 | 中文长内容需要换行 |",
        );
        app
    }

    fn evidence_tool(mut app: App, output: &str, is_error: Option<bool>, expanded: bool) -> App {
        app.model.apply_event(
            "session.event",
            &serde_json::json!({
                "address": {"rootSessionId": "root"},
                "seq": 1,
                "type": "tool/call",
                "data": {
                    "turn": 1,
                    "step": 1,
                    "callId": "c-1",
                    "name": "bash",
                    "arguments": "{\"command\":\"echo hi\"}"
                }
            }),
        );
        let mut message = serde_json::json!({
            "id": "t-1",
            "role": "tool",
            "toolCallId": "c-1",
            "content": [{"type": "text", "text": output}]
        });
        if let Some(is_error) = is_error {
            message["isError"] = serde_json::json!(is_error);
        }
        app.model.apply_event(
            "session.event",
            &serde_json::json!({
                "address": {"rootSessionId": "root"},
                "seq": 2,
                "type": "tool/result",
                "data": {
                    "turn": 1,
                    "step": 1,
                    "message": message
                }
            }),
        );
        if expanded {
            app.view.reveal("call-c-1");
        }
        app.transcript_dirty = true;
        app
    }

    fn evidence_process_answer(mut app: App) -> App {
        app = evidence_tool(app, "ok", Some(false), false);
        let payload = serde_json::json!({
            "address": {"rootSessionId": "root"},
            "seq": 3,
            "type": "assistant/message",
            "data": {
                "turn": 1,
                "step": 1,
                "message": {
                    "id": "a-3",
                    "role": "assistant",
                    "content": [
                        {"type": "reasoning", "text": "先核对命令输出，再给出结论。"},
                        {"type": "text", "text": "一句话：这是 DeepSeek Harness 的终端界面。"}
                    ]
                },
                "stream": [{"type": "reasoning-chunks", "time0": 0, "dt": [2800]}]
            }
        });
        app.model.apply_event("session.event", &payload);
        app.view.apply_event("session.event", &payload);
        app.transcript_dirty = true;
        app
    }

    fn evidence_preview_section(mut app: App) -> App {
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 1, "type": "start", "turn": 1, "step": 1
            }),
        );
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 2, "type": "chunk", "index": 0,
                "chunk": {"type": "reasoning-delta", "index": 0, "text": "先想想。"}
            }),
        );
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 3, "type": "chunk", "index": 1,
                "chunk": {"type": "text-delta", "index": 0, "text": "流式正文。"}
            }),
        );
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 4, "type": "chunk", "index": 2,
                "chunk": {
                    "type": "tool-call-delta", "index": 0, "id": "c-1",
                    "name": "bash", "argumentsDelta": "{}"
                }
            }),
        );
        app
    }

    fn evidence_preview_gap(mut app: App) -> App {
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 1, "type": "start", "turn": 1, "step": 1
            }),
        );
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 2, "type": "chunk", "index": 0,
                "chunk": {"type": "text-delta", "index": 0, "text": "第一段已经到达。\n"}
            }),
        );
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 3, "type": "chunk", "index": 2,
                "chunk": {"type": "text-delta", "index": 1, "text": "这段被缺口跳过。"}
            }),
        );
        app
    }

    fn evidence_preview_truncated() -> App {
        let mut app = app();
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 1, "type": "start", "turn": 1, "step": 1
            }),
        );
        let huge = "x".repeat(nano_conversation::MAX_PREVIEW_BYTES + 1);
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 2, "type": "chunk", "index": 0,
                "chunk": {"type": "text-delta", "index": 0, "text": huge}
            }),
        );
        app
    }

    fn evidence_preview_finished(mut app: App, outcome: &str) -> App {
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 1, "type": "start", "turn": 1, "step": 1
            }),
        );
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 2, "type": "chunk", "index": 0,
                "chunk": {"type": "text-delta", "index": 0, "text": "已经收到的片段。"}
            }),
        );
        stream_event(
            &mut app,
            serde_json::json!({
                "attemptId": "a-1", "revision": 3, "type": "end", "index": 1,
                "outcome": {"kind": outcome}
            }),
        );
        app
    }

    fn evidence_sweep_fixture(mut app: App, phase_ms: u64) -> App {
        open_models(&mut app);
        app.panel.cycle_effort(&app.controls, 1);
        app.panel.cycle_effort(&app.controls, 1);
        app.panel.cycle_effort(&app.controls, 1);
        app.sweep_anim_start = Some(Instant::now() - std::time::Duration::from_millis(phase_ms));
        app
    }

    fn assistant_event(app: &mut App, seq: u64, text: &str) {
        app.model.apply_event(
            "session.event",
            &serde_json::json!({
                "address": {"rootSessionId": "root"},
                "seq": seq,
                "type": "assistant/message",
                "data": {
                    "turn": 1,
                    "step": 1,
                    "message": {
                        "id": format!("a-{seq}"),
                        "role": "assistant",
                        "content": [{"type": "text", "text": text}]
                    }
                }
            }),
        );
        app.transcript_dirty = true;
    }

    fn stream_event(app: &mut App, frame: serde_json::Value) {
        app.model.apply_event(
            "conversation.stream",
            &serde_json::json!({
                "address": {"rootSessionId": "root"},
                "frame": frame
            }),
        );
        app.transcript_dirty = true;
    }

    fn emit_ansi(buffer: &ratatui::buffer::Buffer, cursor: (u16, u16), show_cursor: bool) {
        use std::fmt::Write as _;
        use std::io::Write as _;
        let mut out = String::new();
        out.push_str("\x1b[2J");
        for y in 0..buffer.area.height {
            let _ = write!(out, "\x1b[{};1H", y.saturating_add(1));
            let mut x = 0u16;
            while x < buffer.area.width {
                let cell = &buffer[(x, y)];
                let mut params: Vec<String> = Vec::new();
                if let Color::Rgb(r, g, b) = cell.fg {
                    params.push(format!("38;2;{r};{g};{b}"));
                }
                if let Color::Rgb(r, g, b) = cell.bg {
                    params.push(format!("48;2;{r};{g};{b}"));
                }
                if cell.modifier.contains(Modifier::BOLD) {
                    params.push("1".to_string());
                }
                if !params.is_empty() {
                    let _ = write!(out, "\x1b[{}m", params.join(";"));
                }
                out.push_str(cell.symbol());
                if !params.is_empty() {
                    out.push_str("\x1b[0m");
                }
                let advance = cell
                    .symbol()
                    .chars()
                    .next()
                    .map(display_width)
                    .unwrap_or(0)
                    .max(1) as u16;
                x = x.saturating_add(advance);
            }
            // Cancel the terminal's pending wrap at the last column so the
            // next absolute row placement does not scroll the pane.
            out.push('\r');
        }
        if show_cursor {
            let _ = write!(
                out,
                "\x1b[{};{}H\x1b[?25h",
                cursor.1.saturating_add(1),
                cursor.0.saturating_add(1)
            );
        } else {
            out.push_str("\x1b[?25l");
        }
        print!("{out}");
        std::io::stdout().flush().ok();
    }
}
