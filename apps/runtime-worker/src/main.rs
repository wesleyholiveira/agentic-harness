mod agent_continuation;
mod agent_runtime;
mod amqp;
mod config;
use anyhow::Result;
use clap::Parser;
use config::Config;
use tracing::info;
#[derive(Parser, Debug)]
#[command(name = "agentic-harness-worker")]
struct Cli {
    #[arg(
        long,
        env = "AGENT_HARNESS_RUNTIME_WORKER_CONCURRENCY",
        default_value_t = 3
    )]
    concurrency: u16,
}
#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .json()
        .init();
    let cli = Cli::parse();
    info!(event="agent_runtime.worker_starting", concurrency=cli.concurrency);
    agent_runtime::run(Config::from_env()?, cli.concurrency).await
}
