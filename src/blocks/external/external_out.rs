// Copyright (c) 2022-2026, Radu Racariu.

//! External output block.

use libhaystack::val::Value;

use crate::base::{
    block::{Block, BlockProps, BlockState},
    connector::get_connector,
    input::{InputProps, input_reader::InputReader},
    output::Output,
};
use crate::blocks::external::support::input_as_str;
use crate::tokio_impl::block::drain_ready_inputs;

use crate::{blocks::InputImpl, blocks::OutputImpl};

/// Publishes the block's input value to an external system.
///
/// Resolves the [`Connector`](crate::base::connector::Connector)
/// registered under the name on the `connector` pin and publishes each
/// fresh `in` value to the address on the `address` pin. The published
/// value is echoed on `out` so downstream blocks can chain off a
/// successful publish; the block faults when the connector is missing
/// or the publish fails.
///
/// Only a fresh `in` value fires a publish: rewriting `connector` or
/// `address` alone re-binds without re-publishing the cached value,
/// and — like value flow everywhere in the engine — re-emitting the
/// value already cached on `in` does not fire. A value that arrives
/// before the `connector` and `address` pins resolve is held and
/// published once they do.
///
/// # Delivery semantics
///
/// Cancellation from the block actor's mailbox drops the in-flight
/// publish future, but the value is kept and the publish is re-issued
/// on the next cycle: a publish cancelled mid-flight may already have
/// reached the external system and will be sent again, so subscribers
/// should tolerate duplicates (at-least-once semantics).
#[block]
#[derive(BlockProps, Debug)]
#[category = "external"]
pub struct ExternalOut {
    #[input(name = "in", kind = "Null")]
    pub input: InputImpl,
    #[input(kind = "Str")]
    pub connector: InputImpl,
    #[input(kind = "Str")]
    pub address: InputImpl,
    #[output(kind = "Null")]
    pub out: OutputImpl,
    /// The value awaiting a completed publish: set when a fresh `in`
    /// value arrives, kept across a cancelled `execute` so the publish
    /// is re-issued, and cleared on any completion — publish success,
    /// publish error, or connector miss.
    pending: Option<Value>,
}

