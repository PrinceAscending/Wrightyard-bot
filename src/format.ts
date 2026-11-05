const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remainder}s`;
  }
  return `${remainder}s`;
}

export function formatTimestamp(date: Date, style: "t" | "T" | "d" | "D" | "f" | "F" | "R" = "f"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
