# AniList Discord Monitor

A Discord bot that monitors the AniList GraphQL API and reports outages, rate limits, API errors, deprecations, recovery, and response times.

## Discord behavior

- `/set-channel` sets the **alert channel**. It stays quiet during normal operation and only receives confirmed outage, rate-limit, deprecation, and recovery alerts.
- `/set-status-channel` sets the **status channel**. A **new embed is sent after every completed monitoring check**. It does not edit or reuse an older message.
- `/test` sends a test embed to the configured alert channel.
- All slash-command responses use Discord embeds with the AniList monitor brand color.

The bot needs **View Channel**, **Send Messages**, and **Embed Links** in both configured channels. The alert role also needs to be mentionable by the bot's permissions/configuration.

## AniList 403 outage detection

The monitor sends a real GraphQL POST request to the configured AniList endpoint. HTTP 429 is classified as `RATE_LIMITED`. HTTP 5xx, timeouts, network failures, and HTTP 403 responses from the public AniList endpoint are treated as unavailable/down conditions. GraphQL error messages are preserved where available, and explicit deprecation evidence is classified as `DEPRECATED`.

## Alert flow

The default failure threshold is 2 consecutive non-healthy checks. This prevents one transient request failure from immediately paging everyone. A confirmed incident sends one alert. Recovery requires the configured number of consecutive healthy checks and then sends one recovery message.

Rate limits trigger the monitor's backoff logic and include `Retry-After` information when AniList provides it.

## Commands

### Monitoring

- `/help` - Show all commands.
- `/status` - Show current monitoring state.
- `/check` - Run an immediate AniList health check.
- `/stats` - Show rolling statistics.
- `/ping` - Show Discord gateway latency.

### Alerts and configuration

Admin commands require **Manage Server**:

- `/test`
- `/config`
- `/set-channel`
- `/set-status-channel`
- `/set-role`
- `/set-interval`
- `/set-alert`
- `/set-recovery`
- `/reset-config`

## Message customization

Alert and recovery templates support:

`{status}` `{http_status}` `{response_time}` `{error}` `{timestamp}` `{retry_after}` `{downtime}` `{consecutive_failures}`

The actual alert embeds also include structured status information so the important details remain readable even when templates are customized.
