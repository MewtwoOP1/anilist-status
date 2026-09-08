import { config } from './config.js';
import { Logger } from './utils/logger.js';
import { JsonDatabase, type PersistedConfig } from './storage/database.js';
import { createDiscordClient } from './discord/client.js';
import { registerCommands, handleCommand, handleModal } from './discord/commands.js';
import { AlertService } from './discord/alerts.js';
import { Monitor } from './monitor/monitor.js';

const logger = new Logger(config.logLevel);
const defaults: PersistedConfig = {
  channelId: config.channelId ?? null,
  statusChannelId: config.statusChannelId ?? null,
  roleId: config.roleId ?? null,
  alertMessage: config.alertMessage,
  recoveryMessage: config.recoveryMessage,
  intervalSeconds: config.checkIntervalSeconds,
  failureThreshold: config.failureThreshold,
  recoveryThreshold: config.recoveryThreshold
};
const db = new JsonDatabase(config.stateFile, defaults, config.historyLimit);
const client = createDiscordClient();
const alerts = new AlertService(client, db, logger);
let monitor: Monitor;
let shuttingDown = false;

async function main(): Promise<void> {
  await db.load();
  monitor = new Monitor(db, logger, event => alerts.sendEvent(event), {
    anilistUrl: config.anilistUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    historyLimit: config.historyLimit,
    rateLimitBackoffSeconds: config.rateLimitBackoffSeconds,
    maxRateLimitBackoffSeconds: config.maxRateLimitBackoffSeconds
  }, result => alerts.sendStatusMessage(result));

  client.once('clientReady', async ready => {
    logger.info('Discord connected.', { user: ready.user.tag });
    try {
      await registerCommands(client);
      logger.info('Slash commands registered.', { scope: config.discordGuildId ? 'guild' : 'global' });
      await monitor.start();
    } catch (error) {
      logger.error('Startup monitoring initialization failed.', { error: error instanceof Error ? error.message : String(error) });
      // Keep the Discord bot alive. A later manual restart can recover registration/storage issues.
    }
  });

  client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) await handleCommand(interaction, db, monitor, alerts, logger);
    else if (interaction.isModalSubmit()) await handleModal(interaction, db, logger);
  });
  client.on('error', error => logger.error('Discord client error.', { error: error.message }));
  client.on('warn', warning => logger.warn('Discord warning.', { warning }));

  await client.login(config.discordToken);
  logger.info('Discord login initiated.');
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down.', { signal });
  monitor?.stop();
  client.destroy();
  setTimeout(() => process.exit(0), 250).unref();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', reason => logger.error('Unhandled promise rejection.', { error: reason instanceof Error ? reason.message : String(reason) }));
process.on('uncaughtException', error => { logger.error('Uncaught exception.', { error: error.message }); });

main().catch(error => { logger.error('Fatal startup error.', { error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; });
