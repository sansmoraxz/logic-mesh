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

use crate::{blocks::InputImpl, blocks::OutputImpl};

/// Publishes the block's input value to an external system.
///
/// Resolves the [`Connector`](crate::base::connector::Connector)
/// registered under the name on the `connector` pin and publishes each
/// `in` value to the address on the `address` pin. The published value
/// is echoed on `out` so downstream blocks can chain off a successful
/// publish; the block faults when the connector is missing or the
/// publish fails.
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
}

impl Block for ExternalOut {
    async fn execute(&mut self) {
        self.read_inputs_until_ready().await;

        let (Some(connector), Some(address)) =
            (input_as_str(&self.connector), input_as_str(&self.address))
        else {
            return;
        };

        let Some(value) = self.input.get_value().cloned() else {
            return;
        };
        if matches!(value, Value::Null) {
            return;
        }

        let Some(handle) = get_connector(&connector) else {
            self.set_state(BlockState::fault(format!(
                "ExternalOut: no connector named '{connector}'"
            )));
            return;
        };

        match handle.publish(&address, value.clone()).await {
            Ok(()) => self.out.set(value),
            Err(err) => {
                self.set_state(BlockState::fault(format!("ExternalOut: {err}")));
            }
        }
    }
}

#[cfg(test)]
mod test {
    use std::sync::Arc;

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
}
