//! Agent Runtime V2 event-driven execution plane.
//!
//! PostgreSQL is authoritative. RabbitMQ carries ID-only wakeups/commands.
//! This module intentionally owns operational lifecycle only: claims, leases,
//! workspace materialization/cleanup, process supervision, heartbeat and result
//! persistence. DAG/SDD/completion decisions remain in the TypeScript Context
//! Engine semantic controller.

use std::{
    collections::HashMap,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, bail};
use chrono::Utc;
use futures_util::StreamExt;
use lapin::{
    BasicProperties, Channel, ExchangeKind,
    options::{
        BasicAckOptions, BasicConsumeOptions, BasicNackOptions, BasicQosOptions,
        ExchangeDeclareOptions, QueueBindOptions, QueueDeclareOptions,
    },
    types::FieldTable,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    fs::{File, OpenOptions},
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::Mutex,
    time::{Instant, interval, sleep},
};
use tokio_postgres::{Client, NoTls};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::{
    amqp::{connect, long_string, publish_raw_confirmed},
    config::Config,
};

pub const EXCHANGE: &str = "agent.harness.runtime";
pub const DLX_EXCHANGE: &str = "agent.harness.runtime.dlx";
pub const SCHEDULER_QUEUE: &str = "agent.harness.runtime.scheduler";
pub const EXECUTE_QUEUE: &str = "agent.harness.runtime.execute";
pub const CLEANUP_QUEUE: &str = "agent.harness.runtime.cleanup";
pub const CONTINUATION_QUEUE: &str = "agent.harness.runtime.continuation";
pub const DLQ: &str = "agent.harness.runtime.dlq";
pub const WAKE_CHANNEL: &str = "agent_harness_runtime_wakeup";
const LEASE_SECONDS: i64 = 120;
const HEARTBEAT_SECONDS: u64 = 15;
const CLEANUP_RETRIES_PER_DELIVERY: usize = 8;
const STDERR_TAIL_LIMIT: usize = 16 * 1024;
const OUTBOX_IDLE_MAX_POLL_MS: u64 = 1_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeEnvelope {
    pub schema_version: String,
    pub message_id: String,
    pub kind: String,
    pub run_id: String,
    #[serde(default)]
    pub task_id: Option<String>,
    pub dispatch_generation: i64,
    #[serde(default)]
    pub attempt: Option<i32>,
    #[serde(default)]
    pub fencing_token: Option<i64>,
    #[serde(default)]
    pub continuation_id: Option<String>,
    #[serde(default)]
    pub delivery_id: Option<String>,
    #[serde(default)]
    pub effect_key: Option<String>,
}

