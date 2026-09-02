import type { JsConnector } from './index';
import type { EngineCommand } from './logic_mesh.js';
import {
  connectorRegistered,
  registerConnector,
  unregisterConnector,
} from './logic_mesh.js';

/**
 * A function exposed as a block through {@link defineJsBlocks}.
 *
 * Receives the block's `in` value and returns the block's `out` value,
 * either directly or via a Promise. A thrown exception or a rejected
 * Promise faults the block (with the error message as the fault
 * reason); a hung Promise is bounded by the block's own `timeout` pin,
 * which faults the block with a timeout error — there is no separate
 * timeout to configure here.
 *
 * Values cross the wasm boundary in the Haystack JSON encoding:
 * numbers, strings, booleans, arrays, and plain objects round-trip,
 * with measured exceptions. A `null` (or `undefined`) inside a dict or
 * array keeps its key or slot but arrives as `undefined` on the JS
 * side, in both directions — `{x: null, z: [null]}` becomes
 * `{x: undefined, z: [undefined]}`. A `BigInt` in the safe integer
 * range silently coerces to `Number`; one outside it faults the block
 * ("can't be represented as a JavaScript number") before the function
 * is called. Engine-side dicts arrive as JS `Map`s from the bridge;
 * the façade converts them (recursively) to plain objects before the
 * function sees them, so a multi-input block is simply a function
 * taking an object: feed the `in` pin a dict value and read named
 * fields off the argument. A returned `undefined` is coerced to
 * `null` rather than faulting the block.
 */
export type JsBlockFn = (value: unknown) => unknown | Promise<unknown>;

/** Options for {@link defineJsBlocks}. */
export interface JsBlocksOptions {
  /**
   * The name the connector is registered and attached under, and the
   * value of every materialized block's `connector` pin. Must be
   * unique per registry (i.e. per process). Defaults to `'js'`.
   */
  name?: string;
}

/**
 * Recursively converts the wasm bridge's value encoding into plain JS:
 * dicts arrive as `Map`s (nested ones too) and become objects; array
 * elements are converted in place; everything else passes through.
 */
function fromEngineValue(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [key, entry] of value) {
      obj[String(key)] = fromEngineValue(entry);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map(fromEngineValue);
  }
  return value;
}

/** The attach-time error for a connector name owned by someone else. */
function nameInUseMessage(name: string): string {
  return (
    `A different connector is already registered under '${name}' — ` +
    'pick another name, or unregister the existing one first.'
  );
}

/**
 * Block-like ergonomics for JS-implemented logic, without a new engine
 * API: the functions are exposed through one {@link JsConnector} —
 * request/response only — and materialize in the graph as `Request`
 * blocks whose `address` pin selects the function. The engine sees
 * nothing but a connector.
 *
 * Created by {@link defineJsBlocks}. The lifecycle is the connector
 * lifecycle: {@link attach} registers the connector and hands it to
 * the running engine (which starts it and manages it from then on),
 * {@link detach} reverses that, and an engine reset detaches every
 * managed connector — re-{@link attach} afterwards, exactly as with a
 * hand-written connector.
 *
 * Deliberately request-shaped: value *streams* (an `ExternalIn`
 * source) don't fit the one-value-in/one-value-out function signature,
 * so the façade does not bend it — implement a raw {@link JsConnector}
 * with a `subscribe` method for those, and bind an `ExternalIn` block
 * to it by name and address. Fire-and-forget *sinks* do fit: the
 * connector's `publish` dispatches to the same function map (return
 * value discarded), so an `ExternalOut` block bound to this connector
 * name and a function name works without extra API.
 */
export class JsBlocks<T extends Record<string, JsBlockFn>> {
  /** The connector name — see {@link JsBlocksOptions.name}. */
  readonly name: string;

  private readonly functions: T;
  private readonly connector: JsConnector;

  /**
   * Whether this instance owns the current registry entry for
   * {@link name}. Lets a re-attach distinguish our own leftover
   * registration (fine to reuse) from a foreign connector squatting on
   * the name (an error to silently hijack).
   */
  private registered = false;

