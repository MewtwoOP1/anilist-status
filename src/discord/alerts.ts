import { EmbedBuilder, type Client, type TextChannel } from 'discord.js';
import type { HealthCheckResult, HealthStatus } from '../anilist/types.js';
import type { JsonDatabase } from '../storage/database.js';
import { renderTemplate } from '../utils/formatting.js';

export const BRAND_GREEN = 0x16ff2a;

export class AlertService {
  constructor(
    private readonly client: Client,
    private readonly database: JsonDatabase,
    private readonly guildId: string
  ) {}

  private async getTextChannel(channelId: string): Promise<TextChannel | null> {
    const channel = await this.client.channels.fetch(channelId);

    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      return null;
    }

    return channel as TextChannel;
  }

  async sendEvent(
    result: HealthCheckResult,
    type: 'outage' | 'recovery'
  ): Promise<boolean> {
    const state = this.database.snapshot;
    const channelId = state.config.channelId;

    if (!channelId) return false;

    const channel = await this.getTextChannel(channelId);
    if (!channel) return false;

    const messageTemplate =
      type === 'outage'
        ? state.config.alertMessage
        : state.config.recoveryMessage;

    const message = renderTemplate(messageTemplate, {
      status: result.status,
      http_status: result.httpStatus ?? 'N/A',
      response_time: `${result.responseTimeMs}ms`,
      error: result.error ?? 'None',
      timestamp: result.checkedAt,
      retry_after:
        result.retryAfterSeconds != null
          ? `Retry after: ${result.retryAfterSeconds}s`
          : '',
      downtime: state.outageStartedAt
        ? formatDowntime(state.outageStartedAt)
        : 'Unknown'
    });

    const alertEmbed = new EmbedBuilder()
      .setColor(type === 'recovery' ? BRAND_GREEN : statusColor(result.status))
      .setTitle(
        type === 'recovery'
          ? '✅ AniList API Recovered'
          : `${statusIcon(result.status)} AniList API Alert`
      )
      .setDescription(message)
      .setTimestamp();

    const content =
      type === 'outage' && state.config.roleId
        ? `<@&${state.config.roleId}>`
        : undefined;

    await channel.send({
      content,
      embeds: [alertEmbed],
      allowedMentions:
        type === 'outage' && state.config.roleId
          ? { roles: [state.config.roleId] }
          : { parse: [] }
    });

    return true;
  }

  async sendTest(): Promise<boolean> {
    const channelId = this.database.snapshot.config.channelId;

    if (!channelId) return false;

    const channel = await this.getTextChannel(channelId);
    if (!channel) return false;

    const testEmbed = new EmbedBuilder()
      .setColor(BRAND_GREEN)
      .setTitle('🧪 AniList Monitor Test')
      .setDescription(
        'This is a test alert. The AniList monitor is able to send Discord messages.'
      )
      .setTimestamp();

    await channel.send({ embeds: [testEmbed] });

    return true;
  }

  async sendStatusMessage(result?: HealthCheckResult): Promise<boolean> {
    const state = this.database.snapshot;
    const channelId = state.config.statusChannelId;

    if (!channelId) return false;

    const channel = await this.getTextChannel(channelId);
    if (!channel) return false;

    const status = result?.status ?? state.currentStatus;
    const lastCheck = result ?? state.lastCheck;

    if (!lastCheck) return false;

    const statusEmbed = new EmbedBuilder()
      .setColor(statusColor(status))
      .setTitle(`${statusIcon(status)} AniList API Status`)
      .setDescription(statusDescription(status))
      .addFields(
        {
          name: 'Status',
          value: `**${status}**`,
          inline: true
        },
        {
          name: 'HTTP',
          value:
            lastCheck.httpStatus == null
              ? 'N/A'
              : `**${lastCheck.httpStatus}**`,
          inline: true
        },
        {
          name: 'Response Time',
          value: `**${lastCheck.responseTimeMs}ms**`,
          inline: true
        }
      )
      .setTimestamp();

    if (lastCheck.error) {
      statusEmbed.addFields({
        name: 'Details',
        value: lastCheck.error.slice(0, 1024)
      });
    }

    if (lastCheck.retryAfterSeconds != null) {
      statusEmbed.addFields({
        name: 'Retry After',
        value: `**${lastCheck.retryAfterSeconds}s**`,
        inline: true
      });
    }

    if (state.config.statusMessageId) {
      try {
        const message = await channel.messages.fetch(
          state.config.statusMessageId
        );

        await message.edit({
          embeds: [statusEmbed]
        });

        return true;
      } catch {
        // Existing message was deleted or is inaccessible.
        // Create a replacement below.
      }
    }

    const message = await channel.send({
      embeds: [statusEmbed]
    });

    await this.database.updateConfig({
      statusMessageId: message.id
    });

    return true;
  }
}

function statusIcon(status: HealthStatus | string): string {
  switch (status) {
    case 'HEALTHY':
      return '🟢';
    case 'RATE_LIMITED':
      return '🟠';
    case 'DEPRECATED':
      return '🟣';
    case 'API_ERROR':
      return '🟡';
    default:
      return '🔴';
  }
}

function statusColor(status: HealthStatus | string): number {
  switch (status) {
    case 'HEALTHY':
      return BRAND_GREEN;
    case 'RATE_LIMITED':
      return 0xffa500;
    case 'DEPRECATED':
      return 0x9b59b6;
    case 'API_ERROR':
      return 0xffff00;
    default:
      return 0xff3333;
  }
}

function statusDescription(status: HealthStatus | string): string {
  switch (status) {
    case 'HEALTHY':
      return 'AniList API is responding normally.';
    case 'RATE_LIMITED':
      return 'AniList API is currently rate limited. Requests may be rejected or delayed until the limit resets.';
    case 'DEPRECATED':
      return 'A deprecated or removed AniList API operation was detected.';
    case 'API_ERROR':
      return 'AniList returned an API error.';
    default:
      return 'AniList API is down or unavailable. We cannot do anything about the upstream outage, and apps using AniList may not work properly.';
  }
}

function formatDowntime(startedAt: number): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - startedAt) / 1000)
  );

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
}
