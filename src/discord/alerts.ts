import { EmbedBuilder, type Client, type SendableChannels } from 'discord.js';
import type { HealthResult } from '../anilist/types.js';
import { JsonDatabase } from '../storage/database.js';
import { discordTimestamp, formatDuration, formatResponseTime, replacePlaceholders, sanitizeDiscordText } from '../utils/formatting.js';
import type { MonitorEvent } from '../monitor/monitor.js';
import { Logger } from '../utils/logger.js';

export const BRAND_GREEN = 0x16ff2a;

function statusColor(status: HealthResult['status']): number {
  return BRAND_GREEN;
}

function statusIcon(status: HealthResult['status']): string {
  switch (status) {
    case 'HEALTHY': return '🟢';
    case 'RATE_LIMITED': return '🟠';
    case 'DEPRECATED': return '🟣';
    case 'API_ERROR': return '🟡';
    default: return '🔴';
  }
}

function statusTitle(status: HealthResult['status']): string {
  switch (status) {
    case 'HEALTHY': return 'AniList API is Healthy';
    case 'RATE_LIMITED': return 'AniList API is Rate Limited';
    case 'DEPRECATED': return 'AniList API Deprecation Detected';
    case 'API_ERROR': return 'AniList API Error';
    default: return 'AniList API is Down';
  }
}

export class AlertService {
  constructor(private readonly client: Client, private readonly db: JsonDatabase, private readonly logger: Logger) {}

