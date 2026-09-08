async sendStatusMessage(result: HealthCheckResult): Promise<void> {
  const config = this.database.getConfig(this.guildId);

  if (!config.statusChannelId) {
    return;
  }

  const channel = await this.client.channels.fetch(config.statusChannelId);

  if (!channel?.isTextBased() || !('send' in channel)) {
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(statusColor(result.status))
    .setTitle(`${statusIcon(result.status)} AniList API Status`)
    .setDescription(statusDescription(result.status))
    .addFields(
      {
        name: 'Status',
        value: result.status,
        inline: true,
      },
      {
        name: 'HTTP',
        value: String(result.httpStatus ?? 'N/A'),
        inline: true,
      },
      {
        name: 'Response Time',
        value: `${result.responseTimeMs}ms`,
        inline: true,
      },
    )
    .setTimestamp();

  // Edit the existing status message.
  if (config.statusMessageId) {
    try {
      const message = await channel.messages.fetch(config.statusMessageId);

      await message.edit({
        embeds: [embed],
      });

      return;
    } catch {
      // The old message was deleted or is inaccessible.
      // Create a replacement below.
    }
  }

  // No existing message, so create the first one.
  const message = await channel.send({
    embeds: [embed],
  });

  this.database.updateConfig(this.guildId, {
    statusMessageId: message.id,
  });
}
