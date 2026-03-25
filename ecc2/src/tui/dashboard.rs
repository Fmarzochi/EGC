use ratatui::{
    prelude::*,
    widgets::{
        Block, Borders, Cell, HighlightSpacing, Paragraph, Row, Table, TableState, Tabs, Wrap,
    },
};

use super::widgets::{budget_state, format_currency, format_token_count, BudgetState, TokenMeter};
use crate::config::Config;
use crate::session::store::StateStore;
use crate::session::{Session, SessionState};

pub struct Dashboard {
    db: StateStore,
    cfg: Config,
    sessions: Vec<Session>,
    selected_pane: Pane,
    selected_session: usize,
    show_help: bool,
    scroll_offset: usize,
    session_table_state: TableState,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct SessionSummary {
    total: usize,
    pending: usize,
    running: usize,
    idle: usize,
    completed: usize,
    failed: usize,
    stopped: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Pane {
    Sessions,
    Output,
    Metrics,
}

#[derive(Debug, Clone, Copy)]
struct AggregateUsage {
    total_tokens: u64,
    total_cost_usd: f64,
    token_state: BudgetState,
    cost_state: BudgetState,
    overall_state: BudgetState,
}

impl Dashboard {
    pub fn new(db: StateStore, cfg: Config) -> Self {
        let sessions = db.list_sessions().unwrap_or_default();
        let mut session_table_state = TableState::default();
        if !sessions.is_empty() {
            session_table_state.select(Some(0));
        }

        Self {
            db,
            cfg,
            sessions,
            selected_pane: Pane::Sessions,
            selected_session: 0,
            show_help: false,
            scroll_offset: 0,
            session_table_state,
        }
    }

    pub fn render(&mut self, frame: &mut Frame) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Min(10),
                Constraint::Length(3),
            ])
            .split(frame.area());

        self.render_header(frame, chunks[0]);

