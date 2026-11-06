export type Labels = Record<string, string>;

/**
 * In-process counters in the Prometheus text format. Each process counts its own work and
 * Prometheus sums across instances, so nothing here needs to be shared.
 */
export class Counters {
  private readonly values = new Map<string, { name: string; labels: Labels; value: number }>();

  inc(name: string, labels: Labels = {}): void {
    const key = `${name}${renderLabels(labels)}`;
    const entry = this.values.get(key) ?? { name, labels, value: 0 };
    entry.value += 1;
    this.values.set(key, entry);
  }

  render(): string[] {
    const lines: string[] = [];
    const declared = new Set<string>();
    for (const { name, labels, value } of this.values.values()) {
      if (!declared.has(name)) {
        lines.push(`# TYPE ${name} counter`);
        declared.add(name);
      }
      lines.push(`${name}${renderLabels(labels)} ${value}`);
    }
    return lines;
  }
}

export function gauge(name: string, value: number, labels: Labels = {}): string {
  return `${name}${renderLabels(labels)} ${value}`;
}

function renderLabels(labels: Labels): string {
  const parts = Object.entries(labels).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}
