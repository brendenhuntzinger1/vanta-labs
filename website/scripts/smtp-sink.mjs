#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A LOCAL SMTP SINK, so marketing email is testable at all.
//
// Transactional mail was already observable in the harness: with email disabled
// the app falls back to NoopEmailProvider, which writes every rendered message
// to EMAIL_CAPTURE_DIR. Marketing mail is not, and cannot be — campaigns and
// automations refuse to send while email is disabled (marketingBlockedReason),
// which is correct behaviour and also means the only way to watch a win-back
// leave the building is to have a provider that is genuinely "ready".
//
// So this is one: a real SMTP server that speaks just enough of RFC 5321 for
// nodemailer, accepts everything, delivers nothing, and appends each message to
// the same JSONL file the noop provider writes. A test reads what the customer
// would have received, from the path the customer's mail actually takes.
//
// Deliberately plaintext and deliberately AUTH-accepting: it binds to loopback
// only, and the credentials it accepts are whatever the harness env invented.
//
//   node scripts/smtp-sink.mjs --port 2525 --capture /tmp/vanta-qa
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(arg("port", 2525));
const CAPTURE_DIR = arg("capture", process.env.EMAIL_CAPTURE_DIR || "/tmp/vanta-qa");
const HOST = "127.0.0.1";

mkdirSync(CAPTURE_DIR, { recursive: true });
const CAPTURE_FILE = join(CAPTURE_DIR, "captured-emails.jsonl");

/** Decode the two transfer encodings nodemailer actually emits for our HTML. */
function decodeBody(body, encoding) {
  if (/base64/i.test(encoding)) {
    return Buffer.from(body.replace(/\r?\n/g, ""), "base64").toString("utf8");
  }
  if (/quoted-printable/i.test(encoding)) {
    return body
      .replace(/=\r?\n/g, "")                                        // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return body;
}

/** MIME headers can be folded across lines and RFC 2047-encoded. */
function unfold(headerBlock) {
  return headerBlock.replace(/\r?\n[ \t]+/g, " ");
}

function decodeWord(value) {
  return value.replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g, (_, kind, text) => {
    if (kind.toLowerCase() === "b") return Buffer.from(text, "base64").toString("utf8");
    return text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (__, hex) => String.fromCharCode(parseInt(hex, 16)));
  });
}

/**
 * Pull the fields a test cares about out of a raw message.
 *
 * Not a general MIME parser and not trying to be — it handles the shapes
 * nodemailer produces for this app (a text/html part, possibly inside a
 * multipart/alternative) and records the raw message alongside, so anything it
 * gets wrong is still recoverable by whoever is reading the file.
 */
function parseMessage(raw) {
  const split = raw.indexOf("\r\n\r\n") >= 0 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
  const headerBlock = unfold(raw.slice(0, split < 0 ? raw.length : split));
  const body = split < 0 ? "" : raw.slice(split + (raw.includes("\r\n\r\n") ? 4 : 2));

  const headers = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }

  const contentType = headers["content-type"] ?? "";
  let html = "";

  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType);
  if (boundaryMatch) {
    const boundary = `--${boundaryMatch[1]}`;
    for (const part of body.split(boundary)) {
      if (!/content-type:\s*text\/html/i.test(part)) continue;
      const partSplit = part.indexOf("\r\n\r\n") >= 0 ? part.indexOf("\r\n\r\n") : part.indexOf("\n\n");
      if (partSplit < 0) continue;
      const partHeaders = unfold(part.slice(0, partSplit));
      const encoding = /content-transfer-encoding:\s*(\S+)/i.exec(partHeaders)?.[1] ?? "";
      html = decodeBody(part.slice(partSplit + (part.includes("\r\n\r\n") ? 4 : 2)), encoding);
      break;
    }
  } else if (/text\/html/i.test(contentType)) {
    html = decodeBody(body, headers["content-transfer-encoding"] ?? "");
  }

  const addressOnly = (value) => {
    const angled = /<([^>]+)>/.exec(value ?? "");
    return (angled ? angled[1] : String(value ?? "")).trim();
  };

  return {
    to: addressOnly(headers.to),
    from: addressOnly(headers.from),
    subject: decodeWord(headers.subject ?? ""),
    html,
    headers,
    raw,
    capturedAt: new Date().toISOString(),
    via: "smtp-sink",
  };
}

const server = createServer((socket) => {
  let buffer = "";
  let inData = false;
  let data = "";
  let envelopeTo = "";

  const say = (line) => socket.write(`${line}\r\n`);
  say("220 smtp-sink ESMTP ready");

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    for (;;) {
      if (inData) {
        // The message ends at a lone dot on its own line.
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        data += buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;

        // Undo dot-stuffing, then record it.
        const message = parseMessage(data.replace(/\r\n\.\./g, "\r\n."));
        if (!message.to) message.to = envelopeTo;
        appendFileSync(CAPTURE_FILE, `${JSON.stringify(message)}\n`);
        console.log(`[smtp-sink] ${message.to} — ${message.subject}`);
        data = "";
        say("250 2.0.0 Ok: queued as sink");
        continue;
      }

      const at = buffer.indexOf("\r\n");
      if (at < 0) return;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const verb = line.split(/[ :]/)[0].toUpperCase();

      if (verb === "EHLO" || verb === "HELO") {
        say("250-smtp-sink");
        say("250-AUTH PLAIN LOGIN");
        say("250-8BITMIME");
        say("250 SMTPUTF8");
      } else if (verb === "AUTH") {
        // Accepts anything. It listens on loopback and delivers nowhere.
        if (/PLAIN\s+\S/i.test(line)) say("235 2.7.0 Accepted");
        else { say("334 "); }
      } else if (verb === "MAIL") {
        say("250 2.1.0 Ok");
      } else if (verb === "RCPT") {
        envelopeTo = (/<([^>]*)>/.exec(line)?.[1] ?? "").trim();
        say("250 2.1.5 Ok");
      } else if (verb === "DATA") {
        inData = true;
        say("354 End data with <CR><LF>.<CR><LF>");
      } else if (verb === "RSET") {
        data = ""; inData = false; say("250 2.0.0 Ok");
      } else if (verb === "QUIT") {
        say("221 2.0.0 Bye");
        socket.end();
        return;
      } else if (verb === "NOOP") {
        say("250 2.0.0 Ok");
      } else {
        // Includes the base64 lines of an AUTH LOGIN exchange.
        say("235 2.7.0 Accepted");
      }
    }
  });

  socket.on("error", () => {});
});

server.listen(PORT, HOST, () => {
  console.log(`[smtp-sink] listening on ${HOST}:${PORT}`);
  console.log(`[smtp-sink] capturing to ${CAPTURE_FILE}`);
  console.log("[smtp-sink] ACCEPTS EVERYTHING AND DELIVERS NOTHING. Loopback only.");
});
