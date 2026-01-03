export type MetricLabels = Record<string, string>;

export type Metrics = {
  incCounter: (name: string, labels?: MetricLabels, value?: number) => void;
  observeHistogram: (name: string, value: number, labels?: MetricLabels) => void;
  setGauge: (name: string, value: number, labels?: MetricLabels) => void;
  render: () => string;
};

type CounterEntry = { labels: MetricLabels; value: number };

type HistogramEntry = {
  labels: MetricLabels;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
};

type GaugeEntry = { labels: MetricLabels; value: number };

const HISTOGRAM_BUCKETS: Record<string, number[]> = {
  eval_score_histogram: [0.25, 0.5, 0.75, 0.9, 1],
  wait_time_ms_histogram: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 60000],
};

export class InMemoryMetrics implements Metrics {
  private counters = new Map<string, CounterEntry>();
  private histograms = new Map<string, HistogramEntry>();
  private gauges = new Map<string, GaugeEntry>();

  incCounter(name: string, labels: MetricLabels = {}, value = 1): void {
    const key = keyFor(name, labels);
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += value;
      return;
    }
    this.counters.set(key, { labels, value });
  }

  observeHistogram(name: string, value: number, labels: MetricLabels = {}): void {
    const key = keyFor(name, labels);
    const buckets = HISTOGRAM_BUCKETS[name] ?? [1, 5, 10, 50, 100, 500, 1000];
    let entry = this.histograms.get(key);
    if (!entry) {
      entry = {
        labels,
        buckets,
        counts: new Array(buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.histograms.set(key, entry);
    }

    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < buckets.length; i += 1) {
      if (value <= buckets[i]) {
        entry.counts[i] += 1;
      }
    }
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    const key = keyFor(name, labels);
    this.gauges.set(key, { labels, value });
  }

  render(): string {
    const lines: string[] = [];

    for (const [key, entry] of this.counters) {
      const { name, labels } = parseKey(key);
      lines.push(`${name}${formatLabels(labels)} ${entry.value}`);
    }

    for (const [key, entry] of this.gauges) {
      const { name, labels } = parseKey(key);
      lines.push(`${name}${formatLabels(labels)} ${entry.value}`);
    }

    for (const [key, entry] of this.histograms) {
      const { name, labels } = parseKey(key);
      const bucketCounts = entry.counts;
      for (let i = 0; i < entry.buckets.length; i += 1) {
        const bucketLabels = { ...labels, le: entry.buckets[i].toString() };
        lines.push(
          `${name}_bucket${formatLabels(bucketLabels)} ${bucketCounts[i]}`
        );
      }
      lines.push(
        `${name}_sum${formatLabels(labels)} ${entry.sum}`
      );
      lines.push(
        `${name}_count${formatLabels(labels)} ${entry.count}`
      );
    }

    return lines.join('\n') + '\n';
  }
}

function keyFor(name: string, labels: MetricLabels): string {
  const entries = Object.entries(labels)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return `${name}|${entries}`;
}

function parseKey(key: string): { name: string; labels: MetricLabels } {
  const [name, encoded] = key.split('|');
  if (!encoded) return { name, labels: {} };
  const labels: MetricLabels = {};
  for (const pair of encoded.split(',')) {
    const [labelKey, labelValue] = pair.split('=');
    if (labelKey) labels[labelKey] = labelValue ?? '';
  }
  return { name, labels };
}

function formatLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const formatted = entries
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  return `{${formatted}}`;
}
