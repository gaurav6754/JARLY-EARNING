# Jarly backend

Small Express + SQLite API that makes the Jarly mini app's balance and
referral system server-authoritative (the frontend can no longer be edited
in devtools to fake money).

## Setup

```bash
npm install
cp .env.example .env
# edit .env and paste your real bot token from @BotFather
npm start
```

Server listens on `http://localhost:3000` by default. Put it behind HTTPS
(e.g. via nginx/Caddy, or a host like Render/Railway/Fly) — Telegram Mini
Apps must be served over HTTPS.

## How identity binding works

When the mini app opens, the frontend sends Telegram's **signed** `initData`
string (`tg.initData`, not `initDataUnsafe`) to `POST /api/auth`. The server:

1. Recomputes the HMAC-SHA256 signature using your bot token and compares it
   to the one Telegram attached. If it doesn't match, the request is
   rejected — this is what prevents someone from impersonating another
   Telegram user to steal their balance.
2. Creates the user row on first visit ("auto-bind").
3. If the visit came from a referral deep link (`?start=ref_<id>`), and this
   is the user's very first visit, permanently records who referred them.

Every other endpoint (`/api/watch-ad`, `/api/stats`, `/api/withdraw`) also
requires `initData` in the body and re-validates it the same way — so the
client can never claim to be a different user id.

## How the referral bonus works

- `referred_by` is set once, on the referee's first visit, and never changes.
- The referrer is credited **$0.50** the moment the referee completes their
  **3rd ad of any single day** for the first time ever (`referral_bonus_given`
  flag prevents it firing twice).
- This logic lives entirely in `POST /api/watch-ad` — the same request that
  grants the $0.15 ad reward — so it can't be triggered independently by a
  forged client call.

## Bot `/start` handler (deep link → mini app)

You still need your Telegram bot (separate from this API) to open the mini
app with the referral code attached when someone taps a `t.me/YourBot?start=ref_123`
link. Example using `node-telegram-bot-api`:

```js
const TelegramBot = require('node-telegram-bot-api');
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const startParam = match[1] || '';
  bot.sendMessage(msg.chat.id, "Welcome to Jarly! Tap below to start earning:", {
    reply_markup: {
      inline_keyboard: [[
        {
          text: '🫙 Open Jarly',
          web_app: { url: `https://your-domain.com/g.html?start=${startParam}` }
        }
      ]]
    }
  });
});
```

Telegram automatically forwards whatever follows `?start=` into
`initDataUnsafe.start_param` (and into the signed `initData` your server
validates) when the user opens the mini app this way — that's how
`ref_<id>` reaches `/api/auth`.

## Endpoints

| Method | Path            | Body                                          | Notes |
|--------|-----------------|------------------------------------------------|-------|
| POST   | `/api/auth`     | `{ initData }`                                  | Call once on load |
| POST   | `/api/watch-ad` | `{ initData }`                                  | Server grants $0.15, enforces 3/day cap, credits referrer if applicable |
| POST   | `/api/stats`    | `{ initData }`                                  | Poll for updates (e.g. referral bonus from someone else) |
| POST   | `/api/withdraw` | `{ initData, amount, method, destination }`     | Deducts balance, logs a pending withdrawal |

You (or an admin panel) still need to actually pay out `Pending` withdrawals
and mark them `Paid` — that's a manual/admin step this API doesn't automate.
