import 'dotenv/config';
import express from 'express';

function getLineAccessToken() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    throw new Error('Missing LINE_CHANNEL_ACCESS_TOKEN');
  }

  console.log('[local-bridge] line-token-check', {
    exists: true,
    length: token.length,
    prefix: token.slice(0, 8),
  });

  return token;
}

async function pushLineMessage(to, text) {
  const accessToken = getLineAccessToken();
  if (!to) throw new Error('Missing LINE push target');

  console.log('[local-bridge] line-push-request', {
    to,
    textPreview: String(text || '').slice(0, 120),
    textLength: String(text || '').length,
  });

  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to,
      messages: [{ type: 'text', text: text || 'โอ๊ะ มีอะไรบางอย่างไม่ครบ เดี๋ยวลองใหม่อีกทีนะ' }],
    }),
  });

  const raw = await response.text();

  console.log('[local-bridge] line-push-response', {
    ok: response.ok,
    status: response.status,
    preview: raw.slice(0, 300),
  });

  if (!response.ok) {
    throw new Error(`LINE push failed (${response.status}): ${raw}`);
  }

  try {
    return raw ? JSON.parse(raw) : { ok: true };
  } catch {
    return { ok: true, raw };
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

const port = Number(process.env.PORT || 3001);
const internalApiToken = process.env.INTERNAL_API_TOKEN;
const openclawBaseUrl = (process.env.OPENCLAW_BASE_URL || 'http://127.0.0.1:18789').replace(/\/$/, '');
const openclawGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
const openclawModel = process.env.OPENCLAW_MODEL || 'openclaw/default';
const openclawTimeoutMs = Number(process.env.OPENCLAW_TIMEOUT_MS || 20000);
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

async function callOpenClaw(body) {
  if (!openclawGatewayToken) {
    throw new Error('Missing OPENCLAW_GATEWAY_TOKEN');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), openclawTimeoutMs);

  try {
    console.log('[local-bridge] openclaw-request', {
      url: `${openclawBaseUrl}/v1/chat/completions`,
      sessionKey: body.sessionKey,
      model: openclawModel,
      timeoutMs: openclawTimeoutMs,
      hasGatewayToken: Boolean(openclawGatewayToken),
      messagePreview: String(body.message || '').slice(0, 160),
    });

    const response = await fetch(`${openclawBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openclawGatewayToken}`,
        'x-openclaw-session-key': body.sessionKey,
        'x-openclaw-message-channel': 'line',
      },
      body: JSON.stringify({
        model: openclawModel,
        messages: [
          {
            role: 'user',
            content: String(body.message || ''),
          },
        ],
        user: body.sessionKey,
      }),
      signal: controller.signal,
    });

    const text = await response.text();

    console.log('[local-bridge] openclaw-response', {
      ok: response.ok,
      status: response.status,
      preview: text.slice(0, 400),
    });

    if (!response.ok) {
      throw new Error(`OpenClaw failed (${response.status}): ${text}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`OpenClaw returned non-JSON response: ${text.slice(0, 500)}`);
    }

    const reply =
      json?.choices?.[0]?.message?.content ||
      json?.output_text ||
      json?.reply ||
      json?.text ||
      json?.message;

    if (!reply) {
      throw new Error(`OpenClaw returned no reply field: ${text.slice(0, 1000)}`);
    }

    return { reply: String(reply), raw: json };
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/health', async (req, res) => {
  try {
    console.log('[local-bridge] health-check', { openclawBaseUrl });
    const response = await fetch(`${openclawBaseUrl}/health`);
    const health = await response.json().catch(() => ({ ok: false }));

    res.json({
      ok: true,
      service: 'openclaw-local-bridge',
      openclawBaseUrl,
      openclawReachable: response.ok,
      openclawHealth: health,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      service: 'openclaw-local-bridge',
      openclawBaseUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

    const result = await callOpenClaw(body);

    return res.json({
      ok: true,
      reply: result.reply,
      sessionKey,
      eventId,
      forwarded: true,
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

app.post('/line-event-async', (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const body = req.body || {};
  const sessionKey = body?.sessionKey;
  const message = body?.message;
  const eventId = body?.metadata?.eventId;
  const pushTarget = body?.metadata?.pushTarget;

  if (!sessionKey || !message || !pushTarget) {
    return res.status(400).json({ ok: false, error: 'missing sessionKey, message, or metadata.pushTarget' });
  }

  if (eventId && seenEvents.has(eventId)) {
    return res.json({ ok: true, deduped: true, accepted: true });
  }

  if (eventId) {
    seenEvents.set(eventId, Date.now());
  }

  console.log('[local-bridge] accepted-async', {
    sessionKey,
    eventId,
    pushTarget,
  });

  res.status(202).json({ ok: true, accepted: true, sessionKey, eventId });

  setImmediate(async () => {
    try {
      const result = await callOpenClaw(body);
      await pushLineMessage(pushTarget, String(result.reply).slice(0, 5000));
      console.log('[local-bridge] async-push-ok', {
        sessionKey,
        eventId,
        pushTarget,
      });
    } catch (error) {
      console.error('[local-bridge] async-failed', {
        sessionKey,
        eventId,
        pushTarget,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      try {
        await pushLineMessage(pushTarget, 'ตอนนี้แจ่มใสติดอะไรบางอย่างอยู่ ขออีกแป๊บนะ');
        console.log('[local-bridge] async-fallback-push-ok', {
          sessionKey,
          eventId,
          pushTarget,
        });
      } catch (pushError) {
        console.error('[local-bridge] async-fallback-push-failed', {
          sessionKey,
          eventId,
          pushTarget,
          message: pushError instanceof Error ? pushError.message : String(pushError),
          stack: pushError instanceof Error ? pushError.stack : undefined,
        });
      }
    }
  });
});

app.listen(port, () => {
  console.log(`[local-bridge] listening on http://localhost:${port}`);
});
