export interface OutgoingEmail {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string;
  readonly references?: string;
}

const maxEncodedWordBytes = 45;
const bodyLineLength = 76;

// Header values can come from mail a stranger wrote, so a line break must never start a new header.
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/u.test(value);
}

function encodedWords(value: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > maxEncodedWordBytes) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`).join("\r\n ");
}

function headerText(value: string): string {
  const line = singleLine(value);
  return isAscii(line) ? line : encodedWords(line);
}

function address(value: string): string {
  const line = singleLine(value);
  const named = /^"?([^"<]*?)"?\s*<([^<>\s]+)>$/u.exec(line);
  if (!named) return line;
  const [, name = "", email = ""] = named;
  if (!name) return `<${email}>`;
  return isAscii(name) ? `"${name.replace(/["\\]/gu, "")}" <${email}>` : `${encodedWords(name)} <${email}>`;
}

function addressList(values: readonly string[]): string {
  return values.map(address).filter(Boolean).join(", ");
}

function wrapped(base64: string): string {
  return base64.match(new RegExp(`.{1,${bodyLineLength}}`, "gu"))?.join("\r\n") ?? "";
}

export function composeEmail(email: OutgoingEmail): string {
  const headers: [string, string][] = [
    ["To", addressList(email.to)],
    ["Cc", addressList(email.cc)],
    ["Bcc", addressList(email.bcc)],
    ["Subject", headerText(email.subject)],
    ["In-Reply-To", singleLine(email.inReplyTo ?? "")],
    ["References", singleLine(email.references ?? "")],
    ["MIME-Version", "1.0"],
    ["Content-Type", 'text/plain; charset="UTF-8"'],
    ["Content-Transfer-Encoding", "base64"],
  ];
  const head = headers
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
  const body = email.body.replace(/\r?\n/gu, "\r\n");
  return `${head}\r\n\r\n${wrapped(Buffer.from(body).toString("base64"))}\r\n`;
}
