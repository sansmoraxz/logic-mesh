<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import { onMount, onDestroy } from 'svelte';
  import Chart from 'chart.js/auto';
  import BlockCommons from '../BlockCommons.svelte';
  import type { Block } from '$lib/Block';
  import { onValue } from '$lib/UiConnector';
  import { useWidgetConfig } from '$lib/WidgetConfig.svelte';
  import { numericValue } from '$lib/utils';

  interface Props {
    data: { value: Block };
  }

  let { data }: Props = $props();

  const block = $derived(data.value);
  const widgetConfig = useWidgetConfig(() => block.widget);
  const config = $derived(widgetConfig.config);
  const chartId = `multichart-${crypto.randomUUID()}`;

  const MAX_POINTS = 60;
  const COLORS = ['#6b9eff', '#f59e0b', '#3ecf6b', '#ef4444'];

  type SeriesDef = { label: string; address?: string };

  // Series 0 is this node's own ExternalOut 'in'; additional series
  // subscribe to other ExternalOut blocks' addresses. Structurally
  // memoized: a new config identity (e.g. a driven configSources key)
  // must not rebuild datasets or churn subscriptions when the series
  // themselves are unchanged.
  let prevDefs: SeriesDef[] = [];
  function memoDefs(defs: SeriesDef[]): SeriesDef[] {
    if (
      defs.length === prevDefs.length &&
      defs.every(
        (d, i) =>
          d.label === prevDefs[i].label && d.address === prevDefs[i].address,
      )
    ) {
      return prevDefs;
    }
    prevDefs = defs;
    return defs;
  }
  const seriesDefs = $derived.by((): SeriesDef[] => {
    const raw = config.series;
    if (Array.isArray(raw) && raw.length > 0) {
      return memoDefs(
        raw.map((s, i) => {
          const o = (s ?? {}) as Record<string, unknown>;
          return {
            label:
              o.label != null && String(o.label).length > 0
                ? String(o.label)
                : `series ${i + 1}`,
            address:
              typeof o.address === 'string' && o.address
                ? o.address
                : undefined,
          };
        }),
      );
    }
    // Legacy single-series config shape ({ label }).
    const label = config.label;
    return memoDefs([
      {
        label:
          label != null && String(label).length > 0 ? String(label) : 'series',
      },
    ]);
  });

  let chart: Chart | undefined;
  const xAxis: number[] = [];
  let dataArrays: number[][] = [];
  let latest: (number | undefined)[] = [];
  let count = 0;
  let sampleQueued = false;

  function ensureSeries(n: number) {
    if (dataArrays.length === n) return;
    dataArrays = Array.from({ length: n }, () => []);
    latest = new Array(n).fill(undefined);
    xAxis.length = 0;
    count = 0;
  }

  function syncDatasets(defs: SeriesDef[]) {
    if (!chart) return;
    ensureSeries(defs.length);
    chart.data.labels = xAxis;
    chart.data.datasets = defs.map((s, i) => ({
      label: s.label,
      data: dataArrays[i],
      borderColor: COLORS[i % COLORS.length],
      backgroundColor: COLORS[i % COLORS.length],
      fill: false,
      tension: 0.3,
      borderWidth: 1.5,
    }));
    chart.update('none');
  }

  // Batches same-cycle updates across series into a single sample row.
  function queueSample() {
    if (sampleQueued) return;
    sampleQueued = true;
    queueMicrotask(() => {
      sampleQueued = false;
      if (!chart) return;
      xAxis.push(count++);
      if (xAxis.length > MAX_POINTS) xAxis.shift();
      for (let i = 0; i < dataArrays.length; i++) {
        dataArrays[i].push(latest[i] ?? NaN);
        if (dataArrays[i].length > MAX_POINTS) dataArrays[i].shift();
      }
      chart.update('none');
    });
  }

  function buildChart() {
    const ctx = document.getElementById(chartId) as HTMLCanvasElement | null;
    if (!ctx) return;
    chart = new Chart(ctx, {
      type: 'line',
      data: { labels: xAxis, datasets: [] },
      options: {
        animation: false,
        responsive: false,
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: { boxWidth: 10, font: { size: 10 } },
          },
        },
        elements: { point: { radius: 0 } },
        scales: {
          x: { display: false },
          y: { ticks: { font: { size: 9 } } },
        },
      },
    });
    syncDatasets(seriesDefs);
  }

  onMount(() => {
    buildChart();
  });

  onDestroy(() => {
    chart?.destroy();
  });

  // Keep datasets in sync with the configured series.
  $effect(() => {
    syncDatasets(seriesDefs);
  });

  $effect(() => {
    const defs = seriesDefs;
    ensureSeries(defs.length);
    const unsubs = defs.map((s, i) => {
      const address = s.address ?? (i === 0 ? block.id : undefined);
      if (!address) return undefined;
      return onValue(address, (value) => {
        const num = numericValue(value);
        latest[i] = num == null ? NaN : num;
        queueSample();
      });
    });
    return () => {
      for (const unsub of unsubs) unsub?.();
    };
  });
</script>

<BlockCommons data={block}>
  <div class="multichart-body">
    <div class="pin-row">
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        class="handle-dot handle-input"
      />
      <span class="pin-name">in</span>
    </div>

    <canvas id={chartId} width="240" height="140"></canvas>
  </div>
</BlockCommons>

<style>
  .multichart-body {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 4px 8px;
    position: relative;
  }

  .pin-row {
    display: flex;
    align-items: center;
    padding: 1px 8px;
    gap: 6px;
    min-height: 18px;
    position: relative;
  }

  .pin-name {
    font-size: 11px;
    font-weight: 600;
  }

  :global(.handle-dot) {
    width: 8px !important;
    height: 8px !important;
    border-radius: 50% !important;
    min-width: 0 !important;
    border: 1.5px solid white !important;
  }
  :global(.handle-input) {
    background: #6b9eff !important;
  }
</style>
