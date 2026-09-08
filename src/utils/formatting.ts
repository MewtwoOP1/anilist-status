import { formatDuration } from './duration.js';

export function discordTimestamp(date: Date | number): string {
  const ms = date instanceof Date ? date.getTime() : date;
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

export function sanitizeDiscordText(input: string, maxLength = 1000): string {
  return input.replace(/@(everyone|here)/gi, '@​$1').replace(/<@&?\d+>/g, '<mention>').replace(/<@!\d+>/g, '<mention>').slice(0, maxLength);
}

export function formatResponseTime(ms: number | null): string {
  return ms == null ? 'N/A' : `${Math.round(ms)}ms`;
}

export function replacePlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/gi, (whole, key: string) => values[key.toLowerCase()] ?? whole);
}

export { formatDuration };