impl AgentRuntimeEnvelope {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.schema_version != "agent-runtime-envelope/v1" {
            bail!("agent_runtime_envelope_version_invalid");
        }
        if self.message_id.trim().is_empty() || self.run_id.trim().is_empty() {
            bail!("agent_runtime_envelope_identity_missing");
        }
        let taskless = matches!(
            self.kind.as_str(),
            "agent.run.reconcile.v1" | "agent.continuation.wake.v1"
        );
        if !taskless && self.task_id.as_deref().unwrap_or("").is_empty() {
            bail!("agent_runtime_task_identity_missing");
        }
        if self.kind == "agent.continuation.wake.v1"
            && (self.continuation_id.as_deref().unwrap_or("").is_empty()
                || self.delivery_id.as_deref().unwrap_or("").is_empty()
                || self.effect_key.as_deref().unwrap_or("").is_empty())
        {
            bail!("agent_runtime_continuation_identity_missing");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionDescriptor {
    schema_version: String,
    run_id: String,
    task_id: String,
    agent_id: String,
    attempt: i32,
    dispatch_generation: i64,
    #[serde(default = "default_execution_mode")]
    execution_mode: String,
    handoff_path: String,
    log_path: String,
    result_path: String,
    change_set_path: String,
    workspace: WorkspaceDescriptor,
    process: ProcessDescriptor,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDescriptor {
    mode: String,
    path: String,
    #[serde(default)]
    baseline_path: Option<String>,
    source_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessDescriptor {
    command: String,
    timeout_ms: u64,
    #[serde(default)]
    soft_timeout_ms: Option<u64>,
    #[serde(default)]
    stall_timeout_ms: Option<u64>,
    #[serde(default)]
    liveness_policy: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionResult {
    schema_version: String,
    run_id: String,
    task_id: String,
    agent_id: String,
    attempt: i32,
    dispatch_generation: i64,
    fencing_token: i64,
    started_at: String,
    completed_at: String,
    exit_code: Option<i32>,
    signal: Option<String>,
    timed_out: bool,
    soft_timed_out: bool,
    stalled: bool,
    aborted: bool,
    error: Option<String>,
    stderr_summary: String,
    handoff_path: String,
    log_path: String,
    result_path: String,
    change_set_path: String,
    workspace: ExecutionResultWorkspace,
    telemetry: ExecutionTelemetry,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionResultWorkspace {
    mode: String,
    path: String,
    baseline_path: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionTelemetry {
    session_id: Option<String>,
    stdout_bytes: u64,
    stderr_bytes: u64,
    #[serde(default)]
    execution_mode: Option<String>,
    #[serde(default)]
    runtime_events: Vec<serde_json::Value>,
}

fn default_execution_mode() -> String {
    "agent".to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct FileFingerprint {
    sha256: String,
    bytes: u64,
}

#[derive(Clone, Debug)]
struct ClaimedExecution {
    task_id: String,
    run_id: String,
    descriptor_path: String,
    attempt: i32,
    dispatch_generation: i64,
    fencing_token: i64,
}

fn event_id() -> String {
    format!("event-{}", Uuid::new_v4())
}

fn result_id() -> String {
    format!("result-{}", Uuid::new_v4())
}

fn outbox_id() -> String {
    format!("agent-outbox-{}", Uuid::new_v4())
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

async fn connect_database(config: &Config) -> Result<Client> {
    let (client, connection) = tokio_postgres::connect(&config.database_url, NoTls)
        .await
        .context("agent_runtime_postgres_connect_failed")?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            error!(event = "agent_runtime.postgres_connection_lost", error = %error);
        }
    });
    client
        .query_one(
            "SELECT pg_catalog.set_config('search_path', pg_catalog.quote_ident($1) || ',public', false)",
            &[&config.database_schema],
        )
        .await
        .context("agent_runtime_search_path_failed")?;
    Ok(client)
}

pub async fn declare_topology(channel: &Channel) -> Result<()> {
    let durable_exchange = ExchangeDeclareOptions {
        durable: true,
        ..Default::default()
    };
    channel
        .exchange_declare(
            EXCHANGE.into(),
            ExchangeKind::Topic,
            durable_exchange,
            FieldTable::default(),
        )
        .await?;
    channel
        .exchange_declare(
            DLX_EXCHANGE.into(),
            ExchangeKind::Topic,
            durable_exchange,
            FieldTable::default(),
        )
        .await?;

    for (queue, bindings) in [
        (
            SCHEDULER_QUEUE,
            vec!["scheduler.reconcile", "execution.finished", "task.prefetch"],
        ),
        (EXECUTE_QUEUE, vec!["task.execute"]),
        (CLEANUP_QUEUE, vec!["workspace.cleanup"]),
        (CONTINUATION_QUEUE, vec!["continuation.wake"]),
    ] {
        let mut args = FieldTable::default();
        args.insert("x-queue-type".into(), long_string("quorum"));
        args.insert("x-dead-letter-exchange".into(), long_string(DLX_EXCHANGE));
        channel
            .queue_declare(
                queue.into(),
                QueueDeclareOptions {
                    durable: true,
                    ..Default::default()
                },
                args,
            )
            .await?;
        for binding in bindings {
            channel
                .queue_bind(
                    queue.into(),
                    EXCHANGE.into(),
                    binding.into(),
                    QueueBindOptions::default(),
                    FieldTable::default(),
                )
                .await?;
        }
    }

    let mut dlq_args = FieldTable::default();
    dlq_args.insert("x-queue-type".into(), long_string("quorum"));
    channel
        .queue_declare(
            DLQ.into(),
            QueueDeclareOptions {
                durable: true,
                ..Default::default()
            },
            dlq_args,
        )
        .await?;
    channel
        .queue_bind(
            DLQ.into(),
            DLX_EXCHANGE.into(),
            "#".into(),
            QueueBindOptions::default(),
            FieldTable::default(),
        )
        .await?;
    Ok(())
}

fn routing_key(kind: &str) -> Result<&'static str> {
    match kind {
        "agent.run.reconcile.v1" => Ok("scheduler.reconcile"),
        "agent.task.execute.v1" => Ok("task.execute"),
        "agent.task.prefetch.v1" => Ok("task.prefetch"),
        "agent.execution.finished.v1" => Ok("execution.finished"),
        "agent.workspace.cleanup.v1" => Ok("workspace.cleanup"),
        "agent.continuation.wake.v1" => Ok("continuation.wake"),
        _ => bail!("agent_runtime_message_kind_invalid:{kind}"),
    }
}

async fn publish_runtime_envelope(
    channel: &Channel,
    body: &[u8],
    kind: &str,
    message_id: &str,
) -> Result<()> {
    let properties = BasicProperties::default()
        .with_delivery_mode(2)
        .with_content_type("application/json".into())
        .with_message_id(message_id.to_string().into());
    publish_raw_confirmed(channel, EXCHANGE, routing_key(kind)?, body, properties).await
}

async fn heartbeat_worker(config: Config, concurrency: u16) -> Result<()> {
    let client = connect_database(&config).await?;
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into());
    let pid = std::process::id() as i32;
    let started_at = now();
    info!(event="agent_runtime.worker_heartbeat_started", worker_id=%config.worker_id, hostname=%hostname, pid, concurrency);
    let mut ticker = interval(Duration::from_secs(10));
    loop {
        ticker.tick().await;
        let heartbeat_at = now();
        client.execute(
            "INSERT INTO agent_runtime_workers(worker_id,worker_kind,hostname,pid,concurrency,started_at,heartbeat_at,metadata_json,stopped_at) \
             VALUES($1,'rust-executor',$2,$3,$4,$5,$6,$7,NULL) \
             ON CONFLICT(worker_id) DO UPDATE SET worker_kind='rust-executor',hostname=EXCLUDED.hostname,pid=EXCLUDED.pid,concurrency=EXCLUDED.concurrency,heartbeat_at=EXCLUDED.heartbeat_at,metadata_json=EXCLUDED.metadata_json,stopped_at=NULL",
            &[&config.worker_id, &hostname, &pid, &(concurrency as i32), &started_at, &heartbeat_at, &serde_json::json!({
                "transport":"rabbitmq",
                "executionPlane":"rust",
                "exchange":EXCHANGE,
                "testCleanupFault":config.agent_runtime_test_cleanup_fault.clone(),
                "testCleanupFaultTaskMatch":config.agent_runtime_test_cleanup_fault_task_match.clone()
            }).to_string()],
        ).await?;
        debug!(event="agent_runtime.worker_heartbeat", worker_id=%config.worker_id, heartbeat_at=%heartbeat_at);
    }
}

async fn run_outbox_relay(config: Config, channel: Channel) -> Result<()> {
    let mut client = connect_database(&config).await?;
    let base_poll_ms = config.outbox_poll_interval_ms.max(25);
    let max_idle_poll_ms = OUTBOX_IDLE_MAX_POLL_MS.max(base_poll_ms);
    let mut next_poll_ms = 0_u64;
    let mut idle_poll_ms = base_poll_ms;
    info!(event="agent_runtime.outbox_relay_started", worker_id=%config.worker_id, poll_interval_ms=base_poll_ms, max_idle_poll_ms, batch_size=config.outbox_batch_size);
    loop {
        if next_poll_ms > 0 {
            sleep(Duration::from_millis(next_poll_ms)).await;
        } else {
            tokio::task::yield_now().await;
        }
        let transaction = client.transaction().await?;
        let rows = transaction
            .query(
                "SELECT outbox_id, message_kind, payload_json, publish_count FROM agent_runtime_outbox \
                 WHERE published_at IS NULL AND terminal_at IS NULL ORDER BY created_at, outbox_id \
                 FOR UPDATE SKIP LOCKED LIMIT $1",
                &[&(config.outbox_batch_size as i64)],
            )
            .await?;
        let row_count = rows.len();
        for row in rows {
            let id: String = row.get(0);
            let kind: String = row.get(1);
            let payload: String = row.get(2);
            let count: i32 = row.get(3);
            let run_id_for_log = serde_json::from_str::<AgentRuntimeEnvelope>(&payload)
                .ok()
                .map(|value| value.run_id)
                .unwrap_or_default();
            let task_id_for_log = serde_json::from_str::<AgentRuntimeEnvelope>(&payload)
                .ok()
                .and_then(|value| value.task_id)
                .unwrap_or_default();
            let envelope = serde_json::from_str::<AgentRuntimeEnvelope>(&payload)
                .context("agent_runtime_outbox_invalid_payload");
            let published = match envelope {
                Ok(envelope) => envelope.validate().map(|_| envelope),
                Err(error) => Err(error),
            };
            let result = match published {
                Ok(envelope) => {
                    publish_runtime_envelope(
                        &channel,
                        payload.as_bytes(),
                        &kind,
                        &envelope.message_id,
                    )
                    .await
                }
                Err(error) => Err(error),
            };
            match result {
                Ok(()) => {
                    info!(event="agent_runtime.outbox_published", outbox_id=%id, message_kind=%kind, run_id=%run_id_for_log, task_id=%task_id_for_log, publish_attempt=count + 1);
                    transaction
                        .execute(
                            "UPDATE agent_runtime_outbox SET published_at=$2, publish_count=publish_count+1, last_error=NULL WHERE outbox_id=$1",
                            &[&id, &now()],
                        )
                        .await?;
                }
                Err(error) => {
                    let next = count + 1;
                    if next >= config.outbox_max_publish_attempts {
                        error!(event="agent_runtime.outbox_dead_lettered", outbox_id=%id, message_kind=%kind, run_id=%run_id_for_log, task_id=%task_id_for_log, publish_attempt=next, error=%error);
                        transaction
                            .execute(
                                "UPDATE agent_runtime_outbox SET publish_count=$2, last_error=$3, terminal_at=$4, terminal_reason='dead_lettered' WHERE outbox_id=$1",
                                &[&id, &next, &error.to_string(), &now()],
                            )
                            .await?;
                    } else {
                        warn!(event="agent_runtime.outbox_publish_retry", outbox_id=%id, message_kind=%kind, run_id=%run_id_for_log, task_id=%task_id_for_log, publish_attempt=next, error=%error);
                        transaction
                            .execute(
                                "UPDATE agent_runtime_outbox SET publish_count=$2, last_error=$3 WHERE outbox_id=$1",
                                &[&id, &next, &error.to_string()],
                            )
                            .await?;
                    }
                }
            }
        }
        transaction.commit().await?;
        if row_count == 0 {
            next_poll_ms = idle_poll_ms;
            idle_poll_ms = idle_poll_ms.saturating_mul(2).min(max_idle_poll_ms);
        } else {
            idle_poll_ms = base_poll_ms;
            // Drain a full batch without an artificial sleep; otherwise reset to
            // the configured low-latency cadence. This keeps busy-path latency
            // unchanged while eliminating 10 idle PostgreSQL polls/second at the
            // default 100ms configuration.
            next_poll_ms = if row_count >= config.outbox_batch_size.max(1) {
                0
            } else {
                base_poll_ms
            };
        }
    }
}

async fn notify_semantic_controller(client: &Client, run_id: &str) -> Result<()> {
    client
        .query_one("SELECT pg_notify($1,$2)", &[&WAKE_CHANNEL, &run_id])
        .await
        .context("agent_runtime_notify_failed")?;
    Ok(())
}

async fn consume_scheduler(config: Config, channel: Channel) -> Result<()> {
    let client = connect_database(&config).await?;
    info!(event="agent_runtime.scheduler_consumer_started", worker_id=%config.worker_id, queue=SCHEDULER_QUEUE);
    channel.basic_qos(32, BasicQosOptions::default()).await?;
    let mut consumer = channel
        .basic_consume(
            SCHEDULER_QUEUE.into(),
            "agent-runtime-scheduler-wakeup".into(),
            BasicConsumeOptions::default(),
            FieldTable::default(),
        )
        .await?;
    while let Some(delivery) = consumer.next().await {
        let delivery = delivery?;
        match serde_json::from_slice::<AgentRuntimeEnvelope>(&delivery.data)
            .context("agent_runtime_scheduler_envelope_invalid")
            .and_then(|envelope| {
                envelope.validate()?;
                Ok(envelope)
            }) {
            Ok(envelope) => {
                info!(event="agent_runtime.scheduler_wakeup", run_id=%envelope.run_id, task_id=?envelope.task_id, message_kind=%envelope.kind, dispatch_generation=envelope.dispatch_generation);
                notify_semantic_controller(&client, &envelope.run_id).await?;
                delivery.ack(BasicAckOptions::default()).await?;
            }
            Err(error) => {
                error!(event = "agent_runtime.scheduler_message_invalid", error = %error);
                delivery
                    .nack(BasicNackOptions {
                        requeue: false,
                        ..Default::default()
                    })
                    .await?;
            }
        }
    }
    Ok(())
}

async fn insert_event(
    client: &Client,
    run_id: &str,
    task_id: Option<&str>,
    event_type: &str,
    payload: serde_json::Value,
) -> Result<()> {
    client
        .execute(
            "INSERT INTO agent_events(event_id,run_id,task_id,event_type,payload_json,created_at) VALUES($1,$2,$3,$4,$5,$6)",
            &[&event_id(), &run_id, &task_id, &event_type, &payload.to_string(), &now()],
        )
        .await?;
    Ok(())
}

async fn claim_execution(
    client: &mut Client,
    config: &Config,
    envelope: &AgentRuntimeEnvelope,
) -> Result<Option<ClaimedExecution>> {
    let task_id = envelope
        .task_id
        .as_deref()
        .context("agent_runtime_execute_task_missing")?;
    let transaction = client.transaction().await?;
    let row = transaction
        .query_opt(
            "SELECT t.status,t.attempt,t.dispatch_generation,t.fencing_token,t.execution_descriptor_path,r.status \
             FROM agent_tasks t JOIN agent_runs r ON r.run_id=t.run_id WHERE t.task_id=$1 AND t.run_id=$2 FOR UPDATE OF t",
            &[&task_id, &envelope.run_id],
        )
        .await?;
    let Some(row) = row else {
        transaction.rollback().await?;
        return Ok(None);
    };
    let status: String = row.get(0);
    let attempt: i32 = row.get(1);
    let generation: i64 = row.get(2);
    let fence: i64 = row.get(3);
    let descriptor_path: Option<String> = row.get(4);
    let run_status: String = row.get(5);
    if run_status != "running"
        || status != "queued"
        || attempt != envelope.attempt.unwrap_or_default()
        || generation != envelope.dispatch_generation
        || envelope.fencing_token != Some(fence)
    {
        transaction.rollback().await?;
        return Ok(None);
    }
    let descriptor_path = descriptor_path.context("agent_runtime_execution_descriptor_missing")?;
    let expires = (Utc::now() + chrono::Duration::seconds(LEASE_SECONDS)).to_rfc3339();
    let started = now();
    transaction
        .execute(
            "UPDATE agent_tasks SET status='running',lease_owner=$2,lease_expires_at=$3,started_at=COALESCE(started_at,$4),state_version=state_version+1 WHERE task_id=$1",
            &[&task_id, &config.worker_id, &expires, &started],
        )
        .await?;
    transaction
        .execute(
            "INSERT INTO agent_events(event_id,run_id,task_id,event_type,payload_json,created_at) VALUES($1,$2,$3,'task.running',$4,$5)",
            &[&event_id(), &envelope.run_id, &task_id, &serde_json::json!({"attempt":attempt,"dispatchGeneration":generation,"fencingToken":fence,"leaseOwner":config.worker_id.clone(),"executor":"rust"}).to_string(), &started],
        )
        .await?;
    transaction.commit().await?;
    // Task-start progress is human-significant. Wake the semantic controller so
    // ADR 0080 can project the persisted `task.running` event to the bound TUI
    // immediately instead of waiting for the periodic repair sweep. Notification
    // failure is non-authoritative and must never invalidate the already-fenced claim.
    if let Err(error) = notify_semantic_controller(client, &envelope.run_id).await {
        warn!(event="agent_runtime.progress_wakeup_failed", run_id=%envelope.run_id, task_id=%task_id, error=%error);
    }
    info!(event="agent_runtime.task_claimed", run_id=%envelope.run_id, task_id=%task_id, worker_id=%config.worker_id, attempt, dispatch_generation=generation, fencing_token=fence, lease_expires_at=%expires);
    Ok(Some(ClaimedExecution {
        task_id: task_id.to_string(),
        run_id: envelope.run_id.clone(),
        descriptor_path,
        attempt,
        dispatch_generation: generation,
        fencing_token: fence,
    }))
}

fn should_skip_entry(name: &str) -> bool {
    matches!(
        name,
        ".runtime" | ".git" | "node_modules" | "dist" | "release" | "target"
    )
}

fn fingerprint_file(path: &Path) -> io::Result<FileFingerprint> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes = 0_u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes += read as u64;
    }
    Ok(FileFingerprint {
        sha256: format!("{:x}", hasher.finalize()),
        bytes,
    })
}

fn copy_tree_with_baseline(
    source: &Path,
    target: &Path,
) -> io::Result<HashMap<String, FileFingerprint>> {
    let mut baseline = HashMap::new();
    fs::create_dir_all(target)?;
    fn visit(
        root: &Path,
        current: &Path,
        target: &Path,
        baseline: &mut HashMap<String, FileFingerprint>,
    ) -> io::Result<()> {
        for entry in fs::read_dir(current)? {
            let entry = entry?;
            let name = entry.file_name();
            let name_text = name.to_string_lossy();
            if should_skip_entry(&name_text) {
                continue;
            }
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap_or(&path);
            let out = target.join(rel);
            let kind = entry.file_type()?;
            if kind.is_dir() {
                fs::create_dir_all(&out)?;
                visit(root, &path, target, baseline)?;
            } else if kind.is_file() {
                if let Some(parent) = out.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(&path, &out)?;
                let key = rel.to_string_lossy().replace('\\', "/");
                // The attempt baseline must describe the exact bytes the specialist
                // received, including any staged/unstaged/untracked dirty-tree state
                // present at fork time. Fingerprinting the source after fs::copy would
                // introduce a race where the root can change between copy and hash.
                baseline.insert(key, fingerprint_file(&out)?);
            }
        }
        Ok(())
    }
    visit(source, source, target, &mut baseline)?;
    Ok(baseline)
}

fn snapshot_tree(root: &Path) -> io::Result<HashMap<String, FileFingerprint>> {
    let mut snapshot = HashMap::new();
    fn visit(
        root: &Path,
        current: &Path,
        snapshot: &mut HashMap<String, FileFingerprint>,
    ) -> io::Result<()> {
        for entry in fs::read_dir(current)? {
            let entry = entry?;
            let name = entry.file_name();
            let name_text = name.to_string_lossy();
            if should_skip_entry(&name_text) {
                continue;
            }
            let path = entry.path();
            let kind = entry.file_type()?;
            if kind.is_dir() {
                visit(root, &path, snapshot)?;
            } else if kind.is_file() {
                let rel = path.strip_prefix(root).unwrap_or(&path);
                let key = rel.to_string_lossy().replace('\\', "/");
                snapshot.insert(key, fingerprint_file(&path)?);
            }
        }
        Ok(())
    }
    visit(root, root, &mut snapshot)?;
    Ok(snapshot)
}

async fn write_baseline(path: &str, baseline: &HashMap<String, FileFingerprint>) -> Result<()> {
    if let Some(parent) = Path::new(path).parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(
        path,
        serde_json::to_vec_pretty(&serde_json::json!({"files": baseline}))?,
    )
    .await?;
    Ok(())
}

async fn collect_workspace_change_set(
    descriptor: &ExecutionDescriptor,
    claimed: &ClaimedExecution,
) -> Result<()> {
    let baseline_path = descriptor
        .workspace
        .baseline_path
        .as_deref()
        .context("agent_runtime_workspace_baseline_path_missing")?;
    let baseline_value: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(baseline_path).await?)
            .context("agent_runtime_workspace_baseline_invalid")?;
    let baseline: HashMap<String, FileFingerprint> = serde_json::from_value(
        baseline_value
            .get("files")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
    )
    .context("agent_runtime_workspace_baseline_files_invalid")?;
    let root = if descriptor.workspace.mode == "none" {
        PathBuf::from(&descriptor.workspace.source_root)
    } else {
        PathBuf::from(&descriptor.workspace.path)
    };
    let after = tokio::task::spawn_blocking(move || snapshot_tree(&root)).await??;
    let mut keys = baseline
        .keys()
        .chain(after.keys())
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    let mut observed_paths = Vec::new();
    let mut entries = Vec::new();
    for path in keys {
        let before = baseline.get(&path).cloned();
        let current = after.get(&path).cloned();
        if before != current {
            observed_paths.push(path.clone());
            entries.push(serde_json::json!({"path": path, "before": before, "after": current}));
        }
    }
    let change_set = serde_json::json!({
        "schemaVersion": "workspace-change-set/v1",
        "runId": claimed.run_id.clone(),
        "taskId": claimed.task_id.clone(),
        "attempt": claimed.attempt,
        "dispatchGeneration": claimed.dispatch_generation,
        "fencingToken": claimed.fencing_token,
        "observedPaths": observed_paths,
        "entries": entries,
        "createdAt": now(),
        "collector": "rust-agent-runtime-executor"
    });
    if let Some(parent) = Path::new(&descriptor.change_set_path).parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(
        &descriptor.change_set_path,
        serde_json::to_vec_pretty(&change_set)?,
    )
    .await?;
    Ok(())
}

fn should_inject_cleanup_ebusy_once(config: &Config, task_id: &str, attempts: i32) -> bool {
    config.agent_runtime_test_cleanup_fault.as_deref() == Some("ebusy-once")
        && attempts == 0
        && config
            .agent_runtime_test_cleanup_fault_task_match
            .as_deref()
            .is_some_and(|matcher| task_id.contains(matcher))
}

async fn remove_workspace_for_cleanup(
    config: &Config,
    task_id: &str,
    attempts: i32,
    path: &Path,
) -> Result<()> {
    if should_inject_cleanup_ebusy_once(config, task_id, attempts) {
        bail!("EBUSY: injected local-only Agent Runtime cleanup fault for {task_id}");
    }
    remove_workspace_robust(path).await
}

async fn remove_workspace_robust(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let mut delay = 50_u64;
    let mut last = None;
    for _ in 0..CLEANUP_RETRIES_PER_DELIVERY {
        let owned = path.to_path_buf();
        match tokio::task::spawn_blocking(move || fs::remove_dir_all(owned)).await? {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => last = Some(error),
        }
        sleep(Duration::from_millis(delay)).await;
        delay = (delay * 2).min(2_000);
    }
    Err(last
        .map(anyhow::Error::from)
        .unwrap_or_else(|| anyhow::anyhow!("workspace_cleanup_failed")))
}

async fn link_node_modules(source: &Path, target: &Path) -> Result<()> {
    let source_modules = source.join("node_modules");
    if !source_modules.exists() {
        return Ok(());
    }
    let target_modules = target.join("node_modules");
    if target_modules.exists() {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let status = Command::new("cmd")
            .args(["/D", "/S", "/C", "mklink", "/J"])
            .arg(&target_modules)
            .arg(&source_modules)
            .status()
            .await
            .context("agent_runtime_node_modules_junction_spawn_failed")?;
        if !status.success() {
            bail!("agent_runtime_node_modules_junction_failed");
        }
    }
    #[cfg(unix)]
    {
        let source_modules = source_modules.clone();
        let target_modules = target_modules.clone();
        tokio::task::spawn_blocking(move || {
            std::os::unix::fs::symlink(source_modules, target_modules)
        })
        .await??;
    }
    Ok(())
}

async fn initialize_workspace_git(target: &Path) -> Result<()> {
    let init = Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(target)
        .status()
        .await
        .context("agent_runtime_workspace_git_init_spawn_failed")?;
    if !init.success() {
        bail!("agent_runtime_workspace_git_init_failed");
    }
    let add = Command::new("git")
        .args(["add", "-A"])
        .current_dir(target)
        .status()
        .await
        .context("agent_runtime_workspace_git_add_spawn_failed")?;
    if !add.success() {
        bail!("agent_runtime_workspace_git_add_failed");
    }
    let commit = Command::new("git")
        .args([
            "-c",
            "user.name=Agentic Harness Runtime",
            "-c",
            "user.email=runtime@agent-harness.invalid",
            "commit",
            "--quiet",
            "--allow-empty",
            "--no-gpg-sign",
            "-m",
            "Agent Runtime workspace baseline",
        ])
        .current_dir(target)
        .status()
        .await
        .context("agent_runtime_workspace_git_commit_spawn_failed")?;
    if !commit.success() {
        bail!("agent_runtime_workspace_git_commit_failed");
    }
    Ok(())
}

async fn materialize_workspace(descriptor: &ExecutionDescriptor) -> Result<()> {
    let source = PathBuf::from(&descriptor.workspace.source_root);
    let baseline_path = descriptor
        .workspace
        .baseline_path
        .as_deref()
        .context("agent_runtime_workspace_baseline_path_missing")?;
    if descriptor.workspace.mode == "none" {
        let source_clone = source.clone();
        let baseline = tokio::task::spawn_blocking(move || snapshot_tree(&source_clone)).await??;
        let baseline_files = baseline.len();
        write_baseline(baseline_path, &baseline).await?;
        info!(event="agent_runtime.workspace_baseline_ready", run_id=%descriptor.run_id, task_id=%descriptor.task_id, workspace_mode="none", baseline_source="source-working-tree", baseline_files=baseline_files, source_root=%descriptor.workspace.source_root, workspace_path=%descriptor.workspace.path);
        return Ok(());
    }
    let target = PathBuf::from(&descriptor.workspace.path);
    if target.starts_with(&source) {
        bail!(
            "agent_runtime_workspace_nested_in_source_root:{}:{}",
            source.display(),
            target.display()
        );
    }
    remove_workspace_robust(&target).await?;
    let source_clone = source.clone();
    let target_clone = target.clone();
    let baseline =
        tokio::task::spawn_blocking(move || copy_tree_with_baseline(&source_clone, &target_clone))
            .await??;
    let baseline_files = baseline.len();
    let git_started = Instant::now();
    initialize_workspace_git(&target).await?;
    info!(event="agent_runtime.workspace_git_baseline_ready", run_id=%descriptor.run_id, task_id=%descriptor.task_id, source_root=%descriptor.workspace.source_root, workspace_path=%descriptor.workspace.path, duration_ms=git_started.elapsed().as_millis() as u64);
    link_node_modules(&source, &target).await?;
    write_baseline(baseline_path, &baseline).await?;
    info!(event="agent_runtime.workspace_baseline_ready", run_id=%descriptor.run_id, task_id=%descriptor.task_id, workspace_mode="copy", baseline_source="materialized-workspace", baseline_files=baseline_files, source_root=%descriptor.workspace.source_root, workspace_path=%descriptor.workspace.path);
    Ok(())
}

async fn append_log(log: &Arc<Mutex<File>>, line: &str) {
    let mut file = log.lock().await;
    let _ = file.write_all(line.as_bytes()).await;
    let _ = file.write_all(b"\n").await;
    let _ = file.flush().await;
}

async fn observe_runtime_event(
    line: &str,
    session: &Arc<Mutex<Option<String>>>,
    runtime_events: &Arc<Mutex<Vec<serde_json::Value>>>,
) {
    const PREFIX: &str = "@@agent-harness-runtime-event ";
    const MAX_BUFFERED_RUNTIME_EVENTS: usize = 256;
    let Some(raw) = line.strip_prefix(PREFIX) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return;
    };
    if value.get("type").and_then(|value| value.as_str()) == Some("opencode.session.observed")
        && let Some(id) = value
            .pointer("/payload/sessionId")
            .and_then(|value| value.as_str())
    {
        *session.lock().await = Some(id.to_string());
    }
    // stdout and stderr are drained by separate tasks. `try_lock()` made
    // performance boundaries lossy whenever both streams produced lines at the
    // same instant, which turned otherwise healthy runs into INCOMPLETE evidence.
    // The buffer is tiny/bounded and read only after both drain tasks finish, so
    // awaiting this mutex is deterministic and cannot create an unbounded wait.
    let mut guard = runtime_events.lock().await;
    if guard.len() < MAX_BUFFERED_RUNTIME_EVENTS {
        guard.push(serde_json::json!({
            "type": value.get("type").cloned().unwrap_or(serde_json::Value::Null),
            "payload": value.get("payload").cloned().unwrap_or_else(|| serde_json::json!({})),
            "observedAt": now(),
        }));
    }
}

