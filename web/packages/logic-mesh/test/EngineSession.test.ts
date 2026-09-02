// These tests run against the real wasm engine in Node: the vitest
// alias maps the sources' `./logic_mesh.js` import onto the built
// module in `dist/` (build first with `npm run build:dev`). Each test
// creates its own engine; sessions are stopped afterwards so no engine
// loop outlives its test.
import { afterEach, describe, expect, it } from 'vitest';
import type { BlockNotification, EngineSession } from '../src/index';
import { createEngineSession, initEngine, startEngine } from '../src/index';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sessions: EngineSession[] = [];

function track(session: EngineSession): EngineSession {
  sessions.push(session);
  return session;
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
});

/** Polls `get` until it returns a value, or fails after `timeoutMs`. */
async function until<T>(
  get: () => T | undefined,
  what: string,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('startEngine', () => {
  it('returns handles that keep working after run() has been polled', async () => {
    const session = track(startEngine({ sleepDuration: 10 }));

    // Two settled microtask hops guarantee run()'s future has been
    // polled — from here on the engine object's wasm borrow is held.
    await Promise.resolve();
    await Promise.resolve();

    // The exact failure the wrapper prevents: minting a handle now
    // trips the wasm borrow guard...
    expect(() => session.engine.engineCommand()).toThrow(/recursive use/);

    // ...while the session's pre-created handles resolve normally.
    const id = await session.command.addBlock('SineWave');
    expect(id).toMatch(UUID_RE);
    expect(await session.connectorCommand.listConnectors()).toEqual([]);
  });

  it('createCommand after start throws a descriptive error, not the wasm one', () => {
    const session = track(startEngine({ sleepDuration: 10 }));
    expect(() => session.createCommand()).toThrow(/before start\(\)/);
  });

  it('delivers block notifications through a pre-created watch slot', async () => {
    const session = track(startEngine({ sleepDuration: 10 }));
    await Promise.resolve();
    await Promise.resolve();

    const notes: BlockNotification[] = [];
    session.watch((n) => notes.push(n));

    const id = await session.command.addBlock('SineWave');
    const note = await until(
      () => notes.find((n) => n.id === id),
      'a SineWave notification',
    );
    expect(note.state).toBe('running');
  });

  it('watch throws once the pre-created slots are used up', () => {
    const session = track(startEngine({ sleepDuration: 10, watchSlots: 1 }));
    session.watch(() => {});
    expect(() => session.watch(() => {})).toThrow(/watchSlots/);
  });
});

describe('createEngineSession', () => {
  it('defers start; handles minted before start work after it', async () => {
    const session = track(createEngineSession({ sleepDuration: 10 }));
    expect(session.started).toBe(false);

    // Pre-start setup on the engine object is still allowed.
    expect(session.engine.listBlocks().length).toBeGreaterThan(0);
    const extra = session.createCommand();

    session.start();
    expect(session.started).toBe(true);

    const id = await extra.addBlock('SineWave');
    expect(id).toMatch(UUID_RE);
  });
});

describe('EngineSession.stop', () => {
  it("resolves run()'s future and is idempotent", async () => {
    const session = startEngine({ sleepDuration: 10 });
    const id = await session.command.addBlock('SineWave');
    expect(id).toMatch(UUID_RE);

    await session.stop();
    // A second stop must not hang on the already-dead message loop.
    await session.stop();
  });

  it('is a no-op on a session that was never started', async () => {
    const session = createEngineSession({ sleepDuration: 10 });
    await session.stop();
    expect(session.started).toBe(false);
  });
});

describe('EngineSession lifecycle edges', () => {
  it('start() is idempotent', async () => {
    const session = track(createEngineSession({ sleepDuration: 10 }));
    session.start();
    // A second start() must be a no-op, not a second run() — that
    // would trip the engine object's wasm borrow guard.
    session.start();
    const id = await session.command.addBlock('SineWave');
    expect(id).toMatch(UUID_RE);
  });

  it('adopts a caller-created engine that has not run yet', async () => {
    const engine = initEngine(10);
    const session = track(startEngine({ engine }));
    expect(session.engine).toBe(engine);
    const id = await session.command.addBlock('SineWave');
    expect(id).toMatch(UUID_RE);
  });

  it('serializes a same-tick reset() and stop() on the control handle', async () => {
    const session = track(startEngine({ sleepDuration: 10 }));
    await session.command.addBlock('SineWave');
    // Overlapping calls on one handle crash the whole process (an
    // uncaught throw inside the wasm poll), so the control chain must
    // run these strictly one after the other: reset first, then stop.
    const reset = session.reset();
    const stop = session.stop();
    await Promise.all([reset, stop]);
    expect(session.started).toBe(true);
  });

  it('start() after stop() throws instead of arming a dead session', async () => {
    const session = track(startEngine({ sleepDuration: 10 }));
    await session.stop();
    // Without the guard the session would look started while every
    // command hangs forever against the ended message loop.
    expect(() => session.start()).toThrow(/after stop\(\)/);
  });

  it('reset() after stop() throws instead of silently no-opping', async () => {
    const session = track(startEngine({ sleepDuration: 10 }));
    await session.stop();
    expect(() => session.reset()).toThrow(/after stop\(\)/);
  });
});
