import { parentPort, workerData } from "node:worker_threads";

const SENSITIVE_QUERY_KEY = /(?:^|[-_])(?:access[-_]?token|refresh[-_]?token|token|api[-_]?key|key|secret|password|passwd|auth|authorization|credential|signature|sig)(?:$|[-_])/i;
const MAX_TITLE_CHARS = 512;

function escapeMarkdownLabel(label) {
  return label.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "");
}

function boundedTitle(title) {
  const oneLine = title.replace(/[\r\n\t\0]+/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TITLE_CHARS ? `${oneLine.slice(0, MAX_TITLE_CHARS - 1)}…` : oneLine;
}

function decodeEntities(text) {
  const codePoint = (value, radix) => {
    const point = Number.parseInt(value, radix);
    if (!Number.isFinite(point) || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return "\ufffd";
    return String.fromCodePoint(point);
  };
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_match, value) => codePoint(value, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_match, value) => codePoint(value, 16));
}

function safeUrlForDisplay(url) {
  const display = new URL(url.href);
  display.username = "";
  display.password = "";
  for (const [key] of [...display.searchParams]) {
    if (SENSITIVE_QUERY_KEY.test(key)) display.searchParams.set(key, "[redacted]");
  }
  display.hash = "";
  return display.href;
}

function htmlToMarkdown(html, baseUrl) {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? boundedTitle(decodeEntities(titleMatch[1].trim())) : "";
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|iframe|object|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, "");

  body = body
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi, "\n# $1\n")
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi, "\n## $1\n")
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/gi, "\n### $1\n")
    .replace(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]\s*>/gi, "\n#### $1\n")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_match, content) => `\n\n\`\`\`\n${stripTags(content)}\n\`\`\`\n\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_match, content) => `\`${content}\``)
    .replace(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_match, doubleHref, singleHref, bareHref, content) => {
      const href = doubleHref ?? singleHref ?? bareHref ?? "";
      const label = stripTags(content).trim();
      if (!label || !href) return label;
      try {
        const target = new URL(decodeEntities(href), baseUrl);
        if (target.protocol !== "http:" && target.protocol !== "https:") return label;
        const safeTarget = safeUrlForDisplay(target).replace(/[()]/g, (ch) => ch === "(" ? "%28" : "%29");
        return `[${escapeMarkdownLabel(label)}](${safeTarget})`;
      } catch {
        return label;
      }
    })
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_match, content) => `\n- ${content}\n`)
    .replace(/<(?:p|div|section|article|header|footer|main|aside|nav|tr|br|blockquote|hr)\b[^>]*>/gi, "\n")
    .replace(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi, (_match, content) => `${content} | `);

  const markdown = decodeEntities(stripTags(body))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, markdown };
}

if (!parentPort) throw new Error("HTML conversion worker requires a parent port");
try {
  const result = htmlToMarkdown(workerData.html, new URL(workerData.baseUrl));
  parentPort.postMessage({ ok: true, ...result });
} catch {
  parentPort.postMessage({ ok: false });
} finally {
  parentPort.close();
}
