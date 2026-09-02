mod agent_continuation; mod agent_runtime; mod amqp; mod config;
use anyhow::Result; use clap::Parser; use config::Config;
#[derive(Parser,Debug)] #[command(name="agentic-harness-worker")]
struct Cli { #[arg(long, env="AGENT_HARNESS_RUNTIME_WORKER_CONCURRENCY", default_value_t=3)] concurrency:u16 }
#[tokio::main] async fn main() -> Result<()> {
 let _=rustls::crypto::ring::default_provider().install_default();
 tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).json().init();
 let cli=Cli::parse(); agent_runtime::run(Config::from_env()?,cli.concurrency).await
}
