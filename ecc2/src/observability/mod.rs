use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::session::store::StateStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallEvent {
    pub session_id: String,
    pub tool_name: String,
    pub input_summary: String,
    pub output_summary: String,
    pub duration_ms: u64,
    pub risk_score: f64,
}

impl ToolCallEvent {
    pub fn new(
        session_id: impl Into<String>,
        tool_name: impl Into<String>,
        input_summary: impl Into<String>,
        output_summary: impl Into<String>,
        duration_ms: u64,
    ) -> Self {
        let tool_name = tool_name.into();
        let input_summary = input_summary.into();

        Self {
            session_id: session_id.into(),
            risk_score: Self::compute_risk(&tool_name, &input_summary),
            tool_name,
            input_summary,
            output_summary: output_summary.into(),
            duration_ms,
        }
    }

    /// Compute risk score based on tool type and input patterns.
    pub fn compute_risk(tool_name: &str, input: &str) -> f64 {
        let mut score: f64 = 0.0;

        // Destructive tools get higher base risk
        match tool_name {
            "Bash" => score += 0.3,
            "Write" => score += 0.2,
            "Edit" => score += 0.1,
            _ => score += 0.05,
        }

        // Dangerous patterns in bash commands
        if tool_name == "Bash" {
            if input.contains("rm -rf") || input.contains("--force") {
                score += 0.4;
            }
            if input.contains("git push") || input.contains("git reset") {
                score += 0.3;
            }
            if input.contains("sudo") || input.contains("chmod 777") {
                score += 0.5;
            }
        }

        score.min(1.0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolLogEntry {
    pub id: i64,
    pub session_id: String,
    pub tool_name: String,
    pub input_summary: String,
    pub output_summary: String,
    pub duration_ms: u64,
    pub risk_score: f64,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolLogPage {
    pub entries: Vec<ToolLogEntry>,
    pub page: u64,
    pub page_size: u64,
    pub total: u64,
}

pub struct ToolLogger<'a> {
    db: &'a StateStore,
}

impl<'a> ToolLogger<'a> {
    pub fn new(db: &'a StateStore) -> Self {
        Self { db }
    }

    pub fn log(&self, event: &ToolCallEvent) -> Result<ToolLogEntry> {
        let timestamp = chrono::Utc::now().to_rfc3339();

        self.db.insert_tool_log(
            &event.session_id,
            &event.tool_name,
            &event.input_summary,
            &event.output_summary,
            event.duration_ms,
            event.risk_score,
            &timestamp,
        )
    }

    pub fn query(&self, session_id: &str, page: u64, page_size: u64) -> Result<ToolLogPage> {
        if page_size == 0 {
            bail!("page_size must be greater than 0");
        }

        self.db.query_tool_logs(session_id, page.max(1), page_size)
    }
}

pub fn log_tool_call(db: &StateStore, event: &ToolCallEvent) -> Result<ToolLogEntry> {
    ToolLogger::new(db).log(event)
}

#[cfg(test)]
mod tests {
    use super::{ToolCallEvent, ToolLogger};
    use crate::session::store::StateStore;
    use crate::session::{Session, SessionMetrics, SessionState};
    use std::path::PathBuf;

    fn test_db_path() -> PathBuf {
        std::env::temp_dir().join(format!("ecc2-observability-{}.db", uuid::Uuid::new_v4()))
    }

    fn test_session(id: &str) -> Session {
        let now = chrono::Utc::now();

        Session {
            id: id.to_string(),
            task: "test task".to_string(),
            agent_type: "claude".to_string(),
            state: SessionState::Pending,
            pid: None,
            worktree: None,
            created_at: now,
            updated_at: now,
            metrics: SessionMetrics::default(),
        }
    }

    #[test]
    fn compute_risk_caps_high_risk_bash_commands() {
        let score = ToolCallEvent::compute_risk("Bash", "sudo rm -rf /tmp --force");
        assert_eq!(score, 1.0);
    }

    #[test]
    fn logger_persists_entries_and_paginates() -> anyhow::Result<()> {
        let db_path = test_db_path();
        let db = StateStore::open(&db_path)?;
        db.insert_session(&test_session("sess-1"))?;

        let logger = ToolLogger::new(&db);

        logger.log(&ToolCallEvent::new("sess-1", "Read", "first", "ok", 5))?;
        logger.log(&ToolCallEvent::new("sess-1", "Write", "second", "ok", 15))?;
        logger.log(&ToolCallEvent::new("sess-1", "Bash", "third", "ok", 25))?;

        let first_page = logger.query("sess-1", 1, 2)?;
        assert_eq!(first_page.total, 3);
        assert_eq!(first_page.entries.len(), 2);
        assert_eq!(first_page.entries[0].tool_name, "Bash");
        assert_eq!(first_page.entries[1].tool_name, "Write");

        let second_page = logger.query("sess-1", 2, 2)?;
        assert_eq!(second_page.total, 3);
        assert_eq!(second_page.entries.len(), 1);
        assert_eq!(second_page.entries[0].tool_name, "Read");

        std::fs::remove_file(&db_path).ok();

        Ok(())
    }
}
