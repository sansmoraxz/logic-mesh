import type {
  BlockDesc,
  BlockNotification,
  BlocksEngine,
  EngineCommand,
} from 'logic-mesh';
import { initEngine } from 'logic-mesh';
import { registerUiConnector } from './UiConnector';
import { widgetBlockDescs } from './Widgets';

let engine: BlocksEngine;
let blocks: BlockDesc[];
let command: EngineCommand;
let connectorCommand: EngineCommand;

export function useEngine() {
  if (!engine) {
    engine = initEngine();
    registerUiConnector();
    blocks = [...engine.listBlocks(), ...widgetBlockDescs];
    command = engine.engineCommand();
    // Dedicated handle for connector attachment. Created here — before
    // `engine.run()` — because once run() is polled its future holds
    // the wasm object's borrow for the engine's whole life, and ANY
    // later `engine.*` call from a promise continuation throws
    // ("recursive use of an object"). All handles feed the same engine
    // queue, so the FIFO barrier in `attachUiConnector` still orders
    // this handle's messages after a Reset sent through `command`.
    connectorCommand = engine.engineCommand();
  }

  function startWatch(callback: (notification: BlockNotification) => void) {
    const watchCommand = engine.engineCommand();
    watchCommand.createWatch(callback);
  }

  return { engine, blocks, command, connectorCommand, startWatch };
}
