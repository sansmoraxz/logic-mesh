import type { BlockDesc, BlockPin } from 'logic-mesh';

/**
 * UI widget identity carried by ExternalIn/ExternalOut blocks that
 * were placed as widgets. `kind` picks the component; `config` holds
 * widget-local settings (min/max/label/...).
 */
export interface Widget {
  kind: string;
  config?: Record<string, unknown>;
  /**
   * Config key → address of a plain ExternalOut block. Values the
   * engine publishes to that address override the literal `config`
   * value for the key at runtime.
   */
  configSources?: Record<string, string>;
  /**
   * Address of a plain ExternalOut block whose published values an
   * input widget tracks as feedback. User interaction still pushes
   * through the widget's own address and wins while interacting.
   */
  valueSource?: string;
}

/**
 * A block instance.
 */
export interface Block {
  id: string;
  desc: BlockDesc;
  /** Widget identity, present only on widget-backed external blocks. */
  widget?: Widget;
  /** Optional user label shown next to the block-type name. */
  label: string;
  inputs: { [key: string]: BlockPin };
  outputs: { [key: string]: BlockPin };
  /** Operational state from the engine. Drives fault-ring rendering. */
  state: 'running' | 'fault' | 'disabled' | 'terminated';
  /** Reason associated with `state === 'fault'`, if any. */
  faultReason?: string;
}

/**
 * Create a block instance from a block description.
 */
export function blockInstance(id: string, desc: BlockDesc): Block {
  function toObj(pins: BlockPin[]) {
    return pins.reduce(
      (acc, pin) => {
        acc[pin.name] = { ...pin, value: undefined, isConnected: false };
        return acc;
      },
      {} as { [key: string]: BlockPin },
    );
  }

  return {
    id,
    desc,
    label: '',
    inputs: toObj(desc.inputs),
    outputs: toObj(desc.outputs),
    state: 'running',
    faultReason: undefined,
  };
}
