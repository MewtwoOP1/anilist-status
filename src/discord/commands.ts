import { ActionRowBuilder, ChannelType, EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, Role, SlashCommandBuilder, TextInputBuilder, TextInputStyle, type ChatInputCommandInteraction, type Client } from 'discord.js';
import { healthCheck } from '../anilist/healthCheck.js';
import { config } from '../config.js';
import { JsonDatabase } from '../storage/database.js';
import { formatDuration, formatResponseTime, discordTimestamp, sanitizeDiscordText } from '../utils/formatting.js';
import { AlertService, BRAND_GREEN } from './alerts.js';
import { Logger } from '../utils/logger.js';
import type { Monitor } from '../monitor/monitor.js';

const admin = PermissionFlagsBits.ManageGuild;

function embed(title: string, description?: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(BRAND_GREEN).setTitle(title).setFooter({ text: 'AniList API Monitor' }).setTimestamp();
  if (description) e.setDescription(description);
  return e;
}

function statusIcon(status: string): string {
  if (status === 'HEALTHY') return '🟢';
  if (status === 'RATE_LIMITED') return '🟠';
  if (status === 'DEPRECATED') return '🟣';
  if (status === 'API_ERROR') return '🟡';
  return '🔴';
}

export const commandData = [
  new SlashCommandBuilder().setName('help').setDescription('Show all AniList monitor commands.'),
  new SlashCommandBuilder().setName('ping').setDescription('Check the bot latency.'),
  new SlashCommandBuilder().setName('status').setDescription('Show the current AniList monitoring status.'),
  new SlashCommandBuilder().setName('check').setDescription('Run an immediate AniList health check.'),
  new SlashCommandBuilder().setName('test').setDescription('Send a test alert to the configured alert channel.').setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('config').setDescription('Show current non-secret bot configuration.').setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('set-channel').setDescription('Set the channel for outage and recovery alerts.').addChannelOption(o => o.setName('channel').setDescription('Text channel for alerts').addChannelTypes(ChannelType.GuildText).setRequired(true)).setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('set-status-channel').setDescription('Set the channel for a new status message every check.').addChannelOption(o => o.setName('channel').setDescription('Text channel for status updates').addChannelTypes(ChannelType.GuildText).setRequired(true)).setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('set-role').setDescription('Set or disable the alert role.').addRoleOption(o => o.setName('role').setDescription('Role to ping; omit to disable').setRequired(false)).setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('set-interval').setDescription('Change the monitoring interval in seconds.').addIntegerOption(o => o.setName('seconds').setDescription(`Minimum ${config.minIntervalSeconds} seconds`).setMinValue(config.minIntervalSeconds).setMaxValue(86400).setRequired(true)).setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('set-alert').setDescription('Change the alert message using placeholders.').setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('set-recovery').setDescription('Change the recovery message using placeholders.').setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('reset-config').setDescription('Restore configurable settings to their startup defaults.').setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('stats').setDescription('Show rolling monitoring statistics.')
].map(command => command.toJSON());

function isAdmin(interaction: ChatInputCommandInteraction): boolean { return interaction.memberPermissions?.has(admin) ?? false; }

export async function registerCommands(client: Client): Promise<void> {
  const applicationId = config.discordClientId ?? client.application?.id ?? client.user?.id;
  if (!applicationId) throw new Error('Could not determine Discord application ID.');
  if (config.discordGuildId) await client.application?.commands.set(commandData, config.discordGuildId);
  else await client.application?.commands.set(commandData);
}

async function showMessageModal(interaction: ChatInputCommandInteraction, type: 'alert' | 'recovery', current: string): Promise<void> {
  const modal = new ModalBuilder().setCustomId(`set-${type}-modal`).setTitle(type === 'alert' ? 'Set Alert Message' : 'Set Recovery Message');
  const input = new TextInputBuilder().setCustomId('message').setLabel('Message template').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1900).setValue(current.slice(0, 1900));
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await interaction.showModal(modal);
}