        if self.show_help {
            self.render_help(frame, chunks[1]);
        } else {
            let main_chunks = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(chunks[1]);

            self.render_sessions(frame, main_chunks[0]);

            let right_chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Percentage(70), Constraint::Percentage(30)])
                .split(main_chunks[1]);

            self.render_output(frame, right_chunks[0]);
            self.render_metrics(frame, right_chunks[1]);
        }

        self.render_status_bar(frame, chunks[2]);
    }

    fn render_header(&self, frame: &mut Frame, area: Rect) {
        let running = self
            .sessions
            .iter()
            .filter(|session| session.state == SessionState::Running)
            .count();
        let total = self.sessions.len();

        let title = format!(" ECC 2.0 | {running} running / {total} total ");
        let tabs = Tabs::new(vec!["Sessions", "Output", "Metrics"])
            .block(Block::default().borders(Borders::ALL).title(title))
            .select(match self.selected_pane {
                Pane::Sessions => 0,
                Pane::Output => 1,
                Pane::Metrics => 2,
            })
            .highlight_style(
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            );

        frame.render_widget(tabs, area);
    }

    fn render_sessions(&mut self, frame: &mut Frame, area: Rect) {
        let border_style = if self.selected_pane == Pane::Sessions {
            Style::default().fg(Color::Cyan)
        } else {
            Style::default()
        };

        let block = Block::default()
            .borders(Borders::ALL)
            .title(" Sessions ")
            .border_style(border_style);
        let inner_area = block.inner(area);
        frame.render_widget(block, area);

        if inner_area.is_empty() {
            return;
        }

        let summary = SessionSummary::from_sessions(&self.sessions);
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(1), Constraint::Min(3)])
            .split(inner_area);

        frame.render_widget(Paragraph::new(summary_line(&summary)), chunks[0]);

        let rows = self.sessions.iter().map(session_row);
        let header = Row::new(["ID", "Agent", "State", "Branch", "Tokens", "Duration"])
            .style(Style::default().add_modifier(Modifier::BOLD));
        let widths = [
            Constraint::Length(8),
            Constraint::Length(10),
            Constraint::Length(10),
            Constraint::Min(12),
            Constraint::Length(8),
            Constraint::Length(8),
        ];

        let table = Table::new(rows, widths)
            .header(header)
            .column_spacing(1)
            .highlight_symbol(">> ")
            .highlight_spacing(HighlightSpacing::Always)
            .row_highlight_style(
                Style::default()
                    .bg(Color::DarkGray)
                    .add_modifier(Modifier::BOLD),
            );

        let selected = if self.sessions.is_empty() {
            None
        } else {
            Some(self.selected_session.min(self.sessions.len() - 1))
        };
        if self.session_table_state.selected() != selected {
            self.session_table_state.select(selected);
        }

        frame.render_stateful_widget(table, chunks[1], &mut self.session_table_state);
    }

    fn render_output(&self, frame: &mut Frame, area: Rect) {
        let content = if let Some(session) = self.sessions.get(self.selected_session) {
            format!(
                "Agent output for session {}...\n\n(Live streaming coming soon)",
                session.id
            )
        } else {
            "No sessions. Press 'n' to start one.".to_string()
        };

        let border_style = if self.selected_pane == Pane::Output {
            Style::default().fg(Color::Cyan)
        } else {
            Style::default()
        };

        let paragraph = Paragraph::new(content).block(
            Block::default()
                .borders(Borders::ALL)
                .title(" Output ")
                .border_style(border_style),
        );
        frame.render_widget(paragraph, area);
    }

    fn render_metrics(&self, frame: &mut Frame, area: Rect) {
        let border_style = if self.selected_pane == Pane::Metrics {
            Style::default().fg(Color::Cyan)
        } else {
            Style::default()
        };

        let block = Block::default()
            .borders(Borders::ALL)
            .title(" Metrics ")
            .border_style(border_style);
        let inner = block.inner(area);
        frame.render_widget(block, area);

        if inner.is_empty() {
            return;
        }

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(2),
                Constraint::Length(2),
                Constraint::Min(1),
            ])
            .split(inner);

        let aggregate = self.aggregate_usage();
        frame.render_widget(
            TokenMeter::tokens(
                "Token Budget",
                aggregate.total_tokens,
                self.cfg.token_budget,
            ),
            chunks[0],
        );
        frame.render_widget(
            TokenMeter::currency(
                "Cost Budget",
                aggregate.total_cost_usd,
                self.cfg.cost_budget_usd,
            ),
            chunks[1],
        );
        frame.render_widget(
            Paragraph::new(self.selected_session_metrics_text()).wrap(Wrap { trim: true }),
            chunks[2],
        );
    }

    fn render_status_bar(&self, frame: &mut Frame, area: Rect) {
        let text = " [n]ew session  [s]top  [Tab] switch pane  [j/k] scroll  [?] help  [q]uit ";
        let aggregate = self.aggregate_usage();
        let (summary_text, summary_style) = self.aggregate_cost_summary();
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(aggregate.overall_state.style());
        let inner = block.inner(area);
        frame.render_widget(block, area);

        if inner.is_empty() {
            return;
        }

        let summary_width = summary_text
            .len()
            .min(inner.width.saturating_sub(1) as usize) as u16;
        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(1), Constraint::Length(summary_width)])
            .split(inner);

        frame.render_widget(
            Paragraph::new(text).style(Style::default().fg(Color::DarkGray)),
            chunks[0],
        );
        frame.render_widget(
            Paragraph::new(summary_text)
                .style(summary_style)
                .alignment(Alignment::Right),
            chunks[1],
        );
    }

    fn render_help(&self, frame: &mut Frame, area: Rect) {
        let help = vec![
            "Keyboard Shortcuts:",
            "",
            "  n       New session",
            "  s       Stop selected session",
            "  Tab     Next pane",
            "  S-Tab   Previous pane",
            "  j/↓     Scroll down",
            "  k/↑     Scroll up",
            "  r       Refresh",
            "  ?       Toggle help",
            "  q/C-c   Quit",
        ];

        let paragraph = Paragraph::new(help.join("\n")).block(
            Block::default()
                .borders(Borders::ALL)
                .title(" Help ")
                .border_style(Style::default().fg(Color::Yellow)),
        );
        frame.render_widget(paragraph, area);
    }

    pub fn next_pane(&mut self) {
        self.selected_pane = match self.selected_pane {
            Pane::Sessions => Pane::Output,
            Pane::Output => Pane::Metrics,
            Pane::Metrics => Pane::Sessions,
        };
    }

    pub fn prev_pane(&mut self) {
        self.selected_pane = match self.selected_pane {
            Pane::Sessions => Pane::Metrics,
            Pane::Output => Pane::Sessions,
            Pane::Metrics => Pane::Output,
        };
    }

    pub fn scroll_down(&mut self) {
        if self.selected_pane == Pane::Sessions && !self.sessions.is_empty() {
            self.selected_session = (self.selected_session + 1).min(self.sessions.len() - 1);
            self.session_table_state.select(Some(self.selected_session));
        } else {
            self.scroll_offset = self.scroll_offset.saturating_add(1);
        }
    }

    pub fn scroll_up(&mut self) {
        if self.selected_pane == Pane::Sessions {
            self.selected_session = self.selected_session.saturating_sub(1);
            if !self.sessions.is_empty() {
                self.session_table_state.select(Some(self.selected_session));
            }
        } else {
            self.scroll_offset = self.scroll_offset.saturating_sub(1);
        }
    }

    pub fn new_session(&mut self) {
        tracing::info!("New session dialog requested");
    }

    pub fn stop_selected(&mut self) {
        if let Some(session) = self.sessions.get(self.selected_session) {
            let _ = self.db.update_state(&session.id, &SessionState::Stopped);
            self.refresh();
        }
    }

    pub fn refresh(&mut self) {
        self.sessions = self.db.list_sessions().unwrap_or_default();
        self.sync_selection();
    }

    pub fn toggle_help(&mut self) {
        self.show_help = !self.show_help;
    }

    pub async fn tick(&mut self) {
        self.sessions = self.db.list_sessions().unwrap_or_default();
        self.sync_selection();
    }

    fn sync_selection(&mut self) {
        if self.sessions.is_empty() {
            self.selected_session = 0;
            self.session_table_state.select(None);
        } else {
            self.selected_session = self.selected_session.min(self.sessions.len() - 1);
            self.session_table_state.select(Some(self.selected_session));
        }
    }

    fn aggregate_usage(&self) -> AggregateUsage {
        let total_tokens = self
            .sessions
            .iter()
            .map(|session| session.metrics.tokens_used)
            .sum();
        let total_cost_usd = self
            .sessions
            .iter()
            .map(|session| session.metrics.cost_usd)
            .sum::<f64>();
        let token_state = budget_state(total_tokens as f64, self.cfg.token_budget as f64);
        let cost_state = budget_state(total_cost_usd, self.cfg.cost_budget_usd);

        AggregateUsage {
            total_tokens,
            total_cost_usd,
            token_state,
            cost_state,
            overall_state: token_state.max(cost_state),
        }
    }

    fn selected_session_metrics_text(&self) -> String {
        if let Some(session) = self.sessions.get(self.selected_session) {
            let metrics = &session.metrics;
            format!(
                "Selected {} [{}]\nTokens {} | Tools {} | Files {}\nCost ${:.4} | Duration {}s",
                &session.id[..8.min(session.id.len())],
                session.state,
                format_token_count(metrics.tokens_used),
                metrics.tool_calls,
                metrics.files_changed,
                metrics.cost_usd,
                metrics.duration_secs
            )
        } else {
            "No metrics available".to_string()
        }
    }

    fn aggregate_cost_summary(&self) -> (String, Style) {
        let aggregate = self.aggregate_usage();
        let mut text = if self.cfg.cost_budget_usd > 0.0 {
            format!(
                "Aggregate cost {} / {}",
                format_currency(aggregate.total_cost_usd),
                format_currency(self.cfg.cost_budget_usd),
            )
        } else {
            format!(
                "Aggregate cost {} (no budget)",
                format_currency(aggregate.total_cost_usd)
            )
        };

        match aggregate.overall_state {
            BudgetState::Warning => text.push_str(" | Budget warning"),
            BudgetState::OverBudget => text.push_str(" | Budget exceeded"),
            _ => {}
        }

        (text, aggregate.overall_state.style())
    }

    fn aggregate_cost_summary_text(&self) -> String {
        self.aggregate_cost_summary().0
    }
}

