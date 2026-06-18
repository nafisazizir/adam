import { telegramChannel } from "eve/channels/telegram";

import { env } from "#lib/env.js";

export default telegramChannel({
  botUsername: env.TELEGRAM_BOT_USERNAME,
  credentials: {
    botToken: env.TELEGRAM_BOT_TOKEN,
    webhookSecretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
  },
});