async fn stream_output<R>(
    reader: R,
    log: Arc<Mutex<File>>,
    bytes: Arc<AtomicU64>,
    stderr_tail: Option<Arc<Mutex<String>>>,
    session: Arc<Mutex<Option<String>>>,
    runtime_events: Arc<Mutex<Vec<serde_json::Value>>>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        bytes.fetch_add((line.len() + 1) as u64, Ordering::Relaxed);
        observe_runtime_event(&line, &session, &runtime_events).await;
        if let Some(tail) = &stderr_tail {
            let mut value = tail.lock().await;
            value.push_str(&line);
            value.push('\n');
            if value.len() > STDERR_TAIL_LIMIT {
                let keep_from = value.len() - STDERR_TAIL_LIMIT;
                *value = value[keep_from..].to_string();
            }
        }
        append_log(&log, &line).await;
    }
}

async fn run_shell_command(
    descriptor: &ExecutionDescriptor,
    claimed: &ClaimedExecution,
    client: &Client,
    config: &Config,
) -> Result<ExecutionResult> {
    info!(event="agent_runtime.execution_preparing", run_id=%claimed.run_id, task_id=%claimed.task_id, agent_id=%descriptor.agent_id, worker_id=%config.worker_id, attempt=claimed.attempt, dispatch_generation=claimed.dispatch_generation, fencing_token=claimed.fencing_token, workspace_mode=%descriptor.workspace.mode);
    let workspace_started = Instant::now();
    materialize_workspace(descriptor)
        .await
        .context("agent_runtime_workspace_materialize_failed")?;
    let workspace_duration_ms = workspace_started.elapsed().as_millis() as u64;
    if let Err(error) = insert_event(client, &claimed.run_id, Some(&claimed.task_id), "workspace.ready", serde_json::json!({
        "attempt": claimed.attempt, "dispatchGeneration": claimed.dispatch_generation, "fencingToken": claimed.fencing_token,
        "durationMs": workspace_duration_ms, "executionMode": descriptor.execution_mode.clone(), "source": "rust-agent-runtime-executor"
    })).await {
        warn!(event="agent_runtime.performance_event_failed", event_type="workspace.ready", run_id=%claimed.run_id, task_id=%claimed.task_id, error=%error);
    }
    info!(event="agent_runtime.workspace_ready", run_id=%claimed.run_id, task_id=%claimed.task_id, workspace_mode=%descriptor.workspace.mode, workspace_path=%descriptor.workspace.path, duration_ms=workspace_duration_ms, execution_mode=%descriptor.execution_mode);
    if let Some(parent) = Path::new(&descriptor.log_path).parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let log = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&descriptor.log_path)
            .await?,
    ));
    let mut command = if cfg!(windows) {
        let mut cmd = Command::new("cmd");
        cmd.args(["/D", "/S", "/C", &descriptor.process.command]);
        cmd
    } else {
        let mut cmd = Command::new("sh");
        cmd.args(["-lc", &descriptor.process.command]);
        cmd
    };
    let execution_directory = if descriptor.workspace.mode == "none" {
        &descriptor.workspace.source_root
    } else {
        &descriptor.workspace.path
    };
    command.current_dir(execution_directory);
    command.envs(&descriptor.process.env);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    command.kill_on_drop(false);

    let started_at = now();
    let started = Instant::now();
    info!(event="agent_runtime.executor_starting", run_id=%claimed.run_id, task_id=%claimed.task_id, agent_id=%descriptor.agent_id, attempt=claimed.attempt, dispatch_generation=claimed.dispatch_generation, fencing_token=claimed.fencing_token, timeout_ms=descriptor.process.timeout_ms, soft_timeout_ms=?descriptor.process.soft_timeout_ms, stall_timeout_ms=?descriptor.process.stall_timeout_ms, liveness_policy=?descriptor.process.liveness_policy, log_path=%descriptor.log_path);
    info!(event="agent_runtime.executor_liveness_policy", run_id=%claimed.run_id, task_id=%claimed.task_id, attempt=claimed.attempt, hard_timeout_ms=descriptor.process.timeout_ms, soft_timeout_ms=?descriptor.process.soft_timeout_ms, stall_timeout_ms=?descriptor.process.stall_timeout_ms, policy=?descriptor.process.liveness_policy);
    let mut child = command
        .spawn()
        .context("agent_runtime_executor_spawn_failed")?;
    let pid = child.id().map(i64::from);
    insert_event(client, &claimed.run_id, Some(&claimed.task_id), "executor.spawned", serde_json::json!({
        "pid": pid, "attempt": claimed.attempt, "dispatchGeneration": claimed.dispatch_generation,
        "fencingToken": claimed.fencing_token, "executionMode": descriptor.execution_mode.clone(), "source": "rust-agent-runtime-executor"
    })).await?;
    info!(event="agent_runtime.executor_spawned", run_id=%claimed.run_id, task_id=%claimed.task_id, agent_id=%descriptor.agent_id, worker_id=%config.worker_id, pid=?pid, attempt=claimed.attempt, dispatch_generation=claimed.dispatch_generation, fencing_token=claimed.fencing_token);

    let stdout_bytes = Arc::new(AtomicU64::new(0));
    let stderr_bytes = Arc::new(AtomicU64::new(0));
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let session_id = Arc::new(Mutex::new(None));
    let runtime_events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let stdout_task = child.stdout.take().map(|stdout| {
        tokio::spawn(stream_output(
            stdout,
            log.clone(),
            stdout_bytes.clone(),
            None,
            session_id.clone(),
            runtime_events.clone(),
        ))
    });
    let stderr_task = child.stderr.take().map(|stderr| {
        tokio::spawn(stream_output(
            stderr,
            log.clone(),
            stderr_bytes.clone(),
            Some(stderr_tail.clone()),
            session_id.clone(),
            runtime_events.clone(),
        ))
    });

    let mut heartbeat = interval(Duration::from_secs(HEARTBEAT_SECONDS));
    heartbeat.tick().await;
    let mut cancellation = interval(Duration::from_secs(1));
    cancellation.tick().await;
    let timeout = sleep(Duration::from_millis(descriptor.process.timeout_ms));
    tokio::pin!(timeout);
    let soft_timeout_ms = descriptor
        .process
        .soft_timeout_ms
        .unwrap_or(descriptor.process.timeout_ms);
    let soft_timeout = sleep(Duration::from_millis(soft_timeout_ms));
    tokio::pin!(soft_timeout);
    let soft_timeout_enabled = descriptor.process.soft_timeout_ms.is_some()
        && soft_timeout_ms < descriptor.process.timeout_ms;
    let mut timed_out = false;
    let mut soft_timed_out = false;
    let mut stalled = false;
    let mut aborted = false;
    let mut last_progress_bytes = 0u64;
    let mut last_progress_at = Instant::now();
    let status = loop {
        tokio::select! {
            result = child.wait() => break result.context("agent_runtime_executor_wait_failed")?,
            _ = heartbeat.tick() => {
                let expires = (Utc::now() + chrono::Duration::seconds(LEASE_SECONDS)).to_rfc3339();
                client.execute(
                    "UPDATE agent_tasks SET lease_expires_at=$2,state_version=state_version+1,opencode_session_id=COALESCE($3,opencode_session_id) WHERE task_id=$1 AND dispatch_generation=$4 AND fencing_token=$5",
                    &[&claimed.task_id, &expires, &session_id.lock().await.clone(), &claimed.dispatch_generation, &claimed.fencing_token],
                ).await?;
                let current_stdout = stdout_bytes.load(Ordering::Relaxed);
                let current_stderr = stderr_bytes.load(Ordering::Relaxed);
                let current_progress_bytes = current_stdout.saturating_add(current_stderr);
                if current_progress_bytes > last_progress_bytes {
                    last_progress_bytes = current_progress_bytes;
                    last_progress_at = Instant::now();
                }
                let idle_ms = last_progress_at.elapsed().as_millis() as u64;
                insert_event(client, &claimed.run_id, Some(&claimed.task_id), "executor.heartbeat", serde_json::json!({
                    "elapsedMs": started.elapsed().as_millis() as u64,
                    "stdoutBytes": current_stdout,
                    "stderrBytes": current_stderr,
                    "idleMs": idle_ms,
                    "leaseOwner": config.worker_id.clone(),
                    "dispatchGeneration": claimed.dispatch_generation,
                    "fencingToken": claimed.fencing_token,
                    "source": "rust-agent-runtime-executor"
                })).await?;
                debug!(event="agent_runtime.executor_heartbeat", run_id=%claimed.run_id, task_id=%claimed.task_id, worker_id=%config.worker_id, elapsed_ms=started.elapsed().as_millis() as u64, stdout_bytes=current_stdout, stderr_bytes=current_stderr, idle_ms=idle_ms, dispatch_generation=claimed.dispatch_generation, fencing_token=claimed.fencing_token);
                if !stalled
                    && !soft_timed_out
                    && !timed_out
                    && let Some(stall_timeout_ms) = descriptor.process.stall_timeout_ms
                    && idle_ms >= stall_timeout_ms
                {
                    warn!(event="agent_runtime.executor_stalled", run_id=%claimed.run_id, task_id=%claimed.task_id, worker_id=%config.worker_id, stall_timeout_ms=stall_timeout_ms, elapsed_ms=started.elapsed().as_millis() as u64, idle_ms, stdout_bytes=current_stdout, stderr_bytes=current_stderr, dispatch_generation=claimed.dispatch_generation, fencing_token=claimed.fencing_token);
                    insert_event(client, &claimed.run_id, Some(&claimed.task_id), "executor.stalled", serde_json::json!({
                        "stallTimeoutMs": stall_timeout_ms,
                        "elapsedMs": started.elapsed().as_millis() as u64,
                        "idleMs": idle_ms,
                        "stdoutBytes": current_stdout,
                        "stderrBytes": current_stderr,
                        "dispatchGeneration": claimed.dispatch_generation,
                        "fencingToken": claimed.fencing_token,
                        "source": "rust-agent-runtime-executor"
                    })).await?;
                    stalled = true;
                    terminate_process_tree(pid).await;
                    let _ = child.kill().await;
                }
            }
            _ = cancellation.tick(), if !aborted => {
                let row = client.query_opt("SELECT r.status,t.fencing_token,t.dispatch_generation FROM agent_tasks t JOIN agent_runs r ON r.run_id=t.run_id WHERE t.task_id=$1", &[&claimed.task_id]).await?;
                let cancelled = row.as_ref().is_none_or(|row| {
                    let run_status: String = row.get(0);
                    let fence: i64 = row.get(1);
                    let generation: i64 = row.get(2);
                    run_status == "cancelled" || fence != claimed.fencing_token || generation != claimed.dispatch_generation
                });
                if cancelled {
                    warn!(event="agent_runtime.executor_cancelled", run_id=%claimed.run_id, task_id=%claimed.task_id, worker_id=%config.worker_id, dispatch_generation=claimed.dispatch_generation, fencing_token=claimed.fencing_token);
                    aborted = true;
                    terminate_process_tree(pid).await;
                    let _ = child.kill().await;
                }
            }
            _ = &mut soft_timeout, if soft_timeout_enabled && !soft_timed_out && !stalled && !timed_out => {
                warn!(event="agent_runtime.executor_soft_timed_out", run_id=%claimed.run_id, task_id=%claimed.task_id, worker_id=%config.worker_id, soft_timeout_ms=soft_timeout_ms, hard_timeout_ms=descriptor.process.timeout_ms, dispatch_generation=claimed.dispatch_generation, fencing_token=claimed.fencing_token);
                insert_event(client, &claimed.run_id, Some(&claimed.task_id), "executor.soft_timeout", serde_json::json!({
                    "softTimeoutMs": soft_timeout_ms,
                    "hardTimeoutMs": descriptor.process.timeout_ms,
                    "elapsedMs": started.elapsed().as_millis() as u64,
                    "stdoutBytes": stdout_bytes.load(Ordering::Relaxed),
                    "stderrBytes": stderr_bytes.load(Ordering::Relaxed),
                    "dispatchGeneration": claimed.dispatch_generation,
                    "fencingToken": claimed.fencing_token,
                    "source": "rust-agent-runtime-executor"
                })).await?;
                soft_timed_out = true;
                terminate_process_tree(pid).await;
                let _ = child.kill().await;
            }
            _ = &mut timeout, if !timed_out && !soft_timed_out && !stalled => {
                warn!(event="agent_runtime.executor_timed_out", run_id=%claimed.run_id, task_id=%claimed.task_id, worker_id=%config.worker_id, timeout_ms=descriptor.process.timeout_ms, dispatch_generation=claimed.dispatch_generation, fencing_token=claimed.fencing_token);
                timed_out = true;
                terminate_process_tree(pid).await;
                let _ = child.kill().await;
            }
        }
    };
    if let Some(task) = stdout_task {
        let _ = task.await;
    }
    if let Some(task) = stderr_task {
        let _ = task.await;
    }
    collect_workspace_change_set(descriptor, claimed)
        .await
        .context("agent_runtime_workspace_changeset_failed")?;
    info!(event="agent_runtime.workspace_changeset_ready", run_id=%claimed.run_id, task_id=%claimed.task_id, change_set_path=%descriptor.change_set_path);

    let completed_at = now();
    let executor_duration_ms = started.elapsed().as_millis() as u64;
    let result = ExecutionResult {
        schema_version: "agent-execution-result/v1".into(),
        run_id: descriptor.run_id.clone(),
        task_id: descriptor.task_id.clone(),
        agent_id: descriptor.agent_id.clone(),
        attempt: claimed.attempt,
        dispatch_generation: claimed.dispatch_generation,
        fencing_token: claimed.fencing_token,
        started_at,
        completed_at: completed_at.clone(),
        exit_code: status.code(),
        signal: None,
        timed_out,
        soft_timed_out,
        stalled,
        aborted,
        error: if stalled {
            Some("executor_stalled:no_output_progress".into())
        } else if soft_timed_out {
            Some("executor_soft_timeout:governance_soft_deadline".into())
        } else {
            None
        },
        stderr_summary: stderr_tail.lock().await.clone(),
        handoff_path: descriptor.handoff_path.clone(),
        log_path: descriptor.log_path.clone(),
        result_path: descriptor.result_path.clone(),
        change_set_path: descriptor.change_set_path.clone(),
        workspace: ExecutionResultWorkspace {
            mode: descriptor.workspace.mode.clone(),
            path: descriptor.workspace.path.clone(),
            baseline_path: descriptor.workspace.baseline_path.clone(),
        },
        telemetry: ExecutionTelemetry {
            session_id: session_id.lock().await.clone(),
            stdout_bytes: stdout_bytes.load(Ordering::Relaxed),
            stderr_bytes: stderr_bytes.load(Ordering::Relaxed),
            execution_mode: Some(descriptor.execution_mode.clone()),
            runtime_events: runtime_events.lock().await.clone(),
        },
    };
    if let Err(error) = insert_event(client, &claimed.run_id, Some(&claimed.task_id), "executor.completed", serde_json::json!({
        "attempt": claimed.attempt, "dispatchGeneration": claimed.dispatch_generation, "fencingToken": claimed.fencing_token,
        "startedAt": result.started_at, "completedAt": result.completed_at, "durationMs": executor_duration_ms,
        "executionMode": descriptor.execution_mode.clone(), "exitCode": result.exit_code, "timedOut": result.timed_out,
        "softTimedOut": result.soft_timed_out, "stalled": result.stalled, "aborted": result.aborted,
        "stdoutBytes": result.telemetry.stdout_bytes, "stderrBytes": result.telemetry.stderr_bytes,
        "source": "rust-agent-runtime-executor"
    })).await {
        warn!(event="agent_runtime.performance_event_failed", event_type="executor.completed", run_id=%claimed.run_id, task_id=%claimed.task_id, error=%error);
    }
    info!(event="agent_runtime.executor_completed", run_id=%claimed.run_id, task_id=%claimed.task_id, agent_id=%descriptor.agent_id, worker_id=%config.worker_id, exit_code=?result.exit_code, timed_out=result.timed_out, soft_timed_out=result.soft_timed_out, stalled=result.stalled, aborted=result.aborted, duration_ms=executor_duration_ms, stdout_bytes=result.telemetry.stdout_bytes, stderr_bytes=result.telemetry.stderr_bytes, opencode_session_id=?result.telemetry.session_id, dispatch_generation=claimed.dispatch_generation, fencing_token=claimed.fencing_token, execution_mode=%descriptor.execution_mode);
    Ok(result)
}

