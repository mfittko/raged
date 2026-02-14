export function chunkText(text: string, maxChars = 1800): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= maxChars) return [clean];

  const parts: string[] = [];
  let buf = "";
  for (const line of clean.split("\n")) {
    if ((buf + "\n" + line).length > maxChars) {
      if (buf.trim().length) parts.push(buf.trim());
      buf = line;
    } else {
      buf = buf ? (buf + "\n" + line) : line;
    }
  }
  if (buf.trim().length) parts.push(buf.trim());
  return parts;
}
