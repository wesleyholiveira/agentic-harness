use anyhow::{Result, bail};

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub database_schema: String,
    pub amqp_url: String,
    pub worker_id: String,
    pub outbox_poll_interval_ms: u64,
    pub outbox_batch_size: usize,
    pub outbox_max_publish_attempts: i32,
    pub agent_runtime_test_cleanup_fault: Option<String>,
    pub agent_runtime_test_cleanup_fault_task_match: Option<String>,
    pub agent_continuation_test_fault: Option<String>,
    pub agent_continuation_test_fault_effect_match: Option<String>,
    pub agent_continuation_http_timeout_ms: u64,
    pub agent_continuation_verify_attempts: usize,
    pub agent_continuation_verify_delay_ms: u64,
    pub agent_continuation_completion_timeout_ms: u64,
    pub agent_continuation_ambiguity_delay_ms: u64,
    pub agent_continuation_max_attempts: i32,
    pub agent_continuation_username: Option<String>,
    pub agent_continuation_password: Option<String>,
}

fn lookup_var(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    name: &str,
    fallback: &str,
) -> String {
    lookup(name).unwrap_or_else(|| fallback.to_string())
}

fn lookup_opt(lookup: &mut impl FnMut(&str) -> Option<String>, name: &str) -> Option<String> {
    lookup(name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn lookup_num<T: std::str::FromStr>(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    name: &str,
    fallback: T,
) -> T {
    lookup(name)
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup(mut lookup: impl FnMut(&str) -> Option<String>) -> Result<Self> {
        let database_url = lookup("AGENT_POSTGRES_URL")
            .or_else(|| lookup("DATABASE_URL"))
            .ok_or_else(|| anyhow::anyhow!("agent_postgres_url_required"))?;
        let password = lookup_opt(&mut lookup, "AGENT_HARNESS_OPENCODE_CONTINUATION_PASSWORD")
            .or_else(|| lookup_opt(&mut lookup, "OPENCODE_SERVER_PASSWORD"));
        let username = lookup_opt(&mut lookup, "AGENT_HARNESS_OPENCODE_CONTINUATION_USERNAME")
            .or_else(|| password.as_ref().map(|_| "opencode".to_string()));
        let max_attempts = lookup_num(
            &mut lookup,
            "AGENT_HARNESS_OPENCODE_CONTINUATION_MAX_ATTEMPTS",
            1_i32,
        );
        if max_attempts != 1 {
            bail!("agent_continuation_max_attempts_must_be_one");
        }

        Ok(Self {
            database_url,
            database_schema: lookup_var(&mut lookup, "AGENT_POSTGRES_SCHEMA", "public"),
            amqp_url: lookup_var(
                &mut lookup,
                "AGENT_HARNESS_RUNTIME_RABBITMQ_URL",
                "amqp://agent:agent@rabbitmq:5672/%2f",
            ),
            worker_id: lookup_var(
                &mut lookup,
                "AGENT_HARNESS_RUNTIME_WORKER_ID",
                "agentic-harness-worker",
            ),
            outbox_poll_interval_ms: lookup_num(&mut lookup, "OUTBOX_POLL_INTERVAL_MS", 100_u64),
            outbox_batch_size: lookup_num(&mut lookup, "OUTBOX_BATCH_SIZE", 50_usize),
            outbox_max_publish_attempts: lookup_num(
                &mut lookup,
                "OUTBOX_MAX_PUBLISH_ATTEMPTS",
                5_i32,
            ),
            agent_runtime_test_cleanup_fault: lookup_opt(
                &mut lookup,
                "AGENT_HARNESS_RUNTIME_TEST_CLEANUP_FAULT",
            ),
            agent_runtime_test_cleanup_fault_task_match: lookup_opt(
                &mut lookup,
                "AGENT_HARNESS_RUNTIME_TEST_CLEANUP_FAULT_TASK_MATCH",
            ),
            agent_continuation_test_fault: lookup_opt(
                &mut lookup,
                "AGENT_HARNESS_AGENT_CONTINUATION_TEST_FAULT",
            ),
            agent_continuation_test_fault_effect_match: lookup_opt(
                &mut lookup,
                "AGENT_HARNESS_AGENT_CONTINUATION_TEST_FAULT_EFFECT_MATCH",
            ),
            agent_continuation_http_timeout_ms: lookup_num(
                &mut lookup,
                "AGENT_HARNESS_OPENCODE_CONTINUATION_HTTP_TIMEOUT_MS",
                10_000_u64,
            ),
            agent_continuation_verify_attempts: lookup_num(
                &mut lookup,
                "AGENT_HARNESS_OPENCODE_CONTINUATION_VERIFY_ATTEMPTS",
                5_usize,
            ),
            agent_continuation_verify_delay_ms: lookup_num(
                &mut lookup,
                "AGENT_HARNESS_OPENCODE_CONTINUATION_VERIFY_DELAY_MS",
                500_u64,
            ),
            agent_continuation_completion_timeout_ms: lookup_num(
                &mut lookup,
                "AGENT_HARNESS_OPENCODE_CONTINUATION_COMPLETION_TIMEOUT_MS",
                900_000_u64,
            ),
            agent_continuation_ambiguity_delay_ms: lookup_num(
                &mut lookup,
                "AGENT_HARNESS_OPENCODE_CONTINUATION_AMBIGUITY_DELAY_MS",
                30_000_u64,
            ),
            agent_continuation_max_attempts: max_attempts,
            agent_continuation_username: username,
            agent_continuation_password: password,
        })
    }
}
