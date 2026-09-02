//! Durable agent-session continuation delivery.
//!
//! The semantic/control plane persists an explicit session adapter identity.
//! This worker currently implements the `opencode` transport. Any other adapter
//! fails closed before an external request is attempted; adding a new adapter
//! requires a dedicated execution-plane transport implementation.
//!
//! RabbitMQ is at-least-once. This consumer therefore treats a delivery as a
//! three-level idempotent effect:
//!   1. Rabbit message identity (`agent_runtime_inbox.message_id`),
//!   2. semantic continuation effect (`agent_continuation_deliveries.effect_key`),
//!   3. target OpenCode message identity (`opencode_message_id`).
//!
//! PostgreSQL is authoritative for all three levels. Before invoking
//! the synchronous terminal prompt endpoint, the worker reads the exact OpenCode
//! message ID. The streaming HTTP response is launched independently while the
//! authoritative path performs bounded read-after-write reconciliation against
//! that deterministic target ID. Materialization of the exact user wake marks
//! acceptance; assistant terminal completion is a later audit observation. A
//! redelivery after a crash observes the same target ID. If the external result
//! remains ambiguous, the delivery enters manual review and is never reposted
//! automatically; duplicate prevention wins over wake availability.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::StreamExt;
use lapin::{
    Channel,
    options::{BasicAckOptions, BasicConsumeOptions, BasicNackOptions, BasicQosOptions},
    types::FieldTable,
};
use reqwest::{Client as HttpClient, RequestBuilder, StatusCode, Url};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::time::sleep;
use tokio_postgres::{Client, NoTls};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::{
    agent_runtime::{AgentRuntimeEnvelope, CONTINUATION_QUEUE},
    config::Config,
};

const CONSUMER_NAME: &str = "rust-opencode-continuation";
const INBOX_LEASE_SECONDS: i64 = 120;
const DELIVERY_LEASE_SECONDS: i64 = 120;

#[derive(Debug)]
enum InboxClaim {
    Claimed,
    ProcessedDuplicate,
    Busy,
    Poison(String),
}

#[derive(Debug)]
enum TargetMessageState {
    Absent,
    Pending,
    Match,
    Collision(String),
}

#[derive(Debug)]
enum ContinuationTurnState {
    Pending,
    Completed { assistant_message_id: String },
    Failed(String),
}

#[derive(Debug)]
enum DeliveryClaim {
    Ready(ContinuationDelivery),
    Observed,
    Cancelled,
    Busy,
    NotDue,
    Dead {
        reason: String,
        delivery: Option<ContinuationDelivery>,
    },
}

#[derive(Debug)]
enum DeliveryOutcome {
    Ack,
    Requeue {
        delay_ms: u64,
        reason: String,
    },
    Ambiguous {
        reason: String,
        delivery: ContinuationDelivery,
    },
    Dead {
        reason: String,
        delivery: Option<ContinuationDelivery>,
    },
}

#[derive(Clone, Debug)]
struct ContinuationDelivery {
    delivery_id: String,
    continuation_id: String,
    adapter_id: String,
    run_id: String,
    generation: i64,
    effect_key: String,
    opencode_message_id: String,
    prompt_text: String,
    prompt_sha256: String,
    prior_status: String,
    attempts: i32,
    dispatch_started_at: Option<String>,
    next_attempt_at: Option<String>,
    server_url: String,
    session_id: String,
    directory: Option<String>,
    session_agent_id: String,
    session_provider_id: String,
    session_model_id: String,
    session_model_variant: Option<String>,
    session_prompt_message_id: Option<String>,
    continuation_status: String,
}

fn format_utc(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn now() -> String {
    format_utc(Utc::now())
}

fn event_id() -> String {
    format!("event-{}", Uuid::new_v4())
}

fn payload_sha256(data: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(data))
}

fn text_sha256(text: &str) -> String {
    payload_sha256(text.as_bytes())
}

async fn connect_database(config: &Config) -> Result<Client> {
    let (client, connection) = tokio_postgres::connect(&config.database_url, NoTls)
        .await
        .context("agent_continuation_postgres_connect_failed")?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            error!(event = "agent_continuation.postgres_connection_lost", error = %error);
        }
    });
    client
        .query_one(
            "SELECT pg_catalog.set_config('search_path', pg_catalog.quote_ident($1) || ',public', false)",
            &[&config.database_schema],
        )
        .await
        .context("agent_continuation_search_path_failed")?;
    Ok(client)
}

async fn claim_inbox(
    client: &mut Client,
    config: &Config,
    envelope: &AgentRuntimeEnvelope,
    payload_hash: &str,
    claim_owner: &str,
) -> Result<InboxClaim> {
    let received_at = now();
    let lease_expires_at = format_utc(Utc::now() + chrono::Duration::seconds(INBOX_LEASE_SECONDS));
    let transaction = client.transaction().await?;
    transaction
        .execute(
            "INSERT INTO agent_runtime_inbox(message_id,message_kind,consumer_name,payload_sha256,status,delivery_count,first_received_at,last_received_at) \
             VALUES($1,$2,$3,$4,'received',0,$5,$5) ON CONFLICT(message_id) DO NOTHING",
            &[
                &envelope.message_id,
                &envelope.kind,
                &CONSUMER_NAME,
                &payload_hash,
                &received_at,
            ],
        )
        .await?;
    let row = transaction
        .query_one(
            "SELECT payload_sha256,status,lease_owner,lease_expires_at FROM agent_runtime_inbox WHERE message_id=$1 FOR UPDATE",
            &[&envelope.message_id],
        )
        .await?;
    let persisted_hash: String = row.get(0);
    let status: String = row.get(1);
    let lease_owner: Option<String> = row.get(2);
    let lease_expires_at_existing: Option<String> = row.get(3);

    transaction
        .execute(
            "UPDATE agent_runtime_inbox SET delivery_count=delivery_count+1,last_received_at=$2 WHERE message_id=$1",
            &[&envelope.message_id, &received_at],
        )
        .await?;

    if persisted_hash != payload_hash {
        let reason = "agent_runtime_inbox_payload_hash_mismatch".to_string();
        transaction
            .execute(
                "UPDATE agent_runtime_inbox SET status='dead',last_error=$2,lease_owner=NULL,lease_expires_at=NULL WHERE message_id=$1",
                &[&envelope.message_id, &reason],
            )
            .await?;
        transaction.commit().await?;
        return Ok(InboxClaim::Poison(reason));
    }
    if status == "processed" {
        transaction.commit().await?;
        return Ok(InboxClaim::ProcessedDuplicate);
    }
    if status == "dead" {
        transaction.commit().await?;
        return Ok(InboxClaim::Poison(
            "agent_runtime_inbox_already_dead".into(),
        ));
    }
    let lease_active = lease_owner.is_some()
        && lease_expires_at_existing
            .as_deref()
            .map(|value| value > received_at.as_str())
            .unwrap_or(true);
    if lease_active {
        transaction.commit().await?;
        return Ok(InboxClaim::Busy);
    }
    transaction
        .execute(
            "UPDATE agent_runtime_inbox SET status='claimed',lease_owner=$2,lease_expires_at=$3,last_error=NULL WHERE message_id=$1",
            &[&envelope.message_id, &claim_owner, &lease_expires_at],
        )
        .await?;
    transaction.commit().await?;
    debug!(event="agent_continuation.inbox_claimed", message_id=%envelope.message_id, claim_owner=%claim_owner, worker_id=%config.worker_id);
    Ok(InboxClaim::Claimed)
}