impl SessionSummary {
    fn from_sessions(sessions: &[Session]) -> Self {
        sessions.iter().fold(
            Self {
                total: sessions.len(),
                ..Self::default()
            },
            |mut summary, session| {
                match session.state {
                    SessionState::Pending => summary.pending += 1,
                    SessionState::Running => summary.running += 1,
                    SessionState::Idle => summary.idle += 1,
                    SessionState::Completed => summary.completed += 1,
                    SessionState::Failed => summary.failed += 1,
                    SessionState::Stopped => summary.stopped += 1,
                }
                summary
            },
        )
    }
}

fn session_row(session: &Session) -> Row<'static> {
    Row::new(vec![
        Cell::from(format_session_id(&session.id)),
        Cell::from(session.agent_type.clone()),
        Cell::from(session_state_label(&session.state)).style(
            Style::default()
                .fg(session_state_color(&session.state))
                .add_modifier(Modifier::BOLD),
        ),
        Cell::from(session_branch(session)),
        Cell::from(session.metrics.tokens_used.to_string()),
        Cell::from(format_duration(session.metrics.duration_secs)),
    ])
}

fn summary_line(summary: &SessionSummary) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            format!("Total {}  ", summary.total),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        summary_span("Running", summary.running, Color::Green),
        summary_span("Idle", summary.idle, Color::Yellow),
        summary_span("Completed", summary.completed, Color::Blue),
        summary_span("Failed", summary.failed, Color::Red),
        summary_span("Stopped", summary.stopped, Color::DarkGray),
        summary_span("Pending", summary.pending, Color::Reset),
    ])
}

