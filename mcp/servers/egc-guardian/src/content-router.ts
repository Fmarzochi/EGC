export type ContentType = 'json_array' | 'code' | 'log' | 'diff' | 'text';

const CODE_SIGNALS = [
  /^\s*(import|export|const|let|var|function|class|interface|type|async|await|return|from)\b/m,
  /^\s*(def |fn |pub fn |func |package |#include|using namespace)\b/m,
  /[{};]\s*$/m,
];

const LOG_SIGNALS = [
  /\b(ERROR|WARN|INFO|DEBUG|FATAL|TRACE)\b/,
  /^\[?\d{4}-\d{2}-\d{2}/m,
  /\b(at \w+\.\w+\(|Exception|Traceback|stack trace)\b/i,
];

const DIFF_SIGNALS = [
  /^diff --git/m,
  /^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@/m,
  /^[+-]{3} [ab]\//m,
];

function isJsonArray(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null;
  } catch {
    return false;
  }
}

export function detectContentType(chunk: string): ContentType {
  if (isJsonArray(chunk)) return 'json_array';

  for (const re of DIFF_SIGNALS) {
    if (re.test(chunk)) return 'diff';
  }

  let logScore = 0;
  for (const re of LOG_SIGNALS) {
    if (re.test(chunk)) logScore++;
  }
  if (logScore >= 2) return 'log';

  let codeScore = 0;
  for (const re of CODE_SIGNALS) {
    if (re.test(chunk)) codeScore++;
  }
  if (codeScore >= 1) return 'code';

  return 'text';
}
