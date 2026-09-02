import type { BlockDesc, BlockNotification, EngineSession } from 'logic-mesh';
import { createEngineSession } from 'logic-mesh';
import { registerUiConnector } from './UiConnector';
import { widgetBlockDescs } from './Widgets';

let session: EngineSession;
let blocks: BlockDesc[];

export function useEngine() {
  if (!session) {
    // The session pre-creates every command handle — the general one,
    // the dedicated connector-attach handle, and the watch slot —
    // before the engine can run, which is the only time handles can be
    // created (see the EngineSession docs in the logic-mesh package
    // for the wasm borrow trap the ordering avoids). The engine itself
    // is started later, from the page's onMount, via `start()`.
    session = createEngineSession();
    registerUiConnector();
    blocks = [...session.engine.listBlocks(), ...widgetBlockDescs];
  }

  function startWatch(callback: (notification: BlockNotification) => void) {
    session.watch(callback);
  }

  // Kicks off the engine's message loop, un-awaited — the session owns
  // the ordering rules and marks itself started, so a later startWatch
  // draws from the pre-created watch slots instead of touching the
  // (now off-limits) engine object.
  function start() {
    session.start();
  }

  return {
    start,
    blocks,
    command: session.command,
    connectorCommand: session.connectorCommand,
    startWatch,
  };
}