  private async getChannel(id: string | null): Promise<SendableChannels | null> {
    if (!id) return null;
    try {
      const channel = await this.client.channels.fetch(id);
      if (!channel || !channel.isTextBased() || !channel.isSendable()) return null;
      return channel;
    } catch (error) {
      this.logger.error('Unable to fetch configured Discord channel.', { channelId: id, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private values(result: HealthResult, outageStartedAt?: number): Record<string, string> {
    const retry = result.retryAfterSeconds == null ? '' : `Retry after: ${result.retryAfterSeconds}s`;
    return {
      status: result.status,
      http_status: result.httpStatus == null ? 'N/A' : String(result.httpStatus),
      error: sanitizeDiscordText(result.error ?? 'None'),
      response_time: formatResponseTime(result.responseTimeMs),
      timestamp: discordTimestamp(result.checkedAt),
      retry_after: retry,
      downtime: outageStartedAt == null ? 'N/A' : formatDuration(Date.now() - outageStartedAt),
      consecutive_failures: String(this.db.snapshot.consecutiveFailures)
    };
  }

  private eventEmbed(event: MonitorEvent): EmbedBuilder {
    const result = event.result;
    const values = this.values(result, event.outageStartedAt);
    const state = this.db.snapshot;
    const isRateLimited = result.status === 'RATE_LIMITED';
    const description = event.type === 'ALERT'
      ? isRateLimited
        ? 'AniList API is currently rate limited. Requests may be rejected or delayed until the limit resets.'
        : result.status === 'DEPRECATED'
          ? 'AniList reported a deprecation or removed API operation. Apps using the affected API may stop working properly.'
          : 'AniList API is down or unavailable. We cannot do anything about the upstream outage, and apps using AniList may not work properly.'
      : 'AniList API has recovered and is responding normally again.';

    const embed = new EmbedBuilder()
      .setColor(statusColor(result.status))
      .setTitle(`${event.type === 'ALERT' ? '🚨' : '✅'} ${event.type === 'ALERT' ? statusTitle(result.status) : 'AniList API has Recovered'}`)
      .setDescription(description)
      .addFields(
        { name: 'Status', value: `**${result.status}**`, inline: true },
        { name: 'HTTP', value: result.httpStatus == null ? 'N/A' : `**${result.httpStatus}**`, inline: true },
        { name: 'Response Time', value: `**${formatResponseTime(result.responseTimeMs)}**`, inline: true }
      )
      .setTimestamp(new Date(result.checkedAt))
      .setFooter({ text: 'AniList API Monitor' });

    if (event.type === 'ALERT') {
      if (result.error) embed.addFields({ name: isRateLimited ? 'Rate Limit Details' : 'Details', value: sanitizeDiscordText(result.error, 1024) });
      if (result.retryAfterSeconds != null) embed.addFields({ name: 'Retry After', value: `**${result.retryAfterSeconds}s**`, inline: true });
      embed.addFields({ name: 'Detected', value: discordTimestamp(result.checkedAt), inline: true });
      if (state.config.alertMessage.trim()) {
        const custom = replacePlaceholders(state.config.alertMessage, values).trim();
        if (custom && !/^🚨 AniList API Alert\s*$/i.test(custom)) embed.addFields({ name: 'Custom Alert', value: sanitizeDiscordText(custom, 1024) });
      }
    } else {
      embed.addFields(
        { name: 'Downtime', value: `**${formatDuration(Date.now() - event.outageStartedAt)}**`, inline: true },
        { name: 'Recovered', value: discordTimestamp(result.checkedAt), inline: true }
      );
      const custom = replacePlaceholders(state.config.recoveryMessage, values).trim();
      if (custom && !/^✅ AniList API has recovered\.?$/i.test(custom)) embed.addFields({ name: 'Custom Recovery', value: sanitizeDiscordText(custom, 1024) });
    }

    return embed;
  }

  async sendEvent(event: MonitorEvent): Promise<void> {
    const channel = await this.getChannel(this.db.snapshot.config.channelId);
    if (!channel) {
      this.logger.warn('Alert not sent because no valid alert channel is configured.');
      return;
    }

    const roleId = this.db.snapshot.config.roleId;
    try {
      const payload = {
        embeds: [this.eventEmbed(event)],
        allowedMentions: event.type === 'ALERT' && roleId
          ? { roles: [roleId], users: [], repliedUser: false }
          : { parse: [] as const }
      };
      const message = await channel.send(event.type === 'ALERT' && roleId
        ? { ...payload, content: `<@&${roleId}>` }
        : payload);
      if (event.type === 'ALERT') await this.db.setOutage(event.outageStartedAt, message.id);
      this.logger.info(`Discord ${event.type.toLowerCase()} alert sent.`);
    } catch (error) {
      this.logger.error(`Failed to send Discord ${event.type.toLowerCase()} alert.`, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async sendTest(result?: HealthResult): Promise<boolean> {
    const channel = await this.getChannel(this.db.snapshot.config.channelId);
    if (!channel) return false;

    try {
      const testEmbed = new EmbedBuilder()
        .setColor(statusColor(result?.status ?? 'HEALTHY'))
        .setTitle(`🧪 AniList API Test${result ? ` • ${statusIcon(result.status)}` : ''}`)
        .setDescription(
          result
            ? result.status === 'HEALTHY'
              ? 'AniList API responded normally during this manual test. This test does not change monitor state or trigger outage/recovery alerts.'
              : result.status === 'RATE_LIMITED'
                ? 'AniList API is currently rate limited. This manual test does not change monitor state or trigger outage/recovery alerts.'
                : result.status === 'DOWN'
                  ? 'AniList API is currently unavailable. This manual test does not change monitor state or trigger outage/recovery alerts.'
                  : result.status === 'DEPRECATED'
                    ? 'A deprecated or removed AniList API operation was detected. This manual test does not change monitor state or trigger outage/recovery alerts.'
                    : 'AniList returned an API error. This manual test does not change monitor state or trigger outage/recovery alerts.'
            : 'The alert system is working correctly. This test does not indicate an outage.'
        )
        .setFooter({ text: 'AniList API Monitor • Manual Test' })
        .setTimestamp();

      if (result) {
        testEmbed.addFields(
          { name: 'Status', value: `**${result.status}**`, inline: true },
          { name: 'HTTP', value: result.httpStatus == null ? 'N/A' : `**${result.httpStatus}**`, inline: true },
          { name: 'Response Time', value: `**${formatResponseTime(result.responseTimeMs)}**`, inline: true },
          { name: 'Checked', value: discordTimestamp(result.checkedAt), inline: true }
        );

        if (result.error) {
          testEmbed.addFields({
            name: 'Details',
            value: sanitizeDiscordText(result.error, 1024),
            inline: false
          });
        }

        if (result.retryAfterSeconds != null) {
          testEmbed.addFields({
            name: 'Retry After',
            value: `**${result.retryAfterSeconds}s**`,
            inline: true
          });
        }
      }

      await channel.send({
        embeds: [testEmbed],
        allowedMentions: { parse: [] }
      });
      return true;
    } catch (error) {
      this.logger.error('Failed to send test alert.', {
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  async sendStatusMessage(result: HealthResult | null = this.db.snapshot.lastCheck): Promise<void> {
    const state = this.db.snapshot;
    const channel = await this.getChannel(state.config.statusChannelId);
    if (!channel) {
      this.logger.warn('Status message not updated because no valid status channel is configured.');
      return;
    }

    const status = result?.status ?? state.currentStatus;
    const checkedAt = result?.checkedAt ?? Date.now();
    const responseTime = result ? formatResponseTime(result.responseTimeMs) : 'N/A';
    const http = result?.httpStatus == null ? 'N/A' : String(result.httpStatus);
    const error = sanitizeDiscordText(result?.error ?? 'None');

    const embed = new EmbedBuilder()
      .setColor(statusColor(status))
      .setTitle(`${statusIcon(status)} AniList API Status`)
      .setDescription(status === 'HEALTHY'
        ? 'AniList API is responding normally.'
        : status === 'RATE_LIMITED'
          ? 'AniList API is rate limited. Requests may be delayed or rejected.'
          : status === 'DOWN'
            ? 'AniList API is currently unavailable. Apps using AniList may not work properly.'
            : status === 'DEPRECATED'
              ? 'A deprecated or removed AniList API operation was detected.'
              : 'AniList returned an API error.')
      .addFields(
        { name: 'Status', value: `**${status}**`, inline: true },
        { name: 'HTTP', value: `**${http}**`, inline: true },
        { name: 'Response Time', value: `**${responseTime}**`, inline: true },
        { name: 'Last Checked', value: discordTimestamp(checkedAt), inline: true }
      )
      .setTimestamp(new Date(checkedAt))
      .setFooter({ text: 'AniList API Monitor' });

    if (status !== 'HEALTHY' && error !== 'None') {
      embed.addFields({ name: 'Details', value: error });
    }
    if (result?.retryAfterSeconds != null) {
      embed.addFields({ name: 'Retry After', value: `**${result.retryAfterSeconds}s**`, inline: true });
    }
    if (state.outageStartedAt) {
      embed.addFields({ name: 'Current Outage', value: `**${formatDuration(Date.now() - state.outageStartedAt)}**`, inline: true });
    }

    try {
      if (state.config.statusMessageId) {
        try {
          const existing = await channel.messages.fetch(state.config.statusMessageId);
          await existing.edit({ embeds: [embed], allowedMentions: { parse: [] } });
          return;
        } catch {
          this.logger.warn('Configured status message could not be fetched. Creating a replacement.');
        }
      }

      const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      await this.db.updateConfig({ statusMessageId: message.id });
    } catch (error) {
      this.logger.error('Failed to update AniList status message.', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
