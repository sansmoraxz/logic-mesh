import type { Edge, Node } from '@xyflow/svelte';
import type { Program } from 'logic-mesh';
import type { Block } from './Block';
import { useEngine } from './Engine';

const { command } = useEngine();

export function save(ops: {
  name: string;
  desc?: string;
  nodes: Node[];
  edges: Edge[];
}): Program {
  const program: Program = {
    name: ops.name,
    description: ops.desc,
  } as Program;

  ops.nodes.forEach((node) => {
    const blockRef = node.data as { value: Block };
    const data = blockRef.value;
    const { desc } = data;

    program.blocks = program.blocks || {};
    program.blocks[node.id] = {
      name: desc.name,
      lib: desc.lib,
      positions: { x: node.position.x, y: node.position.y },
    };
    if (data.label) {
      program.blocks[node.id].label = data.label;
    }
    if (data.widget) {
      program.blocks[node.id].widget = {
        kind: data.widget.kind,
        config: data.widget.config ? { ...data.widget.config } : undefined,
        configSources:
          data.widget.configSources &&
          Object.keys(data.widget.configSources).length > 0
            ? { ...data.widget.configSources }
            : undefined,
        valueSource: data.widget.valueSource,
      };
    }

    const curProgram = program.blocks[node.id];

    Object.entries(data.inputs).forEach(([name, input]) => {
      if (input.value != null) {
        curProgram.inputs = curProgram.inputs || {};
        curProgram.inputs[name] = {
          value: input.value,
          isConnected: input.isConnected,
        };
      }
    });

    Object.entries(data.outputs).forEach(([name, output]) => {
      if (output.value != null) {
        curProgram.outputs = curProgram.outputs || {};
        curProgram.outputs[name] = { value: output.value };
      }
    });
  });

  ops.edges.forEach((edge) => {
    program.links = program.links || {};
    program.links[
      (edge.data as { id?: string } | undefined)?.id ?? crypto.randomUUID()
    ] = {
      sourceBlockPinName: edge.sourceHandle ?? '',
      targetBlockPinName: edge.targetHandle ?? '',
      sourceBlockUuid: edge.source,
      targetBlockUuid: edge.target,
    };
  });

  return program;
}

type ProgramBlock = NonNullable<Program['blocks']>[string];

// Widget names from the legacy JS-block UI library (lib 'ui'), split by
// data direction: input widgets became ExternalIn, display widgets
// became ExternalOut.
const LEGACY_INPUT_WIDGETS = new Set([
  'Slider',
  'Input',
  'Checkbox',
  'Button',
  'ComboBox',
  'Table',
]);
const LEGACY_DISPLAY_WIDGETS = new Set([
  'Gauge',
  'Chart',
  'MultiChart',
  'Label',
  'Led',
  'Bar',
  'Display',
]);

// Extracts the widget config from a legacy block's config pins.
function legacyConfig(
  name: string,
  block: ProgramBlock,
): Record<string, unknown> | undefined {
  const pin = (p: string) => block.inputs?.[p]?.value;
  const out = block.outputs?.['out']?.value;
  switch (name) {
    case 'Slider':
      return {
        value: out ?? 0,
        min: pin('min') ?? 0,
        max: pin('max') ?? 100,
        step: pin('step') ?? 1,
      };
    case 'Input':
      return { value: out ?? '' };
    case 'Checkbox':
      return { value: out ?? false };
    case 'ComboBox':
      return {
        items: pin('in') ?? '',
        ...(out !== undefined ? { value: out } : {}),
      };
    case 'MultiChart':
      return { series: [{ label: pin('labelA') ?? '' }] };
    case 'Led':
      return { label: pin('label') ?? '', color: pin('color') ?? '#3ecf6b' };
    case 'Bar':
      return {
        min: pin('min') ?? 0,
        max: pin('max') ?? 100,
        label: pin('label') ?? '',
      };
    case 'Display':
      return { unit: pin('unit') ?? '', label: pin('label') ?? '' };
    default:
      return undefined;
  }
}

/**
 * Migrate legacy UI JS-block entries (lib 'ui') in a saved program to
 * the ExternalIn/ExternalOut + widget-metadata shape, in place, so the
 * same program object is valid for both node building and
 * `pushToEngine`. Links into pins that no longer exist are dropped
 * (config pins, extra MultiChart series); the MultiChart 'a' pin is
 * retargeted to 'in'.
 */
