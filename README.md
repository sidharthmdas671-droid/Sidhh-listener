# Sidhh Listener — real booking + payment starter

## Run locally
1. Install Node.js 18+.
2. Copy `.env.example` to `.env`.
3. Create Razorpay Test/Live API keys and put them in `.env`.
4. `npm install`
5. `npm start`
6. Open http://localhost:3000

## Production
Deploy this Node app to a host that supports environment variables and HTTPS. Set the same environment variables there. In Razorpay Dashboard configure a webhook URL:
`https://YOUR-DOMAIN/api/webhook`
and subscribe to `order.paid`.

The `/api/bookings` endpoint requires:
`Authorization: Bearer YOUR_ADMIN_TOKEN`

Never put the Razorpay secret in browser JavaScript or commit `.env`.