  constructor(functions: T, options: JsBlocksOptions = {}) {
    this.name = options.name ?? 'js';
    this.functions = functions;

    const lookup = (address: string): JsBlockFn => {
      const fn = this.functions[address];
      if (typeof fn !== 'function') {
        throw new Error(
          `'${this.name}' has no function named '${address}' ` +
            `(available: ${Object.keys(this.functions).join(', ')})`,
        );
      }
      return fn;
    };

    this.connector = {
      subscribe: (address: string) => {
        throw new Error(
          `'${this.name}' exposes plain functions and has no value ` +
            `streams to subscribe to (address '${address}'). For a ` +
            'streaming source, implement a JsConnector with a subscribe ' +
            'method and bind an ExternalIn block to it.',
        );
      },
      // Sink direction: an ExternalOut bound to this connector invokes
      // the addressed function and discards its result. Exceptions and
      // rejections fault the ExternalOut block as publish failures.
      publish: async (address: string, value: unknown) => {
        await lookup(address)(fromEngineValue(value));
      },
      // Request direction: the addressed function's result becomes the
      // Request block's `out` value.
      request: async (address: string, value: unknown) => {
        const result = await lookup(address)(fromEngineValue(value));
        // `undefined` has no Haystack encoding and would fault the
        // block on the way back; a function that returns nothing means
        // "no result", which Null carries.
        return result === undefined ? null : result;
      },
    };
  }

  /**
   * Registers the connector and attaches it to the running engine
   * (`addConnector`), which starts it and manages its lifecycle from
   * then on. Idempotent: the initial `listConnectors` reply is a FIFO
   * barrier — it proves the engine has processed everything queued
   * before it, a pending reset included — and an already-attached
   * connector is left alone.
   *
   * `command` must be a handle created before `engine.run()` (any
   * {@link EngineSession} handle qualifies), and — like every engine
   * request — this only resolves while the engine runs unpaused.
   *
   * Throws if the name is taken by a connector this instance does not
   * own — registered by someone else, attached or not.
   */
  async attach(command: EngineCommand): Promise<void> {
    const attached = await command.listConnectors();
    if (attached.includes(this.name)) {
      // Only our own attachment is an idempotent success: a foreign
      // connector on the name would otherwise silently answer this
      // instance's blocks with someone else's functions.
      if (this.registered) return;
      throw new Error(nameInUseMessage(this.name));
    }

    if (!connectorRegistered(this.name)) {
      registerConnector(this.name, this.connector);
      this.registered = true;
    } else if (!this.registered) {
      throw new Error(nameInUseMessage(this.name));
    }
    await command.addConnector(this.name);
  }

  /**
   * Detaches the connector from the engine (`removeConnector` — the
   * engine stops it and unregisters it), or, when it was registered
   * but never attached, just unregisters it. Acts only on an
   * attachment this instance owns: a no-op when this instance never
   * registered the name (a foreign same-name connector is left alone)
   * and when there is nothing left to tear down — so calling it after
   * an engine reset (which already detached everything) is safe.
   */
  async detach(command: EngineCommand): Promise<void> {
    if (!this.registered) return;
    const attached = await command.listConnectors();
    if (attached.includes(this.name)) {
      await command.removeConnector(this.name);
    } else if (connectorRegistered(this.name)) {
      unregisterConnector(this.name);
    }
    this.registered = false;
  }

  /**
   * Materializes function `fn` as a block: adds a `Request` block
   * (under `blockUuid` when given) and wires its `connector` and
   * `address` pins to this connector and the function name. Returns
   * the block's UUID.
   *
   * Write the argument to the block's `in` pin — or link another
   * block's output to it — and the function's result appears on `out`.
   * The block's `timeout` pin (milliseconds) bounds a hung function.
   */
  async addBlock(
    command: EngineCommand,
    fn: Extract<keyof T, string>,
    blockUuid?: string,
  ): Promise<string> {
    if (typeof this.functions[fn] !== 'function') {
      throw new Error(
        `'${this.name}' has no function named '${fn}' ` +
          `(available: ${Object.keys(this.functions).join(', ')})`,
      );
    }
    const id = await command.addBlock('Request', blockUuid);
    await command.writeBlockInput(id, 'connector', this.name);
    await command.writeBlockInput(id, 'address', fn);
    return id;
  }
}

/**
 * Defines a set of JS functions to be exposed as blocks — see
 * {@link JsBlocks} for the mechanics and limits.
 *
 * ```ts
 * const jsBlocks = defineJsBlocks(
 *   {
 *     scale: (value) => (value as number) * 2,
 *     fetchTemp: async (zone) => readSensor(zone as string), // async is fine
 *   },
 *   { name: 'js' },
 * );
 *
 * const { command } = startEngine();
 * await jsBlocks.attach(command);
 *
 * const id = await jsBlocks.addBlock(command, 'scale');
 * await command.writeBlockInput(id, 'in', 21); // out becomes 42
 * ```
 */
export function defineJsBlocks<T extends Record<string, JsBlockFn>>(
  functions: T,
  options: JsBlocksOptions = {},
): JsBlocks<T> {
  return new JsBlocks(functions, options);
}
