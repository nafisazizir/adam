import { defaultTelegramAuth, telegramChannel } from "eve/channels/telegram";
import type { TelegramMessage } from "eve/channels/telegram";

import { env } from "#lib/env.js";
import { currentTimeContext } from "#lib/time.js";

const botCommand =
  /^\/(?<command>[A-Za-z0-9_]+)(?:@(?<target>[A-Za-z0-9_]+))?(?:\s|$)/u;

function addressesBot(text: string, botUsername: string): boolean {
  const command = botCommand.exec(text);
  const target = command?.groups?.target;

  if (command && (target === undefined || target.toLowerCase() === botUsername.toLowerCase())) {
    return true;
  }

  return text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
}

function shouldDispatch(message: TelegramMessage, botUsername: string): boolean {
  if (message.from?.isBot === true || message.chat.type === "channel") return false;

  const text = message.text || message.caption;
  if (text.trim().length === 0 && message.attachments.length === 0) return false;

  return (
    message.chat.type === "private" ||
    message.replyToMessage?.from?.isBot === true ||
    addressesBot(text, botUsername)
  );
}

export default telegramChannel({
  botUsername: env.TELEGRAM_BOT_USERNAME,
  credentials: {
    botToken: env.TELEGRAM_BOT_TOKEN,
    webhookSecretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
  },
  // Telegram sends no time zone, so local time is injected per turn. Overriding
  // onMessage means restating eve's dispatch gating: defaultOnMessage is not
  // part of its public export surface.
  async onMessage(ctx, message) {
    if (!shouldDispatch(message, env.TELEGRAM_BOT_USERNAME)) return null;

    await ctx.telegram.startTyping();

    return {
      auth: defaultTelegramAuth(message),
      context: [currentTimeContext()],
    };
  },
});