async fn mark_inbox_processed_owned(
    client: &Client,
    message_id: &str,
    payload_hash: &str,
    claim_owner: &str,
) -> Result<()> {
    let changed = client
        .execute(
            "UPDATE agent_runtime_inbox SET status='processed',processed_at=$4,lease_owner=NULL,lease_expires_at=NULL,last_error=NULL \
             WHERE message_id=$1 AND payload_sha256=$2 AND lease_owner=$3 AND status='claimed'",
            &[&message_id, &payload_hash, &claim_owner, &now()],
        )
        .await?;
    if changed != 1 {
        bail!("agent_continuation_inbox_claim_lost_before_processed");
    }
    Ok(())
}

async fn defer_inbox_owned(
    client: &Client,
    message_id: &str,
    payload_hash: &str,
    claim_owner: &str,
    reason: &str,
) -> Result<()> {
    let changed = client
        .execute(
            "UPDATE agent_runtime_inbox SET status='deferred',lease_owner=NULL,lease_expires_at=NULL,last_error=$4 \
             WHERE message_id=$1 AND payload_sha256=$2 AND lease_owner=$3 AND status='claimed'",
            &[&message_id, &payload_hash, &claim_owner, &reason],
        )
        .await?;
    if changed != 1 {
        bail!("agent_continuation_inbox_claim_lost_before_defer");
    }
    Ok(())
}

async fn load_and_claim_delivery(
    client: &mut Client,
    envelope: &AgentRuntimeEnvelope,
    claim_owner: &str,
) -> Result<DeliveryClaim> {
    let delivery_id = envelope
        .delivery_id
        .as_deref()
        .context("agent_continuation_delivery_id_missing")?;
    let continuation_id = envelope
        .continuation_id
        .as_deref()
        .context("agent_continuation_id_missing")?;
    let effect_key = envelope
        .effect_key
        .as_deref()
        .context("agent_continuation_effect_key_missing")?;
    let transaction = client.transaction().await?;
    let row = transaction
        .query_opt(
            "SELECT d.delivery_id,d.continuation_id,d.run_id,d.generation,d.effect_key,d.opencode_message_id, \
                    d.prompt_text,d.prompt_sha256,d.status,d.attempts,d.dispatch_started_at,d.next_attempt_at, \
                    d.lease_owner,d.lease_expires_at, \
                    c.session_adapter_id,c.opencode_server_url,c.opencode_session_id,c.opencode_directory, \
                    c.session_agent_id,c.session_provider_id,c.session_model_id,c.session_model_variant,c.session_prompt_message_id,c.status \
               FROM agent_continuation_deliveries d \
               JOIN agent_continuations c ON c.continuation_id=d.continuation_id \
              WHERE d.delivery_id=$1 FOR UPDATE OF d,c",
            &[&delivery_id],
        )
        .await?;
    let Some(row) = row else {
        transaction.rollback().await?;
        return Ok(DeliveryClaim::Dead {
            reason: "agent_continuation_delivery_not_found".into(),
            delivery: None,
        });
    };
    let persisted_lease_owner: Option<String> = row.get(12);
    let persisted_lease_expires_at: Option<String> = row.get(13);
    let value = ContinuationDelivery {
        delivery_id: row.get(0),
        continuation_id: row.get(1),
        run_id: row.get(2),
        generation: row.get(3),
        effect_key: row.get(4),
        opencode_message_id: row.get(5),
        prompt_text: row.get(6),
        prompt_sha256: row.get(7),
        prior_status: row.get(8),
        attempts: row.get(9),
        dispatch_started_at: row.get(10),
        next_attempt_at: row.get(11),
        adapter_id: row.get(14),
        server_url: row.get(15),
        session_id: row.get(16),
        directory: row.get(17),
        session_agent_id: row.get::<_, Option<String>>(18).unwrap_or_default(),
        session_provider_id: row.get::<_, Option<String>>(19).unwrap_or_default(),
        session_model_id: row.get::<_, Option<String>>(20).unwrap_or_default(),
        session_model_variant: row.get(21),
        session_prompt_message_id: row.get(22),
        continuation_status: row.get(23),
    };
    let identity_matches = value.continuation_id == continuation_id
        && value.run_id == envelope.run_id
        && value.generation == envelope.dispatch_generation
        && value.effect_key == effect_key;
    if !identity_matches {
        transaction.rollback().await?;
        return Ok(DeliveryClaim::Dead {
            reason: "agent_continuation_envelope_database_identity_mismatch".into(),
            delivery: None,
        });
    }
    if value.session_agent_id.trim().is_empty()
        || value.session_provider_id.trim().is_empty()
        || value.session_model_id.trim().is_empty()
    {
        transaction.rollback().await?;
        return Ok(DeliveryClaim::Dead {
            reason: "agent_continuation_prompt_identity_missing".into(),
            delivery: Some(value),
        });
    }
    if matches!(
        value.continuation_status.as_str(),
        "cancelled" | "manual_review"
    ) {
        transaction.rollback().await?;
        return Ok(DeliveryClaim::Cancelled);
    }
    if value.prior_status == "ambiguous" {
        transaction.rollback().await?;
        return Ok(DeliveryClaim::Cancelled);
    }
    if value.prior_status == "dead" {
        transaction.rollback().await?;
        return Ok(DeliveryClaim::Dead {
            reason: "agent_continuation_delivery_already_dead".into(),
            delivery: None,
        });
    }
    if value.prior_status == "observed" {
        transaction.rollback().await?;
        return Ok(DeliveryClaim::Observed);
    }
    let current = now();
    if value
        .next_attempt_at
        .as_deref()
        .is_some_and(|candidate| candidate > current.as_str())
    {
        transaction.rollback().await?;
        return Ok(DeliveryClaim::NotDue);
    }
    let delivery_lease_active = persisted_lease_owner.is_some()
        && persisted_lease_expires_at
            .as_deref()
            .map(|value| value > current.as_str())
            .unwrap_or(true);
    if delivery_lease_active {
        transaction.rollback().await?;
        return Ok(DeliveryClaim::Busy);
    }
    let lease_expires_at =
        format_utc(Utc::now() + chrono::Duration::seconds(DELIVERY_LEASE_SECONDS));
    let changed = transaction
        .execute(
            "UPDATE agent_continuation_deliveries \
                SET status=CASE WHEN status IN ('dispatching','accepted') THEN status ELSE 'claimed' END, \
                    lease_owner=$2,lease_expires_at=$3,updated_at=$4,last_error=NULL \
              WHERE delivery_id=$1",
            &[&value.delivery_id, &claim_owner, &lease_expires_at, &current],
        )
        .await?;
    if changed != 1 {
        transaction.rollback().await?;
        return Ok(DeliveryClaim::Busy);
    }
    transaction.commit().await?;
    Ok(DeliveryClaim::Ready(value))
}

fn session_lock_key(delivery: &ContinuationDelivery) -> String {
    format!(
        "agent-continuation-session:{}|{}|{}",
        delivery.adapter_id, delivery.server_url, delivery.session_id
    )
}

async fn acquire_session_lock(client: &Client, delivery: &ContinuationDelivery) -> Result<bool> {
    Ok(client
        .query_one(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0))",
            &[&session_lock_key(delivery)],
        )
        .await?
        .get(0))
}

async fn release_session_lock(client: &Client, delivery: &ContinuationDelivery) {
    let _ = client
        .query_one(
            "SELECT pg_advisory_unlock(hashtextextended($1,0))",
            &[&session_lock_key(delivery)],
        )
        .await;
}

fn request_with_auth(config: &Config, request: RequestBuilder) -> RequestBuilder {
    match (
        config.agent_continuation_username.as_deref(),
        config.agent_continuation_password.as_deref(),
    ) {
        (Some(username), Some(password)) => request.basic_auth(username, Some(password)),
        _ => request,
    }
}

