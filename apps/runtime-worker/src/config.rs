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
fn var(name: &str, fallback: &str) -> String { std::env::var(name).unwrap_or_else(|_| fallback.to_string()) }
fn opt(name: &str) -> Option<String> { std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) }
fn num<T: std::str::FromStr>(name: &str, fallback: T) -> T { std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(fallback) }
impl Config {
  pub fn from_env() -> Result<Self> {
    let database_url = std::env::var("AGENT_POSTGRES_URL").or_else(|_| std::env::var("DATABASE_URL")).map_err(|_| anyhow::anyhow!("agent_postgres_url_required"))?;
    let password = opt("AGENT_HARNESS_OPENCODE_CONTINUATION_PASSWORD").or_else(|| opt("OPENCODE_SERVER_PASSWORD"));
    let username = opt("AGENT_HARNESS_OPENCODE_CONTINUATION_USERNAME").or_else(|| password.as_ref().map(|_| "opencode".to_string()));
    let max_attempts=num("AGENT_HARNESS_OPENCODE_CONTINUATION_MAX_ATTEMPTS",1_i32);
    if max_attempts != 1 { bail!("agent_continuation_max_attempts_must_be_one"); }
    Ok(Self {
      database_url, database_schema: var("AGENT_POSTGRES_SCHEMA","public"), amqp_url: var("AGENT_HARNESS_RUNTIME_RABBITMQ_URL","amqp://agent:agent@rabbitmq:5672/%2f"), worker_id: var("AGENT_HARNESS_RUNTIME_WORKER_ID","agentic-harness-worker"),
      outbox_poll_interval_ms:num("OUTBOX_POLL_INTERVAL_MS",100_u64), outbox_batch_size:num("OUTBOX_BATCH_SIZE",50_usize), outbox_max_publish_attempts:num("OUTBOX_MAX_PUBLISH_ATTEMPTS",5_i32),
      agent_runtime_test_cleanup_fault:opt("AGENT_HARNESS_RUNTIME_TEST_CLEANUP_FAULT"), agent_runtime_test_cleanup_fault_task_match:opt("AGENT_HARNESS_RUNTIME_TEST_CLEANUP_FAULT_TASK_MATCH"),
      agent_continuation_test_fault:opt("AGENT_HARNESS_AGENT_CONTINUATION_TEST_FAULT"), agent_continuation_test_fault_effect_match:opt("AGENT_HARNESS_AGENT_CONTINUATION_TEST_FAULT_EFFECT_MATCH"),
      agent_continuation_http_timeout_ms:num("AGENT_HARNESS_OPENCODE_CONTINUATION_HTTP_TIMEOUT_MS",10_000_u64), agent_continuation_verify_attempts:num("AGENT_HARNESS_OPENCODE_CONTINUATION_VERIFY_ATTEMPTS",5_usize), agent_continuation_verify_delay_ms:num("AGENT_HARNESS_OPENCODE_CONTINUATION_VERIFY_DELAY_MS",500_u64), agent_continuation_completion_timeout_ms:num("AGENT_HARNESS_OPENCODE_CONTINUATION_COMPLETION_TIMEOUT_MS",900_000_u64), agent_continuation_ambiguity_delay_ms:num("AGENT_HARNESS_OPENCODE_CONTINUATION_AMBIGUITY_DELAY_MS",30_000_u64), agent_continuation_max_attempts:max_attempts,
      agent_continuation_username:username, agent_continuation_password:password,
    })
  }
}
