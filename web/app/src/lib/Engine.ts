import type { BlockDesc, BlockNotification, EngineSession } from 'logic-mesh';
import { createEngineSession } from 'logic-mesh';
import { registerUiConnector } from './UiConnector';
import { widgetBlockDescs } from './Widgets';

let session: EngineSession;
let blocks: BlockDesc[];

export function useEngine() {
  if (!session) {
    // The session pre-creates every command handle — the general one,
    // the dedicated connector-attach handle, and the watch slots —
    // before the engine can run, which is the only time handles can be
    // created (see the EngineSession docs in the logic-mesh package
    // for the wasm borrow trap the ordering avoids). The engine itself
    // is started later, from the page's onMount, via `start()`.
    // Two watch slots: the page's onMount consumes one, and a dev-time
    // HMR remount re-runs onMount against this same module-level
    // session, consuming another — one slot would make the remount
    // throw.
    session = createEngineSession({ watchSlots: 2 });
    registerUiConnector();
    blocks = [...session.engine.listBlocks(), ...widgetBlockDescs];
  }

  function startWatch(callback: (notification: BlockNotification) => void) {
    try {
      session.watch(callback);
    } catch (err) {
      // Running out of pre-created watch slots is a dev-ergonomics
      // condition, not a load-bearing failure: repeated HMR remounts
      // re-running onMount are the likely cause, and the earlier
      // watches keep delivering notifications. Warn instead of letting
      // onMount throw.
      console.warn(
        'Engine: no watch slot left (HMR remounts re-running onMount are the likely cause); keeping the existing watches:',
        err,
      );
    }
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