fn summary_span(label: &str, value: usize, color: Color) -> Span<'static> {
    Span::styled(
        format!("{label} {value}  "),
        Style::default().fg(color).add_modifier(Modifier::BOLD),
    )
}

fn session_state_label(state: &SessionState) -> &'static str {
    match state {
        SessionState::Pending => "Pending",
        SessionState::Running => "Running",
        SessionState::Idle => "Idle",
        SessionState::Completed => "Completed",
        SessionState::Failed => "Failed",
        SessionState::Stopped => "Stopped",
    }
}

fn session_state_color(state: &SessionState) -> Color {
    match state {
        SessionState::Running => Color::Green,
        SessionState::Idle => Color::Yellow,
        SessionState::Failed => Color::Red,
        SessionState::Stopped => Color::DarkGray,
        SessionState::Completed => Color::Blue,
        SessionState::Pending => Color::Reset,
    }
}

fn format_session_id(id: &str) -> String {
    id.chars().take(8).collect()
}

fn session_branch(session: &Session) -> String {
    session
        .worktree
        .as_ref()
        .map(|worktree| worktree.branch.clone())
        .unwrap_or_else(|| "-".to_string())
}

fn format_duration(duration_secs: u64) -> String {
    let hours = duration_secs / 3600;
    let minutes = (duration_secs % 3600) / 60;
    let seconds = duration_secs % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use chrono::Utc;
    use ratatui::{backend::TestBackend, widgets::TableState, Terminal};

    use super::*;
    use crate::config::Config;
    use crate::session::store::StateStore;
    use crate::session::{SessionMetrics, WorktreeInfo};
    use crate::tui::widgets::BudgetState;

    #[test]
    fn session_state_color_matches_requested_palette() {
        assert_eq!(session_state_color(&SessionState::Running), Color::Green);
        assert_eq!(session_state_color(&SessionState::Idle), Color::Yellow);
        assert_eq!(session_state_color(&SessionState::Failed), Color::Red);
        assert_eq!(session_state_color(&SessionState::Stopped), Color::DarkGray);
        assert_eq!(session_state_color(&SessionState::Completed), Color::Blue);
    }

    #[test]
    fn session_summary_counts_each_state() {
        let sessions = vec![
            sample_session(
                "run-12345678",
                "planner",
                SessionState::Running,
                Some("feat/run"),
                128,
                15,
            ),
            sample_session(
                "idle-12345678",
                "reviewer",
                SessionState::Idle,
                Some("feat/idle"),
                256,
                30,
            ),
            sample_session(
                "done-12345678",
                "architect",
                SessionState::Completed,
                Some("feat/done"),
                512,
                45,
            ),
            sample_session(
                "fail-12345678",
                "worker",
                SessionState::Failed,
                Some("feat/fail"),
                1024,
                60,
            ),
            sample_session(
                "stop-12345678",
                "security",
                SessionState::Stopped,
                None,
                64,
                10,
            ),
            sample_session(
                "pend-12345678",
                "tdd",
                SessionState::Pending,
                Some("feat/pending"),
                32,
                5,
            ),
        ];

        let summary = SessionSummary::from_sessions(&sessions);

        assert_eq!(summary.total, 6);
        assert_eq!(summary.running, 1);
        assert_eq!(summary.idle, 1);
        assert_eq!(summary.completed, 1);
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.stopped, 1);
        assert_eq!(summary.pending, 1);
    }

    #[test]
    fn render_sessions_shows_summary_headers_and_selected_row() {
        let dashboard = test_dashboard(
            vec![
                sample_session(
                    "run-12345678",
                    "planner",
                    SessionState::Running,
                    Some("feat/run"),
                    128,
                    15,
                ),
                sample_session(
                    "done-87654321",
                    "reviewer",
                    SessionState::Completed,
                    Some("release/v1"),
                    2048,
                    125,
                ),
            ],
            1,
        );

        let rendered = render_dashboard_text(dashboard, 150, 24);

        assert!(rendered.contains("ID"));
        assert!(rendered.contains("Agent"));
        assert!(rendered.contains("State"));
        assert!(rendered.contains("Branch"));
        assert!(rendered.contains("Tokens"));
        assert!(rendered.contains("Duration"));
        assert!(rendered.contains("Total 2"));
        assert!(rendered.contains("Running 1"));
        assert!(rendered.contains("Completed 1"));
        assert!(rendered.contains(">> done-876"));
        assert!(rendered.contains("reviewer"));
        assert!(rendered.contains("release/v1"));
        assert!(rendered.contains("00:02:05"));
    }

    #[test]
    fn sync_selection_preserves_table_offset_for_selected_rows() {
        let mut dashboard = test_dashboard(
            vec![
                sample_session(
                    "run-12345678",
                    "planner",
                    SessionState::Running,
                    Some("feat/run"),
                    128,
                    15,
                ),
                sample_session(
                    "done-87654321",
                    "reviewer",
                    SessionState::Completed,
                    Some("release/v1"),
                    2048,
                    125,
                ),
            ],
            1,
        );
        *dashboard.session_table_state.offset_mut() = 3;

        dashboard.sync_selection();

        assert_eq!(dashboard.session_table_state.selected(), Some(1));
        assert_eq!(dashboard.session_table_state.offset(), 3);
    }

    #[test]
    fn aggregate_usage_sums_tokens_and_cost_with_warning_state() {
        let db = StateStore::open(Path::new(":memory:")).unwrap();
        let mut cfg = Config::default();
        cfg.token_budget = 10_000;
        cfg.cost_budget_usd = 10.0;

        let mut dashboard = Dashboard::new(db, cfg);
        dashboard.sessions = vec![
            budget_session("sess-1", 4_000, 3.50),
            budget_session("sess-2", 4_500, 4.80),
        ];

        let aggregate = dashboard.aggregate_usage();

        assert_eq!(aggregate.total_tokens, 8_500);
        assert!((aggregate.total_cost_usd - 8.30).abs() < 1e-9);
        assert_eq!(aggregate.token_state, BudgetState::Warning);
        assert_eq!(aggregate.cost_state, BudgetState::Warning);
        assert_eq!(aggregate.overall_state, BudgetState::Warning);
    }

    #[test]
    fn aggregate_cost_summary_mentions_total_cost() {
        let db = StateStore::open(Path::new(":memory:")).unwrap();
        let mut cfg = Config::default();
        cfg.cost_budget_usd = 10.0;

        let mut dashboard = Dashboard::new(db, cfg);
        dashboard.sessions = vec![budget_session("sess-1", 3_500, 8.25)];

        assert_eq!(
            dashboard.aggregate_cost_summary_text(),
            "Aggregate cost $8.25 / $10.00 | Budget warning"
        );
    }

    fn test_dashboard(sessions: Vec<Session>, selected_session: usize) -> Dashboard {
        let selected_session = selected_session.min(sessions.len().saturating_sub(1));
        let mut session_table_state = TableState::default();
        if !sessions.is_empty() {
            session_table_state.select(Some(selected_session));
        }

        Dashboard {
            db: test_store(),
            cfg: Config::default(),
            sessions,
            selected_pane: Pane::Sessions,
            selected_session,
            show_help: false,
            scroll_offset: 0,
            session_table_state,
        }
    }

    fn test_store() -> StateStore {
        StateStore::open(Path::new(":memory:")).expect("open test db")
    }

    fn sample_session(
        id: &str,
        agent_type: &str,
        state: SessionState,
        branch: Option<&str>,
        tokens_used: u64,
        duration_secs: u64,
    ) -> Session {
        Session {
            id: id.to_string(),
            task: "Render dashboard rows".to_string(),
            agent_type: agent_type.to_string(),
            state,
            pid: None,
            worktree: branch.map(|branch| WorktreeInfo {
                path: PathBuf::from(format!("/tmp/{branch}")),
                branch: branch.to_string(),
                base_branch: "main".to_string(),
            }),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            metrics: SessionMetrics {
                tokens_used,
                tool_calls: 4,
                files_changed: 2,
                duration_secs,
                cost_usd: 0.42,
            },
        }
    }

    fn budget_session(id: &str, tokens_used: u64, cost_usd: f64) -> Session {
        let now = Utc::now();
        Session {
            id: id.to_string(),
            task: "Budget tracking".to_string(),
            agent_type: "claude".to_string(),
            state: SessionState::Running,
            pid: None,
            worktree: None,
            created_at: now,
            updated_at: now,
            metrics: SessionMetrics {
                tokens_used,
                tool_calls: 0,
                files_changed: 0,
                duration_secs: 0,
                cost_usd,
            },
        }
    }

    fn render_dashboard_text(mut dashboard: Dashboard, width: u16, height: u16) -> String {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("create terminal");

        terminal
            .draw(|frame| dashboard.render(frame))
            .expect("render dashboard");

        let buffer = terminal.backend().buffer();
        buffer
            .content
            .chunks(buffer.area.width as usize)
            .map(|cells| cells.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }
}