impl Block for ExternalOut {
    async fn execute(&mut self) {
        // Drain without blocking only when the held value can be
        // re-published right away; otherwise block on inputs so the
        // actor does not spin. Config pins are still drained either
        // way, so rebinds are honored before every attempt.
        let can_retry_now = self.pending.is_some()
            && input_as_str(&self.connector).is_some()
            && input_as_str(&self.address).is_some();

        let before = self.input.get_value().cloned();
        if can_retry_now {
            drain_ready_inputs(self);
        } else {
            self.read_inputs_until_ready().await;
        }

        // Only a change of the `in` cache is a fresh value — the cache
        // moves on genuine value changes alone, so a config-only pin
        // write cannot re-publish the cached value, and a retry of
        // `pending` is never mistaken for fresh input. A fresh value
        // replaces any held retry; `Null` fires nothing.
        if self.input.get_value() != before.as_ref()
            && let Some(value) = self.input.get_value()
            && !matches!(value, Value::Null)
        {
            self.pending = Some(value.clone());
        }

        let Some(value) = self.pending.clone() else {
            return;
        };

        let (Some(connector), Some(address)) =
            (input_as_str(&self.connector), input_as_str(&self.address))
        else {
            return;
        };

        let Some(handle) = get_connector(&connector) else {
            self.pending = None;
            self.set_state(BlockState::fault(format!(
                "ExternalOut: no connector named '{connector}'"
            )));
            return;
        };

        // A completed publish clears the held value on both arms; a
        // cancelled `execute` drops the future before either arm runs
        // and keeps the value for the retry above.
        match handle.publish(&address, value.clone()).await {
            Ok(()) => {
                self.pending = None;
                self.out.set(value);
            }
            Err(err) => {
                self.pending = None;
                self.set_state(BlockState::fault(format!("ExternalOut: {err}")));
            }
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod test {
    use std::sync::Arc;
    use std::time::Duration;

    use libhaystack::val::Value;

    use crate::base::block::test_utils::write_block_inputs;
    use crate::base::block::{Block, BlockProps};
    use crate::base::connector::{register_connector, unregister_connector};
    use crate::blocks::external::ExternalOut;
    use crate::blocks::external::support::mock::MockConnector;

    fn unique_name(prefix: &str) -> String {
        format!("{prefix}-{}", uuid::Uuid::new_v4())
    }

    async fn write_all(block: &mut ExternalOut, connector: &str, value: Value) {
        write_block_inputs([
            (&mut block.input, value),
            (&mut block.connector, Value::make_str(connector)),
            (&mut block.address, Value::make_str("topic")),
        ])
        .await;
    }

    #[tokio::test]
    async fn publishes_and_echoes() {
        let name = unique_name("out-flow");
        let mock = Arc::new(MockConnector::default());
        register_connector(&name, mock.clone()).expect("registered");

        let mut block = ExternalOut::new();
        write_all(&mut block, &name, 42.into()).await;
        block.execute().await;

        let published = mock.published.lock().unwrap().clone();
        assert_eq!(published, vec![("topic".to_string(), 42.into())]);
        assert_eq!(block.out.value, 42.into());
        assert!(!block.state().is_fault());

        unregister_connector(&name);
    }

    #[tokio::test]
    async fn missing_connector_faults() {
        let mut block = ExternalOut::new();
        write_all(&mut block, &unique_name("out-missing"), 42.into()).await;
        block.execute().await;
        assert!(block.state().is_fault());
    }

    #[tokio::test]
    async fn publish_error_faults() {
        let name = unique_name("out-pub-err");
        let mock = Arc::new(MockConnector {
            fail_publish: true,
            ..Default::default()
        });
        register_connector(&name, mock.clone()).expect("registered");

        let mut block = ExternalOut::new();
        write_all(&mut block, &name, 42.into()).await;
        block.execute().await;

        assert!(block.state().is_fault());
        assert!(mock.published.lock().unwrap().is_empty());
        assert_eq!(block.out.value, Value::Null, "no echo on failure");

        unregister_connector(&name);
    }

    #[tokio::test]
    async fn config_rewrite_does_not_republish() {
        let name = unique_name("out-rebind");
        let mock = Arc::new(MockConnector::default());
        register_connector(&name, mock.clone()).expect("registered");

        let mut block = ExternalOut::new();
        write_all(&mut block, &name, 42.into()).await;
        block.execute().await;
        assert_eq!(mock.published.lock().unwrap().len(), 1);

        write_block_inputs([(&mut block.address, Value::make_str("other"))]).await;
        block.execute().await;

        assert_eq!(
            mock.published.lock().unwrap().len(),
            1,
            "a config-only pin write does not re-publish the cached input"
        );
        assert!(!block.state().is_fault());

        unregister_connector(&name);
    }

    #[tokio::test]
    async fn cancelled_publish_is_retried() {
        let name = unique_name("out-retry");
        let mock = Arc::new(MockConnector {
            publish_delay_millis: Some(50),
            ..Default::default()
        });
        register_connector(&name, mock.clone()).expect("registered");

        let mut block = ExternalOut::new();
        write_all(&mut block, &name, 42.into()).await;

        // Drop `execute` mid-publish, as the block actor does when a
        // mailbox command arrives.
        {
            let fut = block.execute();
            tokio::pin!(fut);
            tokio::select! {
                _ = &mut fut => panic!("publish should still be in flight"),
                _ = tokio::time::sleep(Duration::from_millis(10)) => {}
            }
        }
        assert!(
            mock.published.lock().unwrap().is_empty(),
            "cancelled publish did not complete"
        );
        assert_eq!(block.out.value, Value::Null);

        block.execute().await;

        assert_eq!(
            mock.published.lock().unwrap().clone(),
            vec![("topic".to_string(), 42.into())],
            "cancelled publish is re-issued without fresh input"
        );
        assert_eq!(block.out.value, 42.into());
        assert!(!block.state().is_fault());

        unregister_connector(&name);
    }
}
