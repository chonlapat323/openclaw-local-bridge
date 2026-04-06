# openclaw-local-bridge

Local Bridge API สำหรับรับ request จาก LINE webhook บน Vercel แล้วส่งต่อเข้า OpenClaw local HTTP API

## หน้าที่

- รับ request จาก Vercel ที่ `POST /line-event`
- ตรวจ bearer token ด้วย `INTERNAL_API_TOKEN`
- มี `GET /health`
- dedupe event เบื้องต้น
- ส่งต่อไป OpenClaw ที่ `/v1/chat/completions`
- ส่ง `x-openclaw-session-key` เพื่อให้ context คงอยู่ตาม LINE chat

## Endpoints

- `GET /health`
- `POST /line-event`

## Request contract

รับ payload จาก `linewebhook` แบบนี้:

```json
{
  "sessionKey": "line:user:Uxxx",
  "message": "prompt text...",
  "metadata": {
    "platform": "line",
    "chatType": "dm",
    "chatId": "Uxxx",
    "userId": "Uxxx",
    "eventId": "...",
    "timestamp": 1234567890
  }
}
```

## Response contract

```json
{
  "ok": true,
  "reply": "ข้อความตอบกลับ"
}
```

## Environment variables

คัดลอกจาก `.env.example`

- `PORT=3001`
- `INTERNAL_API_TOKEN=...`
- `OPENCLAW_BASE_URL=http://127.0.0.1:18789`
- `OPENCLAW_GATEWAY_TOKEN=...`
- `OPENCLAW_MODEL=openclaw/default`
- `OPENCLAW_TIMEOUT_MS=60000`

## Run locally

```bash
npm install
npm run dev
```

## Connect to Vercel

ตั้งค่าในโปรเจกต์ `linewebhook` ฝั่ง Vercel:

- `OPENCLAW_BRIDGE_URL=https://your-tunnel-url/line-event`
- `INTERNAL_API_TOKEN=...`

ค่า `INTERNAL_API_TOKEN` ต้องตรงกันทั้งสองฝั่ง

## Important

OpenClaw ฝั่ง local ต้องเปิด HTTP endpoints `chatCompletions` หรืออย่างน้อยต้องให้ `/v1/chat/completions` ใช้งานได้
