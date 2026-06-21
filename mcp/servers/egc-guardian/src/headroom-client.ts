import os from 'os';
import fs from 'fs';
import path from 'path';

const PROBE_TIMEOUT_MS = 3_000;

function resolveBaseUrl(): string {
  const env = process.env.HEADROOM_URL;
  if (env) return env.replace(/\/$/, '');

  const cfgPath = path.join(os.homedir(), '.headroom', 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.proxy_url) return String(cfg.proxy_url).replace(/\/$/, '');
    } catch {
      // malformed config — fall through to default
    }
  }

  return 'http://localhost:8787';
}

export interface HeadroomResult {
  text: string;
  bytes_before: number;
  bytes_after: number;
  compression_ratio: number;
  transforms_applied: string[];
}

export async function compressViaHeadroom(
  chunks: string[],
  baseUrl: string = resolveBaseUrl(),
): Promise<HeadroomResult | null> {
  if (chunks.length === 0) return null;

  const bytesBefore = chunks.reduce((a, c) => a + Buffer.byteLength(c, 'utf8'), 0);

  const messages = chunks.map((chunk) => ({ role: 'user', content: chunk }));

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    res = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Headroom-Stack': 'egc-guardian' },
      body: JSON.stringify({ messages, model: 'claude-sonnet-4-6' }),
      signal: controller.signal,
    });

    clearTimeout(timer);
  } catch {
    return null;
  }

  if (!res.ok) return null;

  let data: {
    messages: Array<{ role: string; content?: string }>;
    tokens_before?: number;
    tokens_after?: number;
    compression_ratio?: number;
    transforms_applied?: string[];
  };
  try {
    data = await res.json() as typeof data;
  } catch {
    return null;
  }

  const compressedText = (data.messages ?? [])
    .map((m) => m.content ?? '')
    .filter(Boolean)
    .join('\n\n');

  const bytesAfter = Buffer.byteLength(compressedText, 'utf8');

  if (bytesAfter >= bytesBefore) return null;

  return {
    text: compressedText,
    bytes_before: bytesBefore,
    bytes_after: bytesAfter,
    compression_ratio: data.compression_ratio ?? (bytesBefore === 0 ? 1 : bytesAfter / bytesBefore),
    transforms_applied: data.transforms_applied ?? [],
  };
}
