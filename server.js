import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

const port = Number(process.env.PORT || 3001);
const internalApiToken = process.env.INTERNAL_API_TOKEN;
const downstreamUrl = process.env.OPENCLAW_LOCAL_URL;
const downstreamTimeoutMs = Number(process.env.OPENCLAW_LOCAL_TIMEOUT_MS || 15000);
const seenEvents = new Map();
const SEEN_TTL_MS = 10 * 60 * 1000;

function cleanupSeenEvents() {
  const now = Date.now();
  for (const [key, value] of seenEvents.entries()) {
    if (now - value > SEEN_TTL_MS) {
      seenEvents.delete(key);
    }
  }
}

setInterval(cleanupSeenEvents, 60 * 1000).unref();

function isAuthorized(req) {
  if (!internalApiToken) return true;
  const header = req.header('authorization') || '';
  return header === `Bearer ${internalApiToken}`;
}

function buildFallbackReply(body) {
  const source = body?.metadata?.chatType || 'chat';
  const incoming = String(body?.message || '').split('\n').find((line) => line.startsWith('User message: '));
  const userText = incoming ? incoming.replace('User message: ', '').trim() : '';

  if (!userText) {
    return `รับข้อความจาก ${source} แล้ว แต่ local bridge ยังไม่ได้ต่อเข้ากับ OpenClaw จริง`;
  }

  return [
    'รับข้อความแล้วครับ ✨',
    'ตอนนี้ local bridge ทำงานแล้ว แต่ยังต้องต่อ adapter เข้า OpenClaw local อีกชั้นหนึ่ง',
    `ข้อความล่าสุด: ${userText}`,
  ].join('\n');
}

async function callDownstream(body) {
  if (!downstreamUrl) {
    return { reply: buildFallbackReply(body), mode: 'fallback' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), downstreamTimeoutMs);

  try {
    const response = await fetch(downstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(internalApiToken ? { Authorization: `Bearer ${internalApiToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Downstream failed (${response.status}): ${text}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'openclaw-local-bridge',
    downstreamConfigured: Boolean(downstreamUrl),
  });
});

app.post('/line-event', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const body = req.body || {};
  const sessionKey = body?.sessionKey;
  const message = body?.message;
  const eventId = body?.metadata?.eventId;

  if (!sessionKey || !message) {
    return res.status(400).json({ ok: false, error: 'missing sessionKey or message' });
  }

  if (eventId && seenEvents.has(eventId)) {
    return res.json({ ok: true, deduped: true, reply: 'รับ event นี้แล้วก่อนหน้านี้' });
  }

  if (eventId) {
    seenEvents.set(eventId, Date.now());
  }

  try {
    console.log('[local-bridge] inbound', {
      sessionKey,
      eventId,
      chatType: body?.metadata?.chatType,
      chatId: body?.metadata?.chatId,
    });

    const result = await callDownstream(body);
    const reply = result?.reply || result?.text || result?.message;

    if (!reply) {
      return res.status(502).json({ ok: false, error: 'downstream returned no reply' });
    }

    return res.json({
      ok: true,
      reply: String(reply),
      sessionKey,
      eventId,
      forwarded: Boolean(downstreamUrl),
    });
  } catch (error) {
    console.error('[local-bridge] failed', {
      sessionKey,
      eventId,
      message: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.listen(port, () => {
  console.log(`[local-bridge] listening on http://localhost:${port}`);
});