fn endpoint_url(server_url: &str, path: &str, directory: Option<&str>) -> Result<Url> {
    let mut base = Url::parse(server_url).context("agent_continuation_server_url_invalid")?;
    if !matches!(base.scheme(), "http" | "https") {
        bail!("agent_continuation_server_url_protocol_invalid");
    }
    if !base.username().is_empty() || base.password().is_some() {
        bail!("agent_continuation_server_url_embedded_credentials_forbidden");
    }
    base.set_path(path);
    base.set_query(None);
    if let Some(directory) = directory.filter(|value| !value.is_empty()) {
        base.query_pairs_mut().append_pair("directory", directory);
    }
    Ok(base)
}

fn target_message_state(
    value: &Value,
    effect_key: &str,
    expected_prompt_sha256: &str,
) -> TargetMessageState {
    if value
        .get("info")
        .and_then(|info| info.get("role"))
        .and_then(Value::as_str)
        .is_some_and(|role| role != "user")
    {
        return TargetMessageState::Collision(
            "agent_continuation_target_message_role_mismatch".into(),
        );
    }
    let parts = value
        .get("parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let marker = format!("clip-continuation-effect: {effect_key}");
    let mut observed_text = false;
    for part in parts {
        let Some(text) = part.get("text").and_then(Value::as_str) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        observed_text = true;
        if text.contains(&marker) {
            if text_sha256(text) == expected_prompt_sha256 {
                return TargetMessageState::Match;
            }
            return TargetMessageState::Collision(
                "agent_continuation_target_message_prompt_hash_mismatch".into(),
            );
        }
    }
    if !observed_text {
        return TargetMessageState::Pending;
    }
    TargetMessageState::Collision("agent_continuation_target_message_effect_mismatch".into())
}

async fn get_target_message(
    http: &HttpClient,
    config: &Config,
    delivery: &ContinuationDelivery,
) -> Result<TargetMessageState> {
    let path = format!(
        "/session/{}/message/{}",
        delivery.session_id, delivery.opencode_message_id
    );
    let url = endpoint_url(&delivery.server_url, &path, delivery.directory.as_deref())?;
    let response = request_with_auth(config, http.get(url))
        .send()
        .await
        .context("agent_continuation_target_message_get_failed")?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(TargetMessageState::Absent);
    }
    if !response.status().is_success() {
        bail!(
            "agent_continuation_target_message_get_status:{}",
            response.status()
        );
    }
    let value = response
        .json::<Value>()
        .await
        .context("agent_continuation_target_message_invalid_json")?;
    Ok(target_message_state(
        &value,
        &delivery.effect_key,
        &delivery.prompt_sha256,
    ))
}