async fn terminate_process_tree(pid: Option<i64>) {
    let Some(pid) = pid else {
        return;
    };
    if cfg!(windows) {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .await;
    } else {
        let _ = Command::new("pkill")
            .args(["-TERM", "-P", &pid.to_string()])
            .output()
            .await;
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .await;
    }
}

async fn existing_execution_result(
    descriptor: &ExecutionDescriptor,
    claim: &ClaimedExecution,
) -> Result<Option<ExecutionResult>> {
    let path = Path::new(&descriptor.result_path);
    if !path.exists() {
        return Ok(None);
    }
    let text = tokio::fs::read_to_string(path).await?;
    let result: ExecutionResult =
        serde_json::from_str(&text).context("agent_runtime_existing_result_invalid")?;
    if result.schema_version != "agent-execution-result/v1"
        || result.run_id != claim.run_id
        || result.task_id != claim.task_id
        || result.attempt != claim.attempt
        || result.dispatch_generation != claim.dispatch_generation
        || result.fencing_token != claim.fencing_token
    {
        return Ok(None);
    }
    Ok(Some(result))
}

async fn persist_execution_result(client: &mut Client, result: &ExecutionResult) -> Result<()> {
    if let Some(parent) = Path::new(&result.log_path).parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let result_path = PathBuf::from(&result.result_path);
    if let Some(parent) = result_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let payload = serde_json::to_string_pretty(result)?;
    tokio::fs::write(&result_path, &payload).await?;
    let result_path = result_path.to_string_lossy().to_string();
    let transaction = client.transaction().await?;
    let current = transaction
        .query_opt(
            "SELECT dispatch_generation,fencing_token FROM agent_tasks WHERE task_id=$1 FOR UPDATE",
            &[&result.task_id],
        )
        .await?;
    let Some(current) = current else {
        transaction.rollback().await?;
        return Ok(());
    };
    let generation: i64 = current.get(0);
    let fence: i64 = current.get(1);
    if generation != result.dispatch_generation || fence != result.fencing_token {
        transaction.rollback().await?;
        return Ok(());
    }
    transaction
        .execute(
            "INSERT INTO agent_execution_results(result_id,run_id,task_id,attempt,dispatch_generation,fencing_token,result_path,result_json,created_at) \
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(task_id,attempt,dispatch_generation,fencing_token) DO NOTHING",
            &[&result_id(), &result.run_id, &result.task_id, &result.attempt, &result.dispatch_generation, &result.fencing_token, &result_path, &payload, &now()],
        )
        .await?;
    transaction
        .execute(
            "UPDATE agent_tasks SET execution_result_path=$2,lease_owner=NULL,lease_expires_at=NULL,state_version=state_version+1 WHERE task_id=$1",
            &[&result.task_id, &result_path],
        )
        .await?;
    let id = outbox_id();
    let envelope = AgentRuntimeEnvelope {
        schema_version: "agent-runtime-envelope/v1".into(),
        message_id: id.clone(),
        kind: "agent.execution.finished.v1".into(),
        run_id: result.run_id.clone(),
        task_id: Some(result.task_id.clone()),
        dispatch_generation: result.dispatch_generation,
        attempt: Some(result.attempt),
        fencing_token: Some(result.fencing_token),
        continuation_id: None,
        delivery_id: None,
        effect_key: None,
    };
    transaction
        .execute(
            "INSERT INTO agent_runtime_outbox(outbox_id,run_id,task_id,message_kind,dispatch_generation,payload_json,created_at) \
             VALUES($1,$2,$3,'agent.execution.finished.v1',$4,$5,$6) ON CONFLICT(message_kind,run_id,task_id,dispatch_generation) DO NOTHING",
            &[&id, &result.run_id, &result.task_id, &result.dispatch_generation, &serde_json::to_string(&envelope)?, &now()],
        )
        .await?;
    transaction
        .query_one("SELECT pg_notify($1,$2)", &[&WAKE_CHANNEL, &result.run_id])
        .await?;
    transaction.commit().await?;
    info!(event="agent_runtime.execution_result_persisted", run_id=%result.run_id, task_id=%result.task_id, attempt=result.attempt, dispatch_generation=result.dispatch_generation, fencing_token=result.fencing_token, exit_code=?result.exit_code, result_path=%result.result_path);
    Ok(())
}

