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

export function useEngine() {
  if (!engine) {
    engine = initEngine();
    registerUiConnector(engine);
    blocks = [...engine.listBlocks(), ...widgetBlockDescs];
    command = engine.engineCommand();
  }

  function startWatch(callback: (notification: BlockNotification) => void) {
    const watchCommand = engine.engineCommand();
    watchCommand.createWatch(callback);
  }

  return { engine, blocks, command, startWatch };
}