fn continuation_turn_state_from_messages(
    items: &[Value],
    opencode_message_id: &str,
) -> ContinuationTurnState {
    let mut assistants = items
        .iter()
        .filter(|item| {
            item.get("info")
                .and_then(|info| info.get("role"))
                .and_then(Value::as_str)
                == Some("assistant")
                && item
                    .get("info")
                    .and_then(|info| info.get("parentID"))
                    .and_then(Value::as_str)
                    == Some(opencode_message_id)
        })
        .collect::<Vec<_>>();

    // ADR 0132/0137: once the exact deterministic wake exists, the assistant
    // projection is eventually consistent with the streaming POST. A missing
    // child is therefore pending until the bounded completion window expires;
    // session `/status` is telemetry and must not turn that projection race
    // into immediate manual review.
    if assistants.is_empty() {
        return ContinuationTurnState::Pending;
    }

    assistants.sort_by_key(|item| {
        item.get("info")
            .and_then(|info| info.get("time"))
            .and_then(|time| time.get("created"))
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    let latest = assistants.last().expect("assistants is non-empty");
    let info = latest.get("info").unwrap_or(latest);
    let assistant_message_id = info
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    if let Some(error) = info.get("error").filter(|value| !value.is_null()) {
        let compact = error.to_string();
        return ContinuationTurnState::Failed(format!(
            "agent_continuation_assistant_failed:{}:{}",
            assistant_message_id,
            compact.chars().take(600).collect::<String>()
        ));
    }
    let completed = info
        .get("time")
        .and_then(|time| time.get("completed"))
        .is_some_and(|value| !value.is_null())
        || info
            .get("finish")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty());
    if completed {
        return ContinuationTurnState::Completed {
            assistant_message_id,
        };
    }

    // A materialized child without a terminal marker is also pending. OpenCode
    // may transiently project the session as idle before `time.completed` /
    // `finish` is visible. The completion timeout, not session status, is the
    // fail-closed boundary for this accepted effect.
    ContinuationTurnState::Pending
}

async fn continuation_turn_state(
    http: &HttpClient,
    config: &Config,
    delivery: &ContinuationDelivery,
) -> Result<ContinuationTurnState> {
    let path = format!("/session/{}/message", delivery.session_id);
    let mut url = endpoint_url(&delivery.server_url, &path, delivery.directory.as_deref())?;
    url.query_pairs_mut().append_pair("limit", "100");
    let response = request_with_auth(config, http.get(url))
        .send()
        .await
        .context("agent_continuation_session_messages_failed")?;
    if !response.status().is_success() {
        bail!(
            "agent_continuation_session_messages_http:{}",
            response.status()
        );
    }
    let messages = response
        .json::<Value>()
        .await
        .context("agent_continuation_session_messages_invalid_json")?;
    let Some(items) = messages.as_array() else {
        bail!("agent_continuation_session_messages_shape_invalid");
    };
    Ok(continuation_turn_state_from_messages(
        items,
        &delivery.opencode_message_id,
    ))
}

fn continuation_completion_window_expired(
    delivery: &ContinuationDelivery,
    config: &Config,
) -> bool {
    let Some(started_at) = delivery.dispatch_started_at.as_deref() else {
        return false;
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(started_at) else {
        return true;
    };
    let age_ms = Utc::now()
        .signed_duration_since(parsed.with_timezone(&Utc))
        .num_milliseconds();
    age_ms >= config.agent_continuation_completion_timeout_ms as i64
}

async fn session_is_busy(
    http: &HttpClient,
    config: &Config,
    delivery: &ContinuationDelivery,
) -> Result<bool> {
    let url = endpoint_url(
        &delivery.server_url,
        "/session/status",
        delivery.directory.as_deref(),
    )?;
    let response = request_with_auth(config, http.get(url))
        .send()
        .await
        .context("agent_continuation_session_status_failed")?;
    if !response.status().is_success() {
        bail!(
            "agent_continuation_session_status_http:{}",
            response.status()
        );
    }
    let statuses = response
        .json::<Value>()
        .await
        .context("agent_continuation_session_status_invalid_json")?;
    let kind = statuses
        .get(&delivery.session_id)
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("idle");
    Ok(matches!(kind, "busy" | "retry"))
}

async fn dispatch_terminal_prompt(
    http: &HttpClient,
    config: &Config,
    delivery: &ContinuationDelivery,
) -> Result<()> {
    // R17.4.5: keep the legacy synchronous message endpoint because prompt_async
    // can admit a user wake without starting the idle-session assistant loop.
    // The HTTP response body is *not* the delivery acceptance boundary: the
    // endpoint streams the resumed assistant turn, so waiting for the body before
    // marking accepted creates a self-deadlock in which the current assistant
    // cannot observe its own terminal completion. Delivery acceptance is proved
    // independently from the exact deterministic user message materialized in
    // session history; this transport task is only the wake trigger.
    let path = format!("/session/{}/message", delivery.session_id);
    let url = endpoint_url(&delivery.server_url, &path, delivery.directory.as_deref())?;
    let mut body = json!({
        "messageID": &delivery.opencode_message_id,
        "agent": &delivery.session_agent_id,
        "model": {
            "providerID": &delivery.session_provider_id,
            "modelID": &delivery.session_model_id
        },
        "parts": [{"type": "text", "text": &delivery.prompt_text}],
    });
    if let Some(variant) = delivery
        .session_model_variant
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["variant"] = json!(variant);
    }
    let response = request_with_auth(config, http.post(url).json(&body))
        .timeout(Duration::from_millis(
            config.agent_continuation_completion_timeout_ms,
        ))
        .send()
        .await
        .context("agent_continuation_terminal_prompt_transport_failed")?;
    if !response.status().is_success() {
        bail!(
            "agent_continuation_terminal_prompt_http:{}",
            response.status()
        );
    }
    info!(
        event="agent_continuation.terminal_prompt_headers_accepted",
        run_id=%delivery.run_id,
        delivery_id=%delivery.delivery_id,
        effect_key=%delivery.effect_key,
        session_id=%delivery.session_id,
        opencode_message_id=%delivery.opencode_message_id,
        status=%response.status()
    );
    // Drain in the detached transport task. The authoritative worker path keeps
    // reconciling message history concurrently and may mark the delivery accepted
    // before this streaming body reaches EOF.
    let _ = response
        .bytes()
        .await
        .context("agent_continuation_terminal_prompt_response_failed")?;
    Ok(())
}

fn spawn_terminal_prompt(http: HttpClient, config: Config, delivery: ContinuationDelivery) {
    tokio::spawn(async move {
        match dispatch_terminal_prompt(&http, &config, &delivery).await {
            Ok(()) => info!(
                event="agent_continuation.terminal_prompt_transport_completed",
                run_id=%delivery.run_id,
                delivery_id=%delivery.delivery_id,
                effect_key=%delivery.effect_key,
                session_id=%delivery.session_id,
                opencode_message_id=%delivery.opencode_message_id
            ),
            Err(error) => warn!(
                event="agent_continuation.terminal_prompt_transport_finished_with_error",
                run_id=%delivery.run_id,
                delivery_id=%delivery.delivery_id,
                effect_key=%delivery.effect_key,
                session_id=%delivery.session_id,
                opencode_message_id=%delivery.opencode_message_id,
                error=%error
            ),
        }
    });
}

fn should_inject_fault_for(
    delivery: &ContinuationDelivery,
    fault: Option<&str>,
    effect_match: Option<&str>,
    expected_fault: &str,
) -> bool {
    fault == Some(expected_fault)
        && delivery.attempts == 0
        && effect_match.is_some_and(|marker| {
            delivery.effect_key.contains(marker)
                || delivery.run_id.contains(marker)
                || delivery.delivery_id.contains(marker)
                || delivery.session_id.contains(marker)
        })
}

fn should_inject_before_prompt_fault(delivery: &ContinuationDelivery, config: &Config) -> bool {
    should_inject_fault_for(
        delivery,
        config.agent_continuation_test_fault.as_deref(),
        config.agent_continuation_test_fault_effect_match.as_deref(),
        "after-dispatch-before-prompt-once",
    )
}

fn should_inject_after_prompt_fault(delivery: &ContinuationDelivery, config: &Config) -> bool {
    should_inject_fault_for(
        delivery,
        config.agent_continuation_test_fault.as_deref(),
        config.agent_continuation_test_fault_effect_match.as_deref(),
        "after-prompt-once",
    )
}

fn ambiguity_window_active(delivery: &ContinuationDelivery, config: &Config) -> bool {
    let Some(started_at) = delivery.dispatch_started_at.as_deref() else {
        return false;
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(started_at) else {
        return true;
    };
    let age_ms = Utc::now()
        .signed_duration_since(parsed.with_timezone(&Utc))
        .num_milliseconds();
    age_ms >= 0 && age_ms < config.agent_continuation_ambiguity_delay_ms as i64
}

async fn mark_dispatching(
    client: &Client,
    config: &Config,
    delivery: &ContinuationDelivery,
    claim_owner: &str,
) -> Result<()> {
    if delivery.attempts >= config.agent_continuation_max_attempts {
        bail!("agent_continuation_delivery_attempt_budget_exhausted");
    }
    let started_at = now();
    let changed = client
        .execute(
            "UPDATE agent_continuation_deliveries SET status='dispatching',attempts=attempts+1,dispatch_started_at=$2,updated_at=$2,last_error=NULL \
             WHERE delivery_id=$1 AND lease_owner=$3",
            &[&delivery.delivery_id, &started_at, &claim_owner],
        )
        .await?;
    if changed != 1 {
        bail!("agent_continuation_delivery_claim_lost_before_dispatch");
    }
    Ok(())
}

async fn mark_accepted(client: &Client, delivery_id: &str, claim_owner: &str) -> Result<()> {
    let accepted_at = now();
    let changed = client
        .execute(
            "UPDATE agent_continuation_deliveries SET status='accepted',accepted_at=COALESCE(accepted_at,$2),updated_at=$2,last_error=NULL \
             WHERE delivery_id=$1 AND lease_owner=$3",
            &[&delivery_id, &accepted_at, &claim_owner],
        )
        .await?;
    if changed != 1 {
        bail!("agent_continuation_delivery_claim_lost_before_accept");
    }
    Ok(())
}

struct DeferSpec<'a> {
    reason: &'a str,
    delay_ms: u64,
    next_status: &'a str,
}

async fn defer_delivery(
    client: &mut Client,
    envelope: &AgentRuntimeEnvelope,
    delivery: &ContinuationDelivery,
    payload_hash: &str,
    claim_owner: &str,
    spec: DeferSpec<'_>,
) -> Result<()> {
    if !matches!(spec.next_status, "deferred" | "dispatching" | "accepted") {
        bail!(
            "agent_continuation_defer_status_invalid:{}",
            spec.next_status
        );
    }
    let next_attempt_at =
        format_utc(Utc::now() + chrono::Duration::milliseconds(spec.delay_ms as i64));
    let changed_at = now();
    let transaction = client.transaction().await?;
    let delivery_changed = transaction
        .execute(
            "UPDATE agent_continuation_deliveries SET status=$2,next_attempt_at=$3,lease_owner=NULL,lease_expires_at=NULL,last_error=$4,updated_at=$5 \
             WHERE delivery_id=$1 AND lease_owner=$6",
            &[
                &delivery.delivery_id,
                &spec.next_status,
                &next_attempt_at,
                &spec.reason,
                &changed_at,
                &claim_owner,
            ],
        )
        .await?;
    let inbox_changed = transaction
        .execute(
            "UPDATE agent_runtime_inbox SET status='deferred',lease_owner=NULL,lease_expires_at=NULL,last_error=$4 \
             WHERE message_id=$1 AND payload_sha256=$2 AND lease_owner=$3 AND status='claimed'",
            &[&envelope.message_id, &payload_hash, &claim_owner, &spec.reason],
        )
        .await?;
    if delivery_changed != 1 || inbox_changed != 1 {
        transaction.rollback().await?;
        bail!("agent_continuation_claim_lost_before_defer");
    }
    transaction.commit().await?;
    Ok(())
}

async fn mark_delivery_dead(
    client: &mut Client,
    envelope: &AgentRuntimeEnvelope,
    delivery: Option<&ContinuationDelivery>,
    payload_hash: &str,
    claim_owner: &str,
    reason: &str,
) -> Result<()> {
    let changed_at = now();
    let transaction = client.transaction().await?;
    if let Some(delivery) = delivery {
        let delivery_changed = transaction
            .execute(
                "UPDATE agent_continuation_deliveries SET status='dead',lease_owner=NULL,lease_expires_at=NULL,last_error=$2,updated_at=$3 \
                 WHERE delivery_id=$1 AND lease_owner=$4",
                &[&delivery.delivery_id, &reason, &changed_at, &claim_owner],
            )
            .await?;
        if delivery_changed != 1 {
            transaction.rollback().await?;
            bail!("agent_continuation_delivery_claim_lost_before_dead");
        }
        transaction
            .execute(
                "INSERT INTO agent_events(event_id,run_id,task_id,event_type,payload_json,created_at) \
                 VALUES($1,$2,NULL,'continuation.delivery_dead',$3,$4)",
                &[
                    &event_id(),
                    &delivery.run_id,
                    &json!({
                        "continuationId": &delivery.continuation_id,
                        "deliveryId": &delivery.delivery_id,
                        "effectKey": &delivery.effect_key,
                        "reason": reason,
                        "source": "rust-opencode-continuation"
                    })
                    .to_string(),
                    &changed_at,
                ],
            )
            .await?;
    }
    let inbox_changed = transaction
        .execute(
            "UPDATE agent_runtime_inbox SET status='dead',lease_owner=NULL,lease_expires_at=NULL,last_error=$4 \
             WHERE message_id=$1 AND payload_sha256=$2 AND lease_owner=$3 AND status='claimed'",
            &[&envelope.message_id, &payload_hash, &claim_owner, &reason],
        )
        .await?;
    if inbox_changed != 1 {
        transaction.rollback().await?;
        bail!("agent_continuation_inbox_claim_lost_before_dead");
    }
    transaction.commit().await?;
    Ok(())
}

async fn mark_delivery_ambiguous(
    client: &mut Client,
    envelope: &AgentRuntimeEnvelope,
    delivery: &ContinuationDelivery,
    payload_hash: &str,
    claim_owner: &str,
    reason: &str,
) -> Result<()> {
    let changed_at = now();
    let transaction = client.transaction().await?;
    let delivery_changed = transaction
        .execute(
            "UPDATE agent_continuation_deliveries SET status='ambiguous',lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,last_error=$2,updated_at=$3 \
             WHERE delivery_id=$1 AND lease_owner=$4",
            &[&delivery.delivery_id, &reason, &changed_at, &claim_owner],
        )
        .await?;
    let inbox_changed = transaction
        .execute(
            "UPDATE agent_runtime_inbox SET status='processed',processed_at=$4,lease_owner=NULL,lease_expires_at=NULL,last_error=$5 \
             WHERE message_id=$1 AND payload_sha256=$2 AND lease_owner=$3 AND status='claimed'",
            &[
                &envelope.message_id,
                &payload_hash,
                &claim_owner,
                &changed_at,
                &reason,
            ],
        )
        .await?;
    if delivery_changed != 1 || inbox_changed != 1 {
        transaction.rollback().await?;
        bail!("agent_continuation_claim_lost_before_ambiguous_commit");
    }
    transaction
        .execute(
            "UPDATE agent_continuations SET status=CASE WHEN current_delivery_id=$2 THEN 'manual_review' ELSE status END,updated_at=$3 WHERE continuation_id=$1",
            &[
                &delivery.continuation_id,
                &delivery.delivery_id,
                &changed_at,
            ],
        )
        .await?;
    transaction
        .execute(
            "INSERT INTO agent_events(event_id,run_id,task_id,event_type,payload_json,created_at) VALUES($1,$2,NULL,'continuation.delivery_ambiguous',$3,$4)",
            &[
                &event_id(),
                &delivery.run_id,
                &json!({
                    "continuationId": &delivery.continuation_id,
                    "deliveryId": &delivery.delivery_id,
                    "effectKey": &delivery.effect_key,
                    "opencodeMessageId": &delivery.opencode_message_id,
                    "reason": reason,
                    "automaticRepost": false,
                    "source": "rust-opencode-continuation"
                })
                .to_string(),
                &changed_at,
            ],
        )
        .await?;
    transaction.commit().await?;
    Ok(())
}

async fn mark_observed(
    client: &mut Client,
    envelope: &AgentRuntimeEnvelope,
    delivery: &ContinuationDelivery,
    payload_hash: &str,
    claim_owner: &str,
    assistant_message_id: &str,
) -> Result<()> {
    let completed_at = now();
    let transaction = client.transaction().await?;
    let delivery_changed = transaction
        .execute(
            "UPDATE agent_continuation_deliveries SET status='observed',observed_at=COALESCE(observed_at,$2),completed_at=COALESCE(completed_at,$2),updated_at=$2,lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,last_error=NULL \
             WHERE delivery_id=$1 AND lease_owner=$3",
            &[&delivery.delivery_id, &completed_at, &claim_owner],
        )
        .await?;
    let inbox_changed = transaction
        .execute(
            "UPDATE agent_runtime_inbox SET status='processed',processed_at=$4,lease_owner=NULL,lease_expires_at=NULL,last_error=NULL \
             WHERE message_id=$1 AND payload_sha256=$2 AND lease_owner=$3 AND status='claimed'",
            &[&envelope.message_id, &payload_hash, &claim_owner, &completed_at],
        )
        .await?;
    if delivery_changed != 1 || inbox_changed != 1 {
        transaction.rollback().await?;
        bail!("agent_continuation_claim_lost_before_observed_commit");
    }
    transaction
        .execute(
            "UPDATE agent_continuations SET status=CASE WHEN current_delivery_id=$2 THEN 'delivered' ELSE status END,updated_at=$3 WHERE continuation_id=$1",
            &[
                &delivery.continuation_id,
                &delivery.delivery_id,
                &completed_at,
            ],
        )
        .await?;
    transaction
        .execute(
            "INSERT INTO agent_events(event_id,run_id,task_id,event_type,payload_json,created_at) VALUES($1,$2,NULL,'continuation.delivered',$3,$4)",
            &[
                &event_id(),
                &delivery.run_id,
                &json!({
                    "continuationId": &delivery.continuation_id,
                    "deliveryId": &delivery.delivery_id,
                    "effectKey": &delivery.effect_key,
                    "opencodeMessageId": &delivery.opencode_message_id,
                    "assistantMessageId": assistant_message_id,
                    "assistantTerminalObserved": true,
                    "sessionPromptIdentity": {
                        "agentId": &delivery.session_agent_id,
                        "providerId": &delivery.session_provider_id,
                        "modelId": &delivery.session_model_id,
                        "variant": &delivery.session_model_variant,
                        "sourceMessageId": &delivery.session_prompt_message_id
                    },
                    "generation": delivery.generation,
                    "source": "rust-opencode-continuation"
                })
                .to_string(),
                &completed_at,
            ],
        )
        .await?;
    transaction.commit().await?;
    Ok(())
}

async fn release_claim_after_error(
    client: &mut Client,
    envelope: &AgentRuntimeEnvelope,
    payload_hash: &str,
    claim_owner: &str,
    reason: &str,
) -> Result<()> {
    let transaction = client.transaction().await?;
    if let Some(delivery_id) = envelope.delivery_id.as_deref() {
        transaction
            .execute(
                "UPDATE agent_continuation_deliveries SET lease_owner=NULL,lease_expires_at=NULL,last_error=$3,updated_at=$4 \
                 WHERE delivery_id=$1 AND lease_owner=$2",
                &[&delivery_id, &claim_owner, &reason, &now()],
            )
            .await?;
    }
    let inbox_changed = transaction
        .execute(
            "UPDATE agent_runtime_inbox SET status='deferred',lease_owner=NULL,lease_expires_at=NULL,last_error=$4 \
             WHERE message_id=$1 AND payload_sha256=$2 AND lease_owner=$3 AND status='claimed'",
            &[&envelope.message_id, &payload_hash, &claim_owner, &reason],
        )
        .await?;
    if inbox_changed != 1 {
        transaction.rollback().await?;
        bail!("agent_continuation_inbox_claim_lost_during_error_release");
    }
    transaction.commit().await?;
    Ok(())
}

async fn verify_after_dispatch(
    http: &HttpClient,
    config: &Config,
    delivery: &ContinuationDelivery,
) -> Result<TargetMessageState> {
    for attempt in 0..config.agent_continuation_verify_attempts {
        match get_target_message(http, config, delivery).await? {
            TargetMessageState::Absent | TargetMessageState::Pending
                if attempt + 1 < config.agent_continuation_verify_attempts =>
            {
                sleep(Duration::from_millis(
                    config.agent_continuation_verify_delay_ms,
                ))
                .await;
            }
            state => return Ok(state),
        }
    }
    Ok(TargetMessageState::Absent)
}

async fn process_claimed(
    client: &mut Client,
    http: &HttpClient,
    config: &Config,
    envelope: &AgentRuntimeEnvelope,
    payload_hash: &str,
    claim_owner: &str,
) -> Result<DeliveryOutcome> {
    let delivery = match load_and_claim_delivery(client, envelope, claim_owner).await? {
        DeliveryClaim::Ready(delivery) => delivery,
        DeliveryClaim::Observed | DeliveryClaim::Cancelled => {
            mark_inbox_processed_owned(client, &envelope.message_id, payload_hash, claim_owner)
                .await?;
            return Ok(DeliveryOutcome::Ack);
        }
        DeliveryClaim::Busy => {
            defer_inbox_owned(
                client,
                &envelope.message_id,
                payload_hash,
                claim_owner,
                "agent_continuation_delivery_lease_busy",
            )
            .await?;
            return Ok(DeliveryOutcome::Requeue {
                delay_ms: config.agent_continuation_verify_delay_ms,
                reason: "agent_continuation_delivery_lease_busy".into(),
            });
        }
        DeliveryClaim::NotDue => {
            defer_inbox_owned(
                client,
                &envelope.message_id,
                payload_hash,
                claim_owner,
                "agent_continuation_next_attempt_not_due",
            )
            .await?;
            return Ok(DeliveryOutcome::Requeue {
                delay_ms: config.agent_continuation_verify_delay_ms,
                reason: "agent_continuation_next_attempt_not_due".into(),
            });
        }
        DeliveryClaim::Dead { reason, delivery } => {
            return Ok(DeliveryOutcome::Dead { reason, delivery });
        }
    };

    if delivery.adapter_id != "opencode" {
        return Ok(DeliveryOutcome::Dead {
            reason: format!(
                "agent_continuation_adapter_unsupported:{}",
                delivery.adapter_id
            ),
            delivery: Some(delivery),
        });
    }

    if !acquire_session_lock(client, &delivery).await? {
        defer_delivery(
            client,
            envelope,
            &delivery,
            payload_hash,
            claim_owner,
            DeferSpec {
                reason: "agent_continuation_session_lock_busy",
                delay_ms: config.agent_continuation_verify_delay_ms,
                next_status: "deferred",
            },
        )
        .await?;
        return Ok(DeliveryOutcome::Requeue {
            delay_ms: config.agent_continuation_verify_delay_ms,
            reason: "agent_continuation_session_lock_busy".into(),
        });
    }

    let outcome = async {
        match get_target_message(http, config, &delivery).await? {
            TargetMessageState::Match => {
                match continuation_turn_state(http, config, &delivery).await? {
                    ContinuationTurnState::Completed {
                        assistant_message_id,
                    } => {
                        mark_observed(
                            client,
                            envelope,
                            &delivery,
                            payload_hash,
                            claim_owner,
                            &assistant_message_id,
                        )
                        .await?;
                        return Ok(DeliveryOutcome::Ack);
                    }
                    ContinuationTurnState::Failed(reason) => {
                        return Ok(DeliveryOutcome::Ambiguous {
                            reason,
                            delivery: delivery.clone(),
                        });
                    }
                    ContinuationTurnState::Pending => {
                        if continuation_completion_window_expired(&delivery, config) {
                            return Ok(DeliveryOutcome::Ambiguous {
                                reason: "agent_continuation_assistant_completion_timeout".into(),
                                delivery: delivery.clone(),
                            });
                        }
                        defer_delivery(
                            client,
                            envelope,
                            &delivery,
                            payload_hash,
                            claim_owner,
                            DeferSpec {
                                reason: "agent_continuation_assistant_response_pending",
                                delay_ms: config.agent_continuation_verify_delay_ms,
                                next_status: "accepted",
                            },
                        )
                        .await?;
                        return Ok(DeliveryOutcome::Requeue {
                            delay_ms: config.agent_continuation_verify_delay_ms,
                            reason: "agent_continuation_assistant_response_pending".into(),
                        });
                    }
                }
            }
            TargetMessageState::Collision(reason) => {
                return Ok(DeliveryOutcome::Dead {
                    reason,
                    delivery: Some(delivery.clone()),
                });
            }
            TargetMessageState::Pending => {
                if delivery.dispatch_started_at.is_some()
                    && !ambiguity_window_active(&delivery, config)
                {
                    return Ok(DeliveryOutcome::Ambiguous {
                        reason: "agent_continuation_target_message_pending_after_ambiguity_window"
                            .into(),
                        delivery: delivery.clone(),
                    });
                }
                defer_delivery(
                    client,
                    envelope,
                    &delivery,
                    payload_hash,
                    claim_owner,
                    DeferSpec {
                        reason: "agent_continuation_target_message_pending",
                        delay_ms: config.agent_continuation_verify_delay_ms,
                        next_status: if delivery.dispatch_started_at.is_some() {
                            if delivery.prior_status == "accepted" {
                                "accepted"
                            } else {
                                "dispatching"
                            }
                        } else {
                            "deferred"
                        },
                    },
                )
                .await?;
                return Ok(DeliveryOutcome::Requeue {
                    delay_ms: config.agent_continuation_verify_delay_ms,
                    reason: "agent_continuation_target_message_pending".into(),
                });
            }
            TargetMessageState::Absent => {}
        }

        if delivery.dispatch_started_at.is_some() {
            if ambiguity_window_active(&delivery, config) {
                defer_delivery(
                    client,
                    envelope,
                    &delivery,
                    payload_hash,
                    claim_owner,
                    DeferSpec {
                        reason: "agent_continuation_ambiguous_dispatch_window",
                        delay_ms: config.agent_continuation_verify_delay_ms,
                        next_status: if delivery.prior_status == "accepted" {
                            "accepted"
                        } else {
                            "dispatching"
                        },
                    },
                )
                .await?;
                return Ok(DeliveryOutcome::Requeue {
                    delay_ms: config.agent_continuation_verify_delay_ms,
                    reason: "agent_continuation_ambiguous_dispatch_window".into(),
                });
            }
            return Ok(DeliveryOutcome::Ambiguous {
                reason: "agent_continuation_dispatch_unobserved_no_automatic_repost".into(),
                delivery: delivery.clone(),
            });
        }

        if session_is_busy(http, config, &delivery).await? {
            defer_delivery(
                client,
                envelope,
                &delivery,
                payload_hash,
                claim_owner,
                DeferSpec {
                    reason: "agent_continuation_session_busy",
                    delay_ms: config.agent_continuation_verify_delay_ms,
                    next_status: "deferred",
                },
            )
            .await?;
            return Ok(DeliveryOutcome::Requeue {
                delay_ms: config.agent_continuation_verify_delay_ms,
                reason: "agent_continuation_session_busy".into(),
            });
        }

        if delivery.attempts >= config.agent_continuation_max_attempts {
            return Ok(DeliveryOutcome::Dead {
                reason: "agent_continuation_delivery_attempt_budget_exhausted".into(),
                delivery: Some(delivery.clone()),
            });
        }
        mark_dispatching(client, config, &delivery, claim_owner).await?;
        if should_inject_before_prompt_fault(&delivery, config) {
            bail!("agent_continuation_test_fault_after_dispatch_before_prompt_once");
        }
        info!(
            event="agent_continuation.terminal_prompt_dispatching",
            run_id=%delivery.run_id,
            delivery_id=%delivery.delivery_id,
            effect_key=%delivery.effect_key,
            session_id=%delivery.session_id,
            opencode_message_id=%delivery.opencode_message_id,
            session_agent_id=%delivery.session_agent_id,
            session_provider_id=%delivery.session_provider_id,
            session_model_id=%delivery.session_model_id,
            session_prompt_message_id=?delivery.session_prompt_message_id
        );
        // Do not await the streaming response body here. The resumed assistant
        // turn itself is carried by that response. The authoritative delivery
        // path must reconcile the deterministic user message concurrently.
        spawn_terminal_prompt((*http).clone(), (*config).clone(), delivery.clone());
        info!(
            event="agent_continuation.terminal_prompt_spawned",
            run_id=%delivery.run_id,
            delivery_id=%delivery.delivery_id,
            effect_key=%delivery.effect_key,
            session_id=%delivery.session_id,
            opencode_message_id=%delivery.opencode_message_id
        );
        if should_inject_after_prompt_fault(&delivery, config) {
            bail!("agent_continuation_test_fault_after_prompt_once");
        }

        match verify_after_dispatch(http, config, &delivery).await? {
            TargetMessageState::Match => {
                // R17.4.5 acceptance is the durable target-message proof, not
                // completion of the synchronous HTTP stream. This can become true
                // while the resumed assistant child is still running.
                mark_accepted(client, &delivery.delivery_id, claim_owner).await?;
                info!(
                    event="agent_continuation.target_message_materialized",
                    run_id=%delivery.run_id,
                    delivery_id=%delivery.delivery_id,
                    effect_key=%delivery.effect_key,
                    session_id=%delivery.session_id,
                    opencode_message_id=%delivery.opencode_message_id
                );
                match continuation_turn_state(http, config, &delivery).await? {
                    ContinuationTurnState::Completed {
                        assistant_message_id,
                    } => {
                        mark_observed(
                            client,
                            envelope,
                            &delivery,
                            payload_hash,
                            claim_owner,
                            &assistant_message_id,
                        )
                        .await?;
                        Ok(DeliveryOutcome::Ack)
                    }
                    ContinuationTurnState::Failed(reason) => Ok(DeliveryOutcome::Ambiguous {
                        reason,
                        delivery: delivery.clone(),
                    }),
                    ContinuationTurnState::Pending => {
                        defer_delivery(
                            client,
                            envelope,
                            &delivery,
                            payload_hash,
                            claim_owner,
                            DeferSpec {
                                reason: "agent_continuation_assistant_response_pending",
                                delay_ms: config.agent_continuation_verify_delay_ms,
                                next_status: "accepted",
                            },
                        )
                        .await?;
                        Ok(DeliveryOutcome::Requeue {
                            delay_ms: config.agent_continuation_verify_delay_ms,
                            reason: "agent_continuation_assistant_response_pending".into(),
                        })
                    }
                }
            }
            TargetMessageState::Collision(reason) => Ok(DeliveryOutcome::Dead {
                reason,
                delivery: Some(delivery.clone()),
            }),
            TargetMessageState::Absent | TargetMessageState::Pending => {
                // The synchronous stream may still be creating the deterministic
                // user message. Preserve dispatching and requeue verification;
                // never repost while the first effect is ambiguous.
                defer_delivery(
                    client,
                    envelope,
                    &delivery,
                    payload_hash,
                    claim_owner,
                    DeferSpec {
                        reason: "agent_continuation_prompt_inflight_not_yet_materialized",
                        delay_ms: config.agent_continuation_verify_delay_ms,
                        next_status: "dispatching",
                    },
                )
                .await?;
                Ok(DeliveryOutcome::Requeue {
                    delay_ms: config.agent_continuation_verify_delay_ms,
                    reason: "agent_continuation_prompt_inflight_not_yet_materialized".into(),
                })
            }
        }
    }
    .await;

    release_session_lock(client, &delivery).await;
    outcome
}

async fn handle_delivery(
    mut client: Client,
    http: HttpClient,
    config: Config,
    delivery: lapin::message::Delivery,
) {
    let envelope = match serde_json::from_slice::<AgentRuntimeEnvelope>(&delivery.data)
        .context("agent_continuation_envelope_invalid")
        .and_then(|value| {
            value.validate()?;
            if value.kind != "agent.continuation.wake.v1" {
                bail!("agent_continuation_message_kind_invalid");
            }
            Ok(value)
        }) {
        Ok(value) => value,
        Err(error) => {
            error!(event="agent_continuation.message_invalid", error=%error);
            let _ = delivery
                .nack(BasicNackOptions {
                    requeue: false,
                    ..Default::default()
                })
                .await;
            return;
        }
    };
    let payload_hash = payload_sha256(&delivery.data);
    let claim_owner = format!("{}:{}", config.worker_id, Uuid::new_v4());
    match claim_inbox(&mut client, &config, &envelope, &payload_hash, &claim_owner).await {
        Ok(InboxClaim::ProcessedDuplicate) => {
            info!(event="agent_continuation.rabbit_duplicate_suppressed", message_id=%envelope.message_id, run_id=%envelope.run_id, effect_key=?envelope.effect_key);
            let _ = delivery.ack(BasicAckOptions::default()).await;
            return;
        }
        Ok(InboxClaim::Busy) => {
            sleep(Duration::from_millis(
                config.agent_continuation_verify_delay_ms,
            ))
            .await;
            let _ = delivery
                .nack(BasicNackOptions {
                    requeue: true,
                    ..Default::default()
                })
                .await;
            return;
        }
        Ok(InboxClaim::Poison(reason)) => {
            error!(event="agent_continuation.inbox_poison", message_id=%envelope.message_id, run_id=%envelope.run_id, reason=%reason);
            let _ = delivery
                .nack(BasicNackOptions {
                    requeue: false,
                    ..Default::default()
                })
                .await;
            return;
        }
        Ok(InboxClaim::Claimed) => {}
        Err(error) => {
            error!(event="agent_continuation.inbox_claim_failed", message_id=%envelope.message_id, run_id=%envelope.run_id, error=%error);
            let _ = delivery
                .nack(BasicNackOptions {
                    requeue: true,
                    ..Default::default()
                })
                .await;
            return;
        }
    }

    let result = process_claimed(
        &mut client,
        &http,
        &config,
        &envelope,
        &payload_hash,
        &claim_owner,
    )
    .await;
    match result {
        Ok(DeliveryOutcome::Ack) => {
            info!(event="agent_continuation.delivery_observed", message_id=%envelope.message_id, run_id=%envelope.run_id, delivery_id=?envelope.delivery_id, effect_key=?envelope.effect_key);
            let _ = delivery.ack(BasicAckOptions::default()).await;
        }
        Ok(DeliveryOutcome::Requeue { delay_ms, reason }) => {
            debug!(event="agent_continuation.delivery_deferred", message_id=%envelope.message_id, run_id=%envelope.run_id, delivery_id=?envelope.delivery_id, delay_ms, reason=%reason);
            sleep(Duration::from_millis(delay_ms)).await;
            let _ = delivery
                .nack(BasicNackOptions {
                    requeue: true,
                    ..Default::default()
                })
                .await;
        }
        Ok(DeliveryOutcome::Ambiguous {
            reason,
            delivery: target,
        }) => {
            let mark_result = mark_delivery_ambiguous(
                &mut client,
                &envelope,
                &target,
                &payload_hash,
                &claim_owner,
                &reason,
            )
            .await;
            if let Err(mark_error) = mark_result {
                error!(event="agent_continuation.ambiguous_commit_failed", message_id=%envelope.message_id, run_id=%envelope.run_id, error=%mark_error);
                let _ = delivery
                    .nack(BasicNackOptions {
                        requeue: true,
                        ..Default::default()
                    })
                    .await;
                return;
            }
            warn!(event="agent_continuation.delivery_ambiguous", message_id=%envelope.message_id, run_id=%envelope.run_id, delivery_id=%target.delivery_id, effect_key=%target.effect_key, reason=%reason, automatic_repost=false);
            let _ = delivery.ack(BasicAckOptions::default()).await;
        }
        Ok(DeliveryOutcome::Dead {
            reason,
            delivery: target,
        }) => {
            let mark_result = mark_delivery_dead(
                &mut client,
                &envelope,
                target.as_ref(),
                &payload_hash,
                &claim_owner,
                &reason,
            )
            .await;
            if let Err(mark_error) = mark_result {
                error!(event="agent_continuation.dead_commit_failed", message_id=%envelope.message_id, run_id=%envelope.run_id, error=%mark_error);
                let _ = delivery
                    .nack(BasicNackOptions {
                        requeue: true,
                        ..Default::default()
                    })
                    .await;
                return;
            }
            error!(event="agent_continuation.delivery_dead", message_id=%envelope.message_id, run_id=%envelope.run_id, delivery_id=?envelope.delivery_id, reason=%reason);
            let _ = delivery
                .nack(BasicNackOptions {
                    requeue: false,
                    ..Default::default()
                })
                .await;
        }
        Err(error) => {
            let reason = error.to_string();
            warn!(event="agent_continuation.delivery_error", message_id=%envelope.message_id, run_id=%envelope.run_id, delivery_id=?envelope.delivery_id, error=%reason);
            if let Err(release_error) = release_claim_after_error(
                &mut client,
                &envelope,
                &payload_hash,
                &claim_owner,
                &reason,
            )
            .await
            {
                error!(event="agent_continuation.error_release_failed", message_id=%envelope.message_id, run_id=%envelope.run_id, error=%release_error);
            }
            sleep(Duration::from_millis(
                config.agent_continuation_verify_delay_ms,
            ))
            .await;
            let _ = delivery
                .nack(BasicNackOptions {
                    requeue: true,
                    ..Default::default()
                })
                .await;
        }
    }
}

pub async fn consume(config: Config, channel: Channel) -> Result<()> {
    channel.basic_qos(4, BasicQosOptions::default()).await?;
    let mut consumer = channel
        .basic_consume(
            CONTINUATION_QUEUE.into(),
            "agent-runtime-opencode-continuation".into(),
            BasicConsumeOptions::default(),
            FieldTable::default(),
        )
        .await?;
    let http = HttpClient::builder()
        .timeout(Duration::from_millis(
            config.agent_continuation_http_timeout_ms,
        ))
        .build()
        .context("agent_continuation_http_client_build_failed")?;
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    info!(event="agent_continuation.consumer_started", worker_id=%config.worker_id, queue=CONTINUATION_QUEUE, concurrency=4);
    while let Some(delivery) = consumer.next().await {
        let delivery = delivery?;
        let permit = semaphore.clone().acquire_owned().await?;
        let client = match connect_database(&config).await {
            Ok(client) => client,
            Err(error) => {
                error!(event="agent_continuation.database_connect_failed", error=%error);
                delivery
                    .nack(BasicNackOptions {
                        requeue: true,
                        ..Default::default()
                    })
                    .await?;
                continue;
            }
        };
        let config = config.clone();
        let http = http.clone();
        tokio::spawn(async move {
            let _permit = permit;
            handle_delivery(client, http, config, delivery).await;
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_delivery() -> ContinuationDelivery {
        ContinuationDelivery {
            delivery_id: "delivery-1".into(),
            continuation_id: "continuation-1".into(),
            adapter_id: "opencode".into(),
            run_id: "run-1".into(),
            generation: 0,
            effect_key: "sha256:effect".into(),
            opencode_message_id: "msg_1".into(),
            prompt_text: "prompt".into(),
            prompt_sha256: text_sha256("prompt"),
            prior_status: "pending".into(),
            attempts: 0,
            dispatch_started_at: None,
            next_attempt_at: None,
            server_url: "http://localhost:4096".into(),
            session_id: "ses_1".into(),
            directory: None,
            session_agent_id: "main-orchestrator".into(),
            session_provider_id: "openai".into(),
            session_model_id: "gpt-5.6-luna".into(),
            session_model_variant: None,
            session_prompt_message_id: Some("msg_source".into()),
            continuation_status: "parked".into(),
        }
    }

    #[test]
    fn matching_target_message_requires_effect_marker_and_prompt_hash() {
        let prompt = "hello\nclip-continuation-effect: sha256:abc";
        let value = json!({"parts":[{"type":"text","text":prompt}]});
        assert!(matches!(
            target_message_state(&value, "sha256:abc", &text_sha256(prompt)),
            TargetMessageState::Match
        ));
        assert!(matches!(
            target_message_state(&value, "sha256:def", &text_sha256(prompt)),
            TargetMessageState::Collision(_)
        ));
    }

    #[test]
    fn target_message_without_materialized_text_is_pending_not_collision() {
        let value = json!({"info":{"role":"user"},"parts":[]});
        assert!(matches!(
            target_message_state(&value, "sha256:abc", &text_sha256("prompt")),
            TargetMessageState::Pending
        ));
    }

    #[test]
    fn after_prompt_fault_is_scoped_and_once_per_effect() {
        let mut delivery = test_delivery();
        delivery.effect_key = "sha256:effect-1".into();
        assert!(should_inject_fault_for(
            &delivery,
            Some("after-prompt-once"),
            Some("effect-1"),
            "after-prompt-once",
        ));
        assert!(should_inject_fault_for(
            &delivery,
            Some("after-dispatch-before-prompt-once"),
            Some("effect-1"),
            "after-dispatch-before-prompt-once",
        ));
        delivery.attempts = 1;
        assert!(!should_inject_fault_for(
            &delivery,
            Some("after-prompt-once"),
            Some("effect-1"),
            "after-prompt-once",
        ));
    }

    #[test]
    fn accepted_wake_without_assistant_child_remains_pending() {
        let items = json!([]);
        assert!(matches!(
            continuation_turn_state_from_messages(items.as_array().unwrap(), "msg_1"),
            ContinuationTurnState::Pending
        ));
    }

    #[test]
    fn nonterminal_assistant_child_remains_pending_until_bounded_timeout() {
        let items = json!([{
            "info": {
                "id": "msg_assistant_1",
                "role": "assistant",
                "parentID": "msg_1",
                "time": {"created": 1000, "completed": null},
                "finish": ""
            }
        }]);
        assert!(matches!(
            continuation_turn_state_from_messages(items.as_array().unwrap(), "msg_1"),
            ContinuationTurnState::Pending
        ));
    }

    #[test]
    fn terminal_assistant_child_completes_posterior_audit() {
        let items = json!([{
            "info": {
                "id": "msg_assistant_1",
                "role": "assistant",
                "parentID": "msg_1",
                "time": {"created": 1000, "completed": 2000}
            }
        }]);
        assert!(matches!(
            continuation_turn_state_from_messages(items.as_array().unwrap(), "msg_1"),
            ContinuationTurnState::Completed { assistant_message_id } if assistant_message_id == "msg_assistant_1"
        ));
    }

    #[test]
    fn explicit_assistant_error_is_immediately_ambiguous() {
        let items = json!([{
            "info": {
                "id": "msg_assistant_1",
                "role": "assistant",
                "parentID": "msg_1",
                "time": {"created": 1000},
                "error": {"name": "ProviderError", "message": "boom"}
            }
        }]);
        assert!(matches!(
            continuation_turn_state_from_messages(items.as_array().unwrap(), "msg_1"),
            ContinuationTurnState::Failed(reason) if reason.starts_with("agent_continuation_assistant_failed:msg_assistant_1:")
        ));
    }

    #[test]
    fn endpoint_never_accepts_embedded_credentials() {
        assert!(endpoint_url("http://user:pass@localhost:4096", "/session/status", None).is_err());
    }

    #[test]
    fn directory_is_encoded_as_query_not_path() {
        let url = endpoint_url(
            "http://localhost:4096",
            "/session/ses_1/message/msg_1",
            Some("D:\\sample project"),
        )
        .unwrap();
        assert_eq!(url.path(), "/session/ses_1/message/msg_1");
        assert!(url.query().unwrap().contains("directory="));
    }
}