async fn consume_execute(config: Config, channel: Channel, concurrency: u16) -> Result<()> {
    info!(event="agent_runtime.execute_consumer_started", worker_id=%config.worker_id, queue=EXECUTE_QUEUE, concurrency);
    channel
        .basic_qos(concurrency.max(1), BasicQosOptions::default())
        .await?;
    let mut consumer = channel
        .basic_consume(
            EXECUTE_QUEUE.into(),
            "agent-runtime-executor".into(),
            BasicConsumeOptions::default(),
            FieldTable::default(),
        )
        .await?;
    let semaphore = Arc::new(tokio::sync::Semaphore::new(concurrency.max(1) as usize));
    while let Some(delivery) = consumer.next().await {
        let delivery = delivery?;
        let permit = semaphore.clone().acquire_owned().await?;
        let config = config.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let mut client = match connect_database(&config).await {
                Ok(client) => client,
                Err(error) => {
                    error!(event="agent_runtime.execute_db_failed", error=%error);
                    let _ = delivery
                        .nack(BasicNackOptions {
                            requeue: true,
                            ..Default::default()
                        })
                        .await;
                    return;
                }
            };
            let envelope = match serde_json::from_slice::<AgentRuntimeEnvelope>(&delivery.data)
                .context("agent_runtime_execute_envelope_invalid")
                .and_then(|value| {
                    value.validate()?;
                    Ok(value)
                }) {
                Ok(value) => value,
                Err(error) => {
                    error!(event="agent_runtime.execute_message_invalid", error=%error);
                    let _ = delivery
                        .nack(BasicNackOptions {
                            requeue: false,
                            ..Default::default()
                        })
                        .await;
                    return;
                }
            };
            debug!(event="agent_runtime.execute_message_received", run_id=%envelope.run_id, task_id=?envelope.task_id, message_id=%envelope.message_id, attempt=?envelope.attempt, dispatch_generation=envelope.dispatch_generation, fencing_token=?envelope.fencing_token);
            let claim = match claim_execution(&mut client, &config, &envelope).await {
                Ok(value) => value,
                Err(error) => {
                    error!(event="agent_runtime.execute_claim_failed", error=%error);
                    let _ = delivery
                        .nack(BasicNackOptions {
                            requeue: true,
                            ..Default::default()
                        })
                        .await;
                    return;
                }
            };
            let Some(claim) = claim else {
                debug!(event="agent_runtime.execute_message_stale", run_id=%envelope.run_id, task_id=?envelope.task_id, message_id=%envelope.message_id, dispatch_generation=envelope.dispatch_generation, fencing_token=?envelope.fencing_token);
                let _ = delivery.ack(BasicAckOptions::default()).await;
                return;
            };
            let descriptor = match tokio::fs::read_to_string(&claim.descriptor_path)
                .await
                .context("agent_runtime_descriptor_read_failed")
                .and_then(|text| {
                    serde_json::from_str::<ExecutionDescriptor>(&text)
                        .context("agent_runtime_descriptor_invalid")
                }) {
                Ok(value)
                    if value.schema_version == "agent-execution-descriptor/v1"
                        && value.run_id == claim.run_id
                        && value.task_id == claim.task_id
                        && value.attempt == claim.attempt
                        && value.dispatch_generation == claim.dispatch_generation =>
                {
                    value
                }
                Ok(_) => {
                    error!(event="agent_runtime.descriptor_identity_mismatch", task_id=%claim.task_id);
                    let _ = delivery
                        .nack(BasicNackOptions {
                            requeue: false,
                            ..Default::default()
                        })
                        .await;
                    return;
                }
                Err(error) => {
                    error!(event="agent_runtime.descriptor_load_failed", task_id=%claim.task_id, error=%error);
                    let _ = delivery
                        .nack(BasicNackOptions {
                            requeue: true,
                            ..Default::default()
                        })
                        .await;
                    return;
                }
            };
            info!(event="agent_runtime.execution_descriptor_loaded", run_id=%claim.run_id, task_id=%claim.task_id, agent_id=%descriptor.agent_id, attempt=claim.attempt, dispatch_generation=claim.dispatch_generation, fencing_token=claim.fencing_token, workspace_mode=%descriptor.workspace.mode);
            match existing_execution_result(&descriptor, &claim).await {
                Ok(Some(existing)) => {
                    match persist_execution_result(&mut client, &existing).await {
                        Ok(()) => {
                            let _ = delivery.ack(BasicAckOptions::default()).await;
                        }
                        Err(error) => {
                            error!(event="agent_runtime.existing_result_persist_failed", task_id=%claim.task_id, error=%error);
                            let _ = delivery
                                .nack(BasicNackOptions {
                                    requeue: true,
                                    ..Default::default()
                                })
                                .await;
                        }
                    }
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    warn!(event="agent_runtime.existing_result_recovery_failed", task_id=%claim.task_id, error=%error);
                }
            }
            let result = match run_shell_command(&descriptor, &claim, &client, &config).await {
                Ok(value) => value,
                Err(error) => ExecutionResult {
                    schema_version: "agent-execution-result/v1".into(),
                    run_id: claim.run_id.clone(),
                    task_id: claim.task_id.clone(),
                    agent_id: descriptor.agent_id.clone(),
                    attempt: claim.attempt,
                    dispatch_generation: claim.dispatch_generation,
                    fencing_token: claim.fencing_token,
                    started_at: now(),
                    completed_at: now(),
                    exit_code: Some(1),
                    signal: None,
                    timed_out: false,
                    soft_timed_out: false,
                    stalled: false,
                    aborted: false,
                    error: Some(error.to_string()),
                    stderr_summary: error.to_string(),
                    handoff_path: descriptor.handoff_path.clone(),
                    log_path: descriptor.log_path.clone(),
                    result_path: descriptor.result_path.clone(),
                    change_set_path: descriptor.change_set_path.clone(),
                    workspace: ExecutionResultWorkspace {
                        mode: descriptor.workspace.mode.clone(),
                        path: descriptor.workspace.path.clone(),
                        baseline_path: descriptor.workspace.baseline_path.clone(),
                    },
                    telemetry: ExecutionTelemetry::default(),
                },
            };
            match persist_execution_result(&mut client, &result).await {
                Ok(()) => {
                    let _ = delivery.ack(BasicAckOptions::default()).await;
                }
                Err(error) => {
                    error!(event="agent_runtime.result_persist_failed", task_id=%claim.task_id, error=%error);
                    let _ = delivery
                        .nack(BasicNackOptions {
                            requeue: true,
                            ..Default::default()
                        })
                        .await;
                }
            }
        });
    }
    Ok(())
}