export async function handleCommand(interaction: ChatInputCommandInteraction, db: JsonDatabase, monitor: Monitor, alerts: AlertService, logger: Logger): Promise<void> {
  try {
    const command = interaction.commandName;
    const adminCommands = ['test', 'config', 'set-channel', 'set-status-channel', 'set-role', 'set-interval', 'set-alert', 'set-recovery', 'reset-config'];
    if (adminCommands.includes(command) && !isAdmin(interaction)) {
      await interaction.reply({ embeds: [embed('🔒 Permission Required', 'You need the **Manage Server** permission to use this command.')], flags: MessageFlags.Ephemeral });
      return;
    }

    const state = db.snapshot;

    if (command === 'help') {
      const e = embed('📖 AniList API Monitor — Help', 'Monitor AniList, report outages, track recovery, and keep a rolling status log.');
      e.addFields(
        { name: 'Monitoring', value: '`/status` • Current AniList status\n`/check` • Run an immediate health check\n`/stats` • View monitoring statistics\n`/ping` • Check Discord latency', inline: false },
        { name: 'Alerts', value: '`/test` • Send a test alert\n`/set-channel` • Set outage/recovery channel\n`/set-status-channel` • Set the channel for a new status message every check\n`/set-role` • Configure the alert role', inline: false },
        { name: 'Configuration', value: '`/config` • View configuration\n`/set-interval` • Change check interval\n`/set-alert` • Customize outage/rate-limit alert\n`/set-recovery` • Customize recovery message\n`/reset-config` • Restore startup defaults', inline: false },
        { name: 'Permissions', value: 'Configuration and test commands require **Manage Server**. Monitoring commands are available to everyone.' }
      );
      await interaction.reply({ embeds: [e] });
      return;
    }

    if (command === 'ping') {
      const e = embed('🏓 Pong!', 'Discord gateway is responding normally.')
        .addFields({ name: 'Gateway Latency', value: `**${interaction.client.ws.ping}ms**`, inline: true });
      await interaction.reply({ embeds: [e] });
      return;
    }

    if (command === 'status') {
      const last = state.lastCheck;
      const e = embed(`${statusIcon(state.currentStatus)} AniList API Status`, state.currentStatus === 'HEALTHY' ? 'AniList API is responding normally.' : state.currentStatus === 'RATE_LIMITED' ? 'AniList API is currently rate limited.' : state.currentStatus === 'DOWN' ? 'AniList API is currently unavailable. Apps using AniList may not work properly.' : state.currentStatus === 'DEPRECATED' ? 'A deprecated or removed AniList API operation was detected.' : 'AniList returned an API error.')
        .addFields(
          { name: 'Status', value: `**${state.currentStatus}**`, inline: true },
          { name: 'Response Time', value: `**${formatResponseTime(last?.responseTimeMs ?? null)}**`, inline: true },
          { name: 'Interval', value: `**${state.config.intervalSeconds}s**`, inline: true },
          { name: 'Last Check', value: last ? discordTimestamp(last.checkedAt) : 'Never', inline: true },
          { name: 'Last Successful', value: state.lastSuccessfulAt ? discordTimestamp(state.lastSuccessfulAt) : 'Never', inline: true },
          { name: 'Consecutive Failures', value: `**${state.consecutiveFailures}**`, inline: true }
        );
      if (state.outageStartedAt) e.addFields({ name: 'Current Outage', value: `**${formatDuration(Date.now() - state.outageStartedAt)}**`, inline: true });
      if (last?.httpStatus != null) e.addFields({ name: 'HTTP', value: `**${last.httpStatus}**`, inline: true });
      if (last?.error) e.addFields({ name: 'Details', value: sanitizeDiscordText(last.error, 1024) });
      await interaction.reply({ embeds: [e] });
      return;
    }

    if (command === 'check') {
      await interaction.deferReply();
      const result = await healthCheck(config.anilistUrl, config.requestTimeoutMs);
      const e = embed(`${statusIcon(result.status)} AniList Health Check`, result.status === 'HEALTHY' ? 'The AniList GraphQL endpoint responded successfully.' : result.status === 'RATE_LIMITED' ? 'AniList rate limited this request. The monitor will respect the retry/backoff information.' : result.status === 'DOWN' ? 'AniList API is unavailable. Apps using AniList may not work properly.' : result.status === 'DEPRECATED' ? 'A deprecated or removed API operation was detected.' : 'AniList returned an API error.')
        .addFields(
          { name: 'Status', value: `**${result.status}**`, inline: true },
          { name: 'HTTP', value: result.httpStatus == null ? 'N/A' : `**${result.httpStatus}**`, inline: true },
          { name: 'Response Time', value: `**${formatResponseTime(result.responseTimeMs)}**`, inline: true },
          { name: 'Checked', value: discordTimestamp(result.checkedAt), inline: true }
        );
      if (result.error) e.addFields({ name: 'Details', value: sanitizeDiscordText(result.error, 1024) });
      if (result.retryAfterSeconds != null) e.addFields({ name: 'Retry After', value: `**${result.retryAfterSeconds}s**`, inline: true });
      await interaction.editReply({ embeds: [e] });
      return;
    }

    if (command === 'test') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ok = await alerts.sendTest();
      const e = embed(ok ? '✅ Test Alert Sent' : '❌ Test Alert Failed', ok ? 'The configured alert channel accepted the test embed.' : 'I could not send the test alert. Check `/config` and the bot permissions in the alert channel.');
      await interaction.editReply({ embeds: [e] });
      return;
    }

    if (command === 'config') {
      const c = state.config;
      const e = embed('⚙️ AniList Monitor Configuration')
        .addFields(
          { name: 'Alert Channel', value: c.channelId ? `<#${c.channelId}>` : 'Not configured', inline: true },
          { name: 'Status Channel', value: c.statusChannelId ? `<#${c.statusChannelId}>` : 'Not configured', inline: true },
          { name: 'Alert Role', value: c.roleId ? `<@&${c.roleId}>` : 'Disabled', inline: true },
          { name: 'Interval', value: `**${c.intervalSeconds}s**`, inline: true },
          { name: 'Failure Threshold', value: `**${c.failureThreshold}**`, inline: true },
          { name: 'Recovery Threshold', value: `**${c.recoveryThreshold}**`, inline: true },
          { name: 'Request Timeout', value: `**${config.requestTimeoutMs}ms**`, inline: true },
          { name: 'AniList URL', value: config.anilistUrl, inline: false },
          { name: 'Alert Template', value: c.alertMessage.slice(0, 1024), inline: false },
          { name: 'Recovery Template', value: c.recoveryMessage.slice(0, 1024), inline: false }
        );
      await interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
      return;
    }

    if (command === 'set-channel') {
      const channel = interaction.options.getChannel('channel', true);
      await db.updateConfig({ channelId: channel.id });
      await interaction.reply({ embeds: [embed('✅ Alert Channel Updated', `Outage and recovery alerts will now be sent to <#${channel.id}>.`)], flags: MessageFlags.Ephemeral });
      return;
    }

    if (command === 'set-status-channel') {
      const channel = interaction.options.getChannel('channel', true);
      await db.updateConfig({ statusChannelId: channel.id });
      const ok = await alerts.sendStatusMessage();
      await interaction.reply({ embeds: [embed(ok ? '✅ Status Channel Updated' : '⚠️ Status Channel Updated', ok ? `A new status embed was sent to <#${channel.id}>. A fresh message will be sent after every scheduled check.` : `The channel was saved as <#${channel.id}>, but I could not send the status embed. Check **View Channel**, **Send Messages**, and **Embed Links** permissions.`)], flags: MessageFlags.Ephemeral });
      return;
    }

    if (command === 'set-role') {
      const role = interaction.options.getRole('role', false) as Role | null;
      await db.updateConfig(role ? { roleId: role.id } : { roleId: null });
      await interaction.reply({ embeds: [embed(role ? '✅ Alert Role Updated' : '🔕 Alert Role Disabled', role ? `Outage alerts will ping <@&${role.id}>.` : 'Role pings have been disabled.')], flags: MessageFlags.Ephemeral });
      return;
    }

    if (command === 'set-interval') {
      const seconds = interaction.options.getInteger('seconds', true);
      await db.updateConfig({ intervalSeconds: seconds });
      monitor.restart();
      await interaction.reply({ embeds: [embed('⏱️ Monitoring Interval Updated', `AniList will now be checked every **${seconds} seconds**.`)], flags: MessageFlags.Ephemeral });
      return;
    }

    if (command === 'set-alert') { await showMessageModal(interaction, 'alert', state.config.alertMessage); return; }
    if (command === 'set-recovery') { await showMessageModal(interaction, 'recovery', state.config.recoveryMessage); return; }

    if (command === 'reset-config') {
      await db.updateConfig({ channelId: config.channelId ?? null, statusChannelId: config.statusChannelId ?? null, roleId: config.roleId ?? null, alertMessage: config.alertMessage, recoveryMessage: config.recoveryMessage, intervalSeconds: config.checkIntervalSeconds, failureThreshold: config.failureThreshold, recoveryThreshold: config.recoveryThreshold });
      monitor.restart();
      await interaction.reply({ embeds: [embed('♻️ Configuration Reset', 'All configurable settings have been restored to the values from the environment configuration.')], flags: MessageFlags.Ephemeral });
      return;
    }

    if (command === 'stats') {
      const avg = state.checks ? state.responseTimeTotalMs / state.checks : null;
      const lastOutage = state.outageStartedAt ? formatDuration(Date.now() - state.outageStartedAt) : 'None active';
      const e = embed('📊 AniList API Monitor Statistics')
        .addFields(
          { name: 'Current Status', value: `**${state.currentStatus}**`, inline: true },
          { name: 'Checks', value: `**${state.checks}**`, inline: true },
          { name: 'Successful', value: `**${state.successes}**`, inline: true },
          { name: 'Failed', value: `**${state.failures}**`, inline: true },
          { name: 'Rate Limited', value: `**${state.rateLimits}**`, inline: true },
          { name: 'API Errors', value: `**${state.apiErrors}**`, inline: true },
          { name: 'Deprecated', value: `**${state.deprecated}**`, inline: true },
          { name: 'Average Response', value: `**${formatResponseTime(avg)}**`, inline: true },
          { name: 'Current Outage', value: `**${lastOutage}**`, inline: true }
        );
      await interaction.reply({ embeds: [e] });
      return;
    }
  } catch (error) {
    logger.error('Slash command failed.', { command: interaction.commandName, error: error instanceof Error ? error.message : String(error) });
    const e = embed('❌ Command Failed', 'Something went wrong while handling that command. Check the bot logs for details.');
    if (interaction.replied || interaction.deferred) await interaction.editReply({ embeds: [e] }).catch(() => undefined);
    else await interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

export async function handleModal(interaction: import('discord.js').ModalSubmitInteraction, db: JsonDatabase, logger: Logger): Promise<void> {
  if (!interaction.memberPermissions?.has(admin)) { await interaction.reply({ embeds: [embed('🔒 Permission Required', 'You need the **Manage Server** permission.')], flags: MessageFlags.Ephemeral }); return; }
  try {
    const value = interaction.fields.getTextInputValue('message').trim();
    if (interaction.customId === 'set-alert-modal') await db.updateConfig({ alertMessage: value });
    else if (interaction.customId === 'set-recovery-modal') await db.updateConfig({ recoveryMessage: value });
    else return;
    await interaction.reply({ embeds: [embed('✅ Message Template Saved', 'The new message template has been saved.')], flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.error('Modal handling failed.', { error: error instanceof Error ? error.message : String(error) });
    await interaction.reply({ embeds: [embed('❌ Could Not Save Template', 'The message template could not be saved.')], flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}
