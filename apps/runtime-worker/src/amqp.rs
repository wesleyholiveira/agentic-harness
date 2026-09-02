use crate::config::Config;
use anyhow::{Context, Result, bail};
use lapin::{BasicProperties, Channel, Confirmation, Connection, ConnectionProperties, options::BasicPublishOptions, types::{AMQPValue, LongString}};

pub fn long_string(value: impl Into<String>) -> AMQPValue { AMQPValue::LongString(LongString::from(value.into())) }
pub async fn connect(config: &Config) -> Result<Connection> {
    Connection::connect(&config.amqp_url, ConnectionProperties::default().enable_auto_recover()).await.context("rabbitmq_connection_failed")
}
pub async fn publish_raw_confirmed(channel: &Channel, exchange: &str, routing_key: &str, body: &[u8], properties: BasicProperties) -> Result<()> {
    let confirmation = channel.basic_publish(exchange.into(), routing_key.into(), BasicPublishOptions { mandatory: true, ..Default::default() }, body, properties).await?.await?;
    match confirmation { Confirmation::Ack(None) => Ok(()), Confirmation::Ack(Some(_)) => bail!("rabbitmq_publish_unroutable"), Confirmation::Nack(_) => bail!("rabbitmq_publish_nack"), Confirmation::NotRequested => bail!("rabbitmq_publish_not_confirmed") }
}