function migrateLegacyUiBlocks(program: Program) {
  if (!program.blocks) return;

  const migrated = new Map<string, 'in' | 'out'>();
  for (const [uuid, block] of Object.entries(program.blocks)) {
    if (block.lib !== 'ui' || block.widget) continue;
    const name = block.name ?? '';
    const direction = LEGACY_INPUT_WIDGETS.has(name)
      ? 'in'
      : LEGACY_DISPLAY_WIDGETS.has(name)
        ? 'out'
        : undefined;
    if (!direction) continue;
    migrated.set(uuid, direction);

    const config = legacyConfig(name, block);
    // The display widget's value pin; MultiChart's first series was 'a'.
    const inPin =
      direction === 'out'
        ? (block.inputs?.[name === 'MultiChart' ? 'a' : 'in'] ?? undefined)
        : undefined;
    const outPin = direction === 'in' ? block.outputs?.['out'] : undefined;

    block.widget = { kind: name, config };
    block.name = direction === 'in' ? 'ExternalIn' : 'ExternalOut';
    block.lib = 'core';
    const inputs: NonNullable<ProgramBlock['inputs']> = {
      connector: { value: 'ui', isConnected: false },
      address: { value: uuid, isConnected: false },
    };
    if (inPin) {
      inputs['in'] = {
        ...(inPin.value != null ? { value: inPin.value } : {}),
        isConnected: inPin.isConnected ?? false,
      };
    }
    block.inputs = inputs;
    block.outputs =
      outPin && outPin.value != null
        ? { out: { value: outPin.value } }
        : undefined;
  }

  if (!migrated.size || !program.links) return;

  for (const [linkId, link] of Object.entries(program.links)) {
    let drop = false;

    const targetDir = migrated.get(link.targetBlockUuid);
    if (targetDir === 'in') {
      // ExternalIn has no linkable input pins.
      drop = true;
    } else if (targetDir === 'out') {
      if (link.targetBlockPinName === 'a') link.targetBlockPinName = 'in';
      if (link.targetBlockPinName !== 'in') drop = true;
    }

    // The only surviving source pin on a migrated block is 'out'.
    if (migrated.has(link.sourceBlockUuid) && link.sourceBlockPinName !== 'out')
      drop = true;

    if (drop) delete program.links[linkId];
  }
}

/**
 * Build the UI node/edge structures from program data, synchronously.
 *
 * Done as a separate step from `pushToEngine` so the caller can register
 * the resulting blocks (e.g., into a `blockInstances` map keyed by id)
 * BEFORE any wasm engine commands fire. Otherwise the first
 * change-of-value notifications from the engine — which arrive while the
 * engine is still processing the load — get dropped because the watcher
 * callback can't find the block id yet.
 *
 * Migrates legacy UI JS-block programs in place first, so the same
 * (migrated) object is what later reaches `pushToEngine`.
 */
export function prepare(program: Program): { nodes: Node[]; edges: Edge[] } {
  migrateLegacyUiBlocks(program);
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  for (const blockUuid in program.blocks) {
    const block = program.blocks[blockUuid];
    nodes.push({
      id: blockUuid,
      type: 'custom',
      position: { x: block.positions?.x ?? 0, y: block.positions?.y ?? 0 },
      data: {
        name: block.name ?? '',
        lib: block.lib ?? '',
        label: block.label ?? '',
        widget: block.widget,
        inputs: block.inputs ?? {},
        outputs: block.outputs ?? {},
      },
    });
  }

  for (const linkId in program.links) {
    const link = program.links[linkId];
    edges.push({
      id: linkId,
      source: link.sourceBlockUuid,
      target: link.targetBlockUuid,
      sourceHandle: link.sourceBlockPinName,
      targetHandle: link.targetBlockPinName,
    });
  }

  return { nodes, edges };
}

/**
 * Push the program into the wasm engine in a single atomic call.
 *
 * The Rust engine accepts a full `Program` (blocks + links + pin values
 * + UI metadata) via `loadProgram` and handles scheduling, wiring, and
 * value writes internally — no JS-side `addBlock` / `createLink` /
 * `writeBlockInput` chain. Call AFTER `prepare()` + registering the
 * block instances so change-of-value notifications fired during the
 * load have a registered destination.
 */
export async function pushToEngine(program: Program): Promise<void> {
  await command.loadProgram(program);
}

/**
 * Convenience wrapper: `prepare` + `pushToEngine`. Used by callers that
 * don't need the prepare/register/push split — but if you have a
 * `blockInstances` map keyed by id and you care about not losing the
 * first round of COV notifications, call `prepare` and `pushToEngine`
 * separately and register your instances between them.
 */
export async function load(
  program: Program,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const { nodes, edges } = prepare(program);
  await pushToEngine(program);
  return { nodes, edges };
}
