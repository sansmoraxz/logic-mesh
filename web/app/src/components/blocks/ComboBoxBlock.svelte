<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import { onMount } from 'svelte';
  import * as Select from '$lib/components/ui/select';
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { Plus } from 'lucide-svelte';
  import BlockCommons from '../BlockCommons.svelte';
  import type { Block } from '$lib/Block';
  import { pushValue } from '$lib/UiConnector';

  interface Props {
    data: { value: Block };
  }

  let { data }: Props = $props();

  const block = $derived(data.value);
  const config = $derived(block.widget?.config ?? {});

  let customEntry = $state('');
  let showCustomInput = $state(false);

  // Items from the CSV config (custom entries are persisted into it)
  const items = $derived(
    String(config.items ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const selected = $derived(
    config.value != null ? String(config.value) : undefined,
  );

  onMount(() => {
    if (config.value != null) {
      pushValue(block.id, config.value);
    }
  });

  function onSelect(value: string | undefined) {
    if (value != null) {
      if (block.widget) {
        block.widget.config = { ...config, value };
      }
      pushValue(block.id, value);
    }
  }

  function addCustomItem() {
    const val = customEntry.trim();
    if (val) {
      if (!items.includes(val) && block.widget) {
        // Persist the custom entry into the widget config so it
        // survives save/copy.
        block.widget.config = {
          ...config,
          items: [...items, val].join(','),
        };
      }
      onSelect(val);
    }
    customEntry = '';
    showCustomInput = false;
  }

  function onCustomKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCustomItem();
    } else if (e.key === 'Escape') {
      showCustomInput = false;
      customEntry = '';
    }
  }
</script>

<BlockCommons data={block}>
  <div class="ui-block-body">
    <div class="combo-container">
      <Select.Root type="single" value={selected} onValueChange={onSelect}>
        <Select.Trigger class="h-7 w-32 text-xs">
          {selected ?? 'Select...'}
        </Select.Trigger>
        <Select.Content>
          {#each items as item (item)}
            <Select.Item value={item} label={item} />
          {/each}
        </Select.Content>
      </Select.Root>

      {#if showCustomInput}
        <div class="custom-entry">
          <Input
            bind:value={customEntry}
            onkeydown={onCustomKeydown}
            placeholder="New item..."
            class="h-6 w-24 text-xs"
          />
          <Button
            variant="ghost"
            size="icon"
            class="h-6 w-6"
            onclick={addCustomItem}
          >
            <Plus class="h-3 w-3" />
          </Button>
        </div>
      {:else}
        <Button
          variant="ghost"
          size="icon"
          class="h-6 w-6"
          onclick={() => (showCustomInput = true)}
          aria-label="Add custom item"
        >
          <Plus class="h-3 w-3" />
        </Button>
      {/if}
    </div>

    <Handle
      id="out"
      type="source"
      position={Position.Right}
      class="handle-dot handle-output"
    />
  </div>
</BlockCommons>

<style>
  .ui-block-body {
    display: flex;
    align-items: center;
    padding: 6px 10px;
    position: relative;
  }

  .combo-container {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .custom-entry {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  :global(.handle-dot) {
    width: 8px !important;
    height: 8px !important;
    border-radius: 50% !important;
    min-width: 0 !important;
    border: 1.5px solid white !important;
  }
  :global(.handle-output) {
    background: #6bcf7f !important;
  }
</style>
