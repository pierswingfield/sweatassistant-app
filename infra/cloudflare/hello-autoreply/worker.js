// Auto-reply for hello@dibs.fit and hello@mail.dibs.fit. Replies once per inbound message, then drops it.
// No dependencies: the reply MIME is built by hand.
import { EmailMessage } from "cloudflare:email";

const FROM = "hello@mail.dibs.fit"; // fallback only; the reply uses the address that received the mail
const ACCEPTED = ["hello@dibs.fit", "hello@mail.dibs.fit"];
const DOMAIN = "mail.dibs.fit";
const BODY =
  "Thanks for getting in touch. This address doesn't receive mail, so your message hasn't been read. " +
  "To contact Dibs, please use Send Feedback in the app at https://app.dibs.fit (Settings > Send Feedback).";

const NOREPLY_LOCAL = /^(mailer-daemon|postmaster|no-?reply|donotreply|do-not-reply|bounce[s]?|root)$/i;

function bareAddress(value) {
  if (!value) return "";
  const m = /<([^>]+)>/.exec(value);
  return (m ? m[1] : value).trim().toLowerCase();
}

function mask(addr) {
  const a = bareAddress(addr);
  const [local = "", domain = ""] = a.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

// Returns a reason string if the message should be skipped, else "".
export function skipReason(headers, envelopeFrom) {
  const auto = (headers.get("auto-submitted") || "").trim().toLowerCase();
  if (auto && auto !== "no") return "auto-submitted";
  const prec = (headers.get("precedence") || "").trim().toLowerCase();
  if (["bulk", "list", "junk"].includes(prec)) return "precedence";
  if (headers.get("list-id") || headers.get("list-unsubscribe")) return "list";
  if (headers.get("x-auto-response-suppress")) return "x-auto-response-suppress";
  for (const addr of [bareAddress(envelopeFrom), bareAddress(headers.get("from"))]) {
    if (!addr) return "null-sender"; // null sender = bounce
    const [local, domain = ""] = addr.split("@");
    if (NOREPLY_LOCAL.test(local)) return "noreply-sender";
    if (domain === DOMAIN || domain.endsWith("." + DOMAIN)) return "own-domain";
  }
  return "";
}

export function shouldSkip(headers, envelopeFrom) {
  return skipReason(headers, envelopeFrom) !== "";
}

function clean(s) {
  return String(s || "").replace(/[\r\n]+/g, " ").trim();
}

function encodeSubject(s) {
  // RFC 2047 for non-ASCII subjects
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

export function buildReply(headers, to, from = FROM) {
  const origId = clean(headers.get("message-id"));
  const refs = clean(headers.get("references"));
  let subject = clean(headers.get("subject")) || "(no subject)";
  if (!/^re:/i.test(subject)) subject = "Re: " + subject;
  const id = `<${crypto.randomUUID()}@${from.split("@")[1] || DOMAIN}>`;
  const lines = [
    `From: Dibs <${from}>`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Message-ID: ${id}`,
    `Date: ${new Date().toUTCString()}`,
    ...(origId ? [`In-Reply-To: ${origId}`, `References: ${[refs, origId].filter(Boolean).join(" ")}`] : []),
    "Auto-Submitted: auto-replied",
    "X-Auto-Response-Suppress: All",
    "Precedence: auto_reply",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    BODY,
    "",
  ];
  return lines.join("\r\n");
}

export default {
  async email(message) {
    try {
      console.log("autoreply: received", { toDomain: String(message.to).split("@")[1], toIsExpected: ACCEPTED.includes(String(message.to).toLowerCase()), from: mask(message.from), hasMessageId: !!message.headers.get("message-id") });
      const reason = skipReason(message.headers, message.from);
      if (reason) {
        console.log("autoreply: skipped", { reason });
      } else {
        // The reply must come from the address that received the message.
        const replyFrom = String(message.to).trim().toLowerCase();
        const raw = buildReply(message.headers, message.from, replyFrom);
        await message.reply(new EmailMessage(replyFrom, message.from, raw));
        console.log("autoreply: reply sent", { to: mask(message.from) });
      }
    } catch (err) {
      // A failed reply must never bounce the sender or throw.
      console.error("autoreply failed:", err && err.message);
    }
    // Drop: no forwarding anywhere. Returning without forward/reject discards it.
  },
};