async fn consume_cleanup(config: Config, channel: Channel) -> Result<()> {
    info!(event="agent_runtime.cleanup_consumer_started", worker_id=%config.worker_id, queue=CLEANUP_QUEUE);
    channel.basic_qos(4, BasicQosOptions::default()).await?;
    let mut consumer = channel
        .basic_consume(
            CLEANUP_QUEUE.into(),
            "agent-runtime-cleanup".into(),
            BasicConsumeOptions::default(),
            FieldTable::default(),
        )
        .await?;
    while let Some(delivery) = consumer.next().await {
        let delivery = delivery?;
        let envelope = match serde_json::from_slice::<AgentRuntimeEnvelope>(&delivery.data)
            .context("agent_runtime_cleanup_envelope_invalid")
            .and_then(|value| {
                value.validate()?;
                Ok(value)
            }) {
            Ok(value) => value,
            Err(error) => {
                error!(event="agent_runtime.cleanup_message_invalid", error=%error);
                delivery
                    .nack(BasicNackOptions {
                        requeue: false,
                        ..Default::default()
                    })
                    .await?;
                continue;
            }
        };
        let task_id = envelope.task_id.as_deref().unwrap_or_default();
        let fence = envelope.fencing_token.unwrap_or_default();
        let client = connect_database(&config).await?;
        let row = client.query_opt(
            "SELECT j.cleanup_id,j.workspace_path,j.attempts,j.status,t.lease_owner,t.dispatch_generation,t.fencing_token \
             FROM agent_workspace_cleanup_jobs j JOIN agent_tasks t ON t.task_id=j.task_id \
             WHERE j.task_id=$1 AND j.dispatch_generation=$2 AND j.fencing_token=$3",
            &[&task_id, &envelope.dispatch_generation, &fence],
        ).await?;
        let Some(row) = row else {
            // Stale/duplicate message for a cleanup job that was never committed.
            delivery.ack(BasicAckOptions::default()).await?;
            continue;
        };
        let cleanup_id: String = row.get(0);
        let workspace: String = row.get(1);
        let attempts: i32 = row.get(2);
        let status: String = row.get(3);
        let active_lease: Option<String> = row.get(4);
        let current_generation: i64 = row.get(5);
        let current_fence: i64 = row.get(6);
        if status == "done" {
            delivery.ack(BasicAckOptions::default()).await?;
            continue;
        }
        if current_generation != envelope.dispatch_generation || current_fence != fence {
            // Cleanup commands are generation/fence scoped. A replacement
            // execution may intentionally reuse the same semantic-attempt
            // workspace path after process loss, so an old cleanup job must not
            // delete bytes owned by the newer physical execution.
            let completed_at = now();
            client.execute(
                "UPDATE agent_workspace_cleanup_jobs SET status='done',last_error='superseded_execution_identity',next_attempt_at=NULL,completed_at=$2 WHERE cleanup_id=$1",
                &[&cleanup_id, &completed_at],
            ).await?;
            insert_event(
                &client,
                &envelope.run_id,
                Some(task_id),
                "workspace.cleanup.superseded",
                serde_json::json!({
                    "cleanupDispatchGeneration": envelope.dispatch_generation,
                    "cleanupFencingToken": fence,
                    "currentDispatchGeneration": current_generation,
                    "currentFencingToken": current_fence,
                    "source":"rust-agent-runtime-executor"
                }),
            )
            .await?;
            info!(event="agent_runtime.cleanup_superseded", run_id=%envelope.run_id, task_id=%task_id, cleanup_id=%cleanup_id, cleanup_dispatch_generation=envelope.dispatch_generation, cleanup_fencing_token=fence, current_dispatch_generation=current_generation, current_fencing_token=current_fence);
            delivery.ack(BasicAckOptions::default()).await?;
            continue;
        }
        if current_generation == envelope.dispatch_generation
            && current_fence == fence
            && active_lease.is_some()
        {
            let next_attempt_at = (Utc::now() + chrono::Duration::seconds(2)).to_rfc3339();
            client.execute(
                "UPDATE agent_workspace_cleanup_jobs SET status='deferred',last_error='execution_still_leased',next_attempt_at=$2 WHERE cleanup_id=$1",
                &[&cleanup_id, &next_attempt_at],
            ).await?;
            insert_event(&client, &envelope.run_id, Some(task_id), "workspace.cleanup.deferred", serde_json::json!({
                "reason":"execution_still_leased", "dispatchGeneration": envelope.dispatch_generation,
                "fencingToken": fence, "source":"rust-agent-runtime-executor"
            })).await?;
            warn!(event="agent_runtime.cleanup_deferred", run_id=%envelope.run_id, task_id=%task_id, cleanup_id=%cleanup_id, reason="execution_still_leased", dispatch_generation=envelope.dispatch_generation, fencing_token=fence);
            sleep(Duration::from_secs(2)).await;
            delivery
                .nack(BasicNackOptions {
                    requeue: true,
                    ..Default::default()
                })
                .await?;
            continue;
        }
        info!(event="agent_runtime.cleanup_started", run_id=%envelope.run_id, task_id=%task_id, cleanup_id=%cleanup_id, workspace_path=%workspace, attempt=envelope.attempt.unwrap_or_default(), dispatch_generation=envelope.dispatch_generation, fencing_token=fence);
        client.execute(
            "UPDATE agent_workspace_cleanup_jobs SET status='running',attempts=attempts+1,last_error=NULL WHERE cleanup_id=$1",
            &[&cleanup_id],
        ).await?;
        client.execute(
            "UPDATE agent_tasks SET cleanup_state='running',cleanup_attempts=cleanup_attempts+1,state_version=state_version+1 \
             WHERE task_id=$1 AND dispatch_generation=$2 AND fencing_token=$3",
            &[&task_id, &envelope.dispatch_generation, &fence],
        ).await?;
        if should_inject_cleanup_ebusy_once(&config, task_id, attempts) {
            insert_event(
                &client,
                &envelope.run_id,
                Some(task_id),
                "workspace.cleanup.fault_injected",
                serde_json::json!({
                    "fault":"EBUSY", "mode":"ebusy-once", "attemptsBefore": attempts,
                    "dispatchGeneration": envelope.dispatch_generation, "fencingToken": fence,
                    "source":"rust-agent-runtime-executor"
                }),
            )
            .await?;
            warn!(event="agent_runtime.cleanup_fault_injected", run_id=%envelope.run_id, task_id=%task_id, cleanup_id=%cleanup_id, fault="EBUSY", mode="ebusy-once", attempts_before=attempts, dispatch_generation=envelope.dispatch_generation, fencing_token=fence);
        }
        match remove_workspace_for_cleanup(&config, task_id, attempts, Path::new(&workspace)).await
        {
            Ok(()) => {
                let completed_at = now();
                client.execute(
                    "UPDATE agent_workspace_cleanup_jobs SET status='done',last_error=NULL,next_attempt_at=NULL,completed_at=$2 WHERE cleanup_id=$1",
                    &[&cleanup_id, &completed_at],
                ).await?;
                client.execute(
                    "UPDATE agent_tasks SET cleanup_state='done',cleanup_error=NULL,state_version=state_version+1 \
                     WHERE task_id=$1 AND dispatch_generation=$2 AND fencing_token=$3",
                    &[&task_id, &envelope.dispatch_generation, &fence],
                ).await?;
                insert_event(&client, &envelope.run_id, Some(task_id), "workspace.cleanup.completed", serde_json::json!({
                    "attempts": attempts + 1, "dispatchGeneration": envelope.dispatch_generation,
                    "fencingToken": fence, "source":"rust-agent-runtime-executor"
                })).await?;
                info!(event="agent_runtime.cleanup_completed", run_id=%envelope.run_id, task_id=%task_id, cleanup_id=%cleanup_id, attempts=attempts + 1, dispatch_generation=envelope.dispatch_generation, fencing_token=fence);
                delivery.ack(BasicAckOptions::default()).await?;
            }
            Err(error) => {
                let next_attempt_at = (Utc::now() + chrono::Duration::seconds(2)).to_rfc3339();
                client.execute(
                    "UPDATE agent_workspace_cleanup_jobs SET status='deferred',last_error=$2,next_attempt_at=$3 WHERE cleanup_id=$1",
                    &[&cleanup_id, &error.to_string(), &next_attempt_at],
                ).await?;
                client.execute(
                    "UPDATE agent_tasks SET cleanup_state='deferred',cleanup_error=$4,state_version=state_version+1 \
                     WHERE task_id=$1 AND dispatch_generation=$2 AND fencing_token=$3",
                    &[&task_id, &envelope.dispatch_generation, &fence, &error.to_string()],
                ).await?;
                insert_event(
                    &client,
                    &envelope.run_id,
                    Some(task_id),
                    "workspace.cleanup.deferred",
                    serde_json::json!({
                        "attempts": attempts + 1, "error":error.to_string(),
                        "dispatchGeneration": envelope.dispatch_generation, "fencingToken": fence,
                        "source":"rust-agent-runtime-executor"
                    }),
                )
                .await?;
                warn!(event="agent_runtime.cleanup_deferred", run_id=%envelope.run_id, task_id=%task_id, cleanup_id=%cleanup_id, attempts=attempts + 1, error=%error, dispatch_generation=envelope.dispatch_generation, fencing_token=fence);
                // Run 5 regression: filesystem cleanup is operational authority only.
                // A transient Windows EBUSY/EPERM never mutates semantic task/run status.
                sleep(Duration::from_secs(2)).await;
                delivery
                    .nack(BasicNackOptions {
                        requeue: true,
                        ..Default::default()
                    })
                    .await?;
            }
        }
    }
    Ok(())
}

