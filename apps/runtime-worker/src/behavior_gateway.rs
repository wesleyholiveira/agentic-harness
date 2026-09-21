use std::time::Duration;

use anyhow::{Context, Result, bail};
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use uuid::Uuid;

use crate::config::Config;

const MAX_GATEWAY_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorGateDescriptor {
    pub schema_version: String,
    pub command_authority: Value,
    pub command_spec_ids: Vec<String>,
    pub workspace_path: String,
}

impl BehaviorGateDescriptor {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != "behavior-gate-descriptor/v1" {
            bail!("behavior_gate_descriptor_version_invalid");
        }
        if self.command_spec_ids.is_empty() || self.command_spec_ids.len() > 32 {
            bail!("behavior_gate_descriptor_command_ids_invalid");
        }
        if self.workspace_path.trim().is_empty() {
            bail!("behavior_gate_descriptor_workspace_missing");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExecutionFence {
    pub schema_version: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt: i32,
    pub dispatch_generation: i64,
    pub fencing_token: i64,
    pub lease_owner: String,
    pub lease_expires_at: String,
    pub observed_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayRequest<'a> {
    schema_version: &'static str,
    command_authority: &'a Value,
    command_spec_ids: &'a [String],
    execution_fence: &'a TaskExecutionFence,
    workspace_path: &'a str,
    capability: &'a str,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorGatewayResult {
    pub schema_version: String,
    pub status: String,
    pub code: String,
    #[serde(default)]
    pub receipts: Vec<Value>,
    #[serde(default)]
    pub command_authority: Option<Value>,
    #[serde(default)]
    pub workspace_binding_digest: Option<String>,
}

impl BehaviorGatewayResult {
    pub fn hold(code: impl Into<String>) -> Self {
        Self {
            schema_version: "docker-behavior-gateway-result/v1".into(),
            status: "HOLD".into(),
            code: code.into(),
            receipts: Vec::new(),
            command_authority: None,
            workspace_binding_digest: None,
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != "docker-behavior-gateway-result/v1" {
            bail!("behavior_gateway_result_version_invalid");
        }
        if !matches!(self.status.as_str(), "PASSED" | "FAILED" | "HOLD") {
            bail!("behavior_gateway_result_status_invalid");
        }
        if self.code.trim().is_empty() {
            bail!("behavior_gateway_result_code_missing");
        }
        Ok(())
    }
}

pub fn new_capability() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub fn capability_proof(secret: &str, capability: &str, fence: &TaskExecutionFence) -> Result<String> {
    if secret.as_bytes().len() < 32 {
        bail!("behavior_gateway_hmac_key_too_short");
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| anyhow::anyhow!("behavior_gateway_hmac_key_invalid"))?;
    let attempt = fence.attempt.to_string();
    let generation = fence.dispatch_generation.to_string();
    let fencing_token = fence.fencing_token.to_string();
    for value in [
        fence.run_id.as_str(),
        fence.task_id.as_str(),
        attempt.as_str(),
        generation.as_str(),
        fencing_token.as_str(),
        fence.lease_owner.as_str(),
        capability,
    ] {
        mac.update(value.as_bytes());
        mac.update(&[0]);
    }
    Ok(format!("hmac-sha256:{:x}", mac.finalize().into_bytes()))
}

pub async fn invoke_gateway(
    config: &Config,
    descriptor: &BehaviorGateDescriptor,
    fence: &TaskExecutionFence,
    capability: &str,
) -> Result<BehaviorGatewayResult> {
    descriptor.validate()?;
    let url = config
        .behavior_gateway_url
        .as_deref()
        .context("behavior_gateway_url_required")?;
    if capability.len() < 32 {
        bail!("behavior_gateway_capability_invalid");
    }
    let client = Client::builder()
        .timeout(Duration::from_millis(config.behavior_gateway_http_timeout_ms))
        .build()
        .context("behavior_gateway_client_build_failed")?;
    let request = GatewayRequest {
        schema_version: "docker-behavior-gateway-request/v1",
        command_authority: &descriptor.command_authority,
        command_spec_ids: &descriptor.command_spec_ids,
        execution_fence: fence,
        workspace_path: &descriptor.workspace_path,
        capability,
    };
    let response = client
        .post(url)
        .json(&request)
        .send()
        .await
        .context("behavior_gateway_transport_failed")?;
    let bytes = response
        .bytes()
        .await
        .context("behavior_gateway_response_read_failed")?;
    if bytes.len() > MAX_GATEWAY_RESPONSE_BYTES {
        bail!("behavior_gateway_response_too_large");
    }
    let result: BehaviorGatewayResult =
        serde_json::from_slice(&bytes).context("behavior_gateway_response_invalid")?;
    result.validate()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_has_high_entropy_shape_and_stable_fingerprint() {
        let capability = new_capability();
        assert_eq!(capability.len(), 64);
        assert!(capability.chars().all(|ch| ch.is_ascii_hexdigit()));
        let fence = TaskExecutionFence {
            schema_version: "task-execution-fence/v1".into(),
            run_id: "run-a".into(),
            task_id: "task-a".into(),
            attempt: 1,
            dispatch_generation: 2,
            fencing_token: 3,
            lease_owner: "worker-a".into(),
            lease_expires_at: "2099-01-01T00:00:00.000Z".into(),
            observed_at: "2026-09-21T00:00:00.000Z".into(),
        };
        let secret = "s".repeat(32);
        let proof = capability_proof(&secret, &capability, &fence).unwrap();
        assert!(proof.starts_with("hmac-sha256:"));
        assert_eq!(proof, capability_proof(&secret, &capability, &fence).unwrap());
        assert_ne!(proof, capability_proof(&secret, &new_capability(), &fence).unwrap());
        let mut replacement_fence = fence.clone();
        replacement_fence.fencing_token += 1;
        assert_ne!(proof, capability_proof(&secret, &capability, &replacement_fence).unwrap());
        assert!(capability_proof("short", &capability, &fence).is_err());
    }

    #[test]
    fn descriptor_requires_version_commands_and_workspace() {
        let valid = BehaviorGateDescriptor {
            schema_version: "behavior-gate-descriptor/v1".into(),
            command_authority: serde_json::json!({"schemaVersion":"command-authority/v1"}),
            command_spec_ids: vec!["verify.unit".into()],
            workspace_path: "/workspace/agent-workspaces/run/task".into(),
        };
        assert!(valid.validate().is_ok());
        let mut empty = valid.clone();
        empty.command_spec_ids.clear();
        assert!(empty.validate().is_err());
    }
}
