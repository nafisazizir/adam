type Command = "set" | "info" | "delete";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.error(
      `Missing ${name}. Set it in .env (run with: node --env-file=.env scripts/telegram-webhook.ts).`,
    );
    process.exit(1);
  }
  return value.trim();
}

const command = (process.argv[2] ?? "set") as Command;
if (!["set", "info", "delete"].includes(command)) {
  console.error(`Unknown command "${command}". Use: set | info | delete.`);
  process.exit(1);
}

const botToken = required("TELEGRAM_BOT_TOKEN");
const api = (method: string) =>
  `https://api.telegram.org/bot${botToken}/${method}`;

async function call(method: string, body?: unknown) {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: unknown;
  };
  if (!res.ok || !data.ok) {
    console.error(`${method} failed:`, JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

if (command === "info") {
  const data = await call("getWebhookInfo");
  console.log(JSON.stringify(data.result, null, 2));
} else if (command === "delete") {
  await call("deleteWebhook", { drop_pending_updates: false });
  console.log("webhook deleted");
} else {
  const baseUrl = required("BASE_URL").replace(/\/+$/, "");
  const secretToken = required("TELEGRAM_WEBHOOK_SECRET_TOKEN");
  const url = `${baseUrl}/eve/v1/telegram`;

  await call("setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "callback_query"],
  });
  console.log(`webhook set -> ${url}`);
}

export {};