pub async fn run(config: Config, concurrency: u16) -> Result<()> {
    let connection = connect(&config).await?;
    let relay_channel = connection.create_channel().await?;
    let scheduler_channel = connection.create_channel().await?;
    let execute_channel = connection.create_channel().await?;
    let cleanup_channel = connection.create_channel().await?;
    let continuation_channel = connection.create_channel().await?;
    declare_topology(&relay_channel).await?;
    // publish_raw_confirmed() is shared with the product outbox and expects
    // RabbitMQ publisher confirms to be enabled on the publishing channel.
    // Without confirm_select Lapin returns Confirmation::NotRequested even
    // though the message may already be routed/consumed, causing false retries
    // and eventual dead-lettering of successfully delivered runtime messages.
    relay_channel.confirm_select(Default::default()).await?;
    info!(event="agent_runtime.publisher_confirms_ready", worker_id=%config.worker_id, channel="outbox-relay");
    info!(event="agent_runtime.rabbit_topology_ready", worker_id=%config.worker_id, exchange=EXCHANGE, scheduler_queue=SCHEDULER_QUEUE, execute_queue=EXECUTE_QUEUE, cleanup_queue=CLEANUP_QUEUE, continuation_queue=CONTINUATION_QUEUE);
    info!(event="agent_runtime.worker_started", worker_id=%config.worker_id, concurrency, execution_plane="rust", transport="rabbitmq");
    tokio::try_join!(
        heartbeat_worker(config.clone(), concurrency),
        run_outbox_relay(config.clone(), relay_channel),
        consume_scheduler(config.clone(), scheduler_channel),
        consume_execute(config.clone(), execute_channel, concurrency),
        consume_cleanup(config.clone(), cleanup_channel),
        crate::agent_continuation::consume(config, continuation_channel),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_contract_is_id_only() {
        let envelope = AgentRuntimeEnvelope {
            schema_version: "agent-runtime-envelope/v1".into(),
            message_id: "msg".into(),
            kind: "agent.task.execute.v1".into(),
            run_id: "run".into(),
            task_id: Some("task".into()),
            dispatch_generation: 2,
            attempt: Some(1),
            fencing_token: Some(3),
            continuation_id: None,
            delivery_id: None,
            effect_key: None,
        };
        assert!(envelope.validate().is_ok());
        let value = serde_json::to_value(envelope).unwrap();
        assert!(value.get("prompt").is_none());
        assert!(value.get("contextPacket").is_none());
        assert_eq!(
            routing_key("agent.task.execute.v1").unwrap(),
            "task.execute"
        );
    }

    #[test]
    fn workspace_skip_set_excludes_recursive_runtime_and_dependency_state() {
        assert!(should_skip_entry(".runtime"));
        assert!(should_skip_entry(".git"));
        assert!(should_skip_entry("node_modules"));
        assert!(!should_skip_entry("apps"));
    }

    #[test]
    fn cleanup_ebusy_fault_injection_is_single_attempt_and_task_scoped() {
        let mut values = std::collections::HashMap::new();
        values.insert(
            "AGENT_POSTGRES_URL".to_string(),
            "postgresql://user:pass@localhost/db".to_string(),
        );
        values.insert(
            "AGENT_HARNESS_DEPLOYMENT_MODE".to_string(),
            "local".to_string(),
        );
        values.insert(
            "AGENT_HARNESS_RUNTIME_TEST_CLEANUP_FAULT".to_string(),
            "ebusy-once".to_string(),
        );
        values.insert(
            "AGENT_HARNESS_RUNTIME_TEST_CLEANUP_FAULT_TASK_MATCH".to_string(),
            "runtime-v2-canary".to_string(),
        );
        let config = Config::from_lookup(|key| values.get(key).cloned()).unwrap();
        assert!(should_inject_cleanup_ebusy_once(
            &config,
            "run:implementation:runtime-v2-canary",
            0
        ));
        assert!(!should_inject_cleanup_ebusy_once(
            &config,
            "run:implementation:runtime-v2-canary",
            1
        ));
        assert!(!should_inject_cleanup_ebusy_once(
            &config,
            "run:product-discovery",
            0
        ));
    }
}
