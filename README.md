# openclaw-local-bridge

Local Bridge API สำหรับรับ request จาก LINE webhook บน Vercel แล้วส่งต่อเข้าระบบ OpenClaw local อีกชั้นหนึ่ง

## หน้าที่

- รับ request จาก Vercel ที่ `POST /line-event`
- ตรวจ bearer token ด้วย `INTERNAL_API_TOKEN`
- มี `GET /health`
- dedupe event เบื้องต้น
- ส่งต่อไป downstream local service ได้ถ้าตั้ง `OPENCLAW_LOCAL_URL`
- มี fallback reply ถ้ายังไม่ได้เสียบ OpenClaw adapter จริง

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

ตอบกลับอย่างน้อยหนึ่งฟิลด์ต่อไปนี้:

```json
{
  "ok": true,
  "reply": "ข้อความตอบกลับ"
}
```

หรือจะเป็น `text` / `message` ก็ได้

## Run locally

```bash
npm install
npm run dev
```

## Environment variables

คัดลอกจาก `.env.example`

- `PORT=3001`
- `INTERNAL_API_TOKEN=...`
- `OPENCLAW_LOCAL_URL=`
- `OPENCLAW_LOCAL_TIMEOUT_MS=15000`

## Connect to Vercel

ตั้งค่าในโปรเจกต์ `linewebhook` ฝั่ง Vercel:

- `OPENCLAW_BRIDGE_URL=https://your-tunnel-url/line-event`
- `INTERNAL_API_TOKEN=...`

ค่า `INTERNAL_API_TOKEN` ต้องตรงกันทั้งสองฝั่ง

## Important

ตอนนี้ bridge นี้ยังไม่ได้ยิงเข้า OpenClaw runtime จริงอัตโนมัติถ้าคุณยังไม่มี downstream adapter ปลายทาง
แต่โครงสร้างพร้อมแล้วสำหรับแยกเป็น repo ใหม่บน GitHub
