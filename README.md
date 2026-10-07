# MAZON Launch v4

MAZON is a food-delivery marketplace platform foundation. It is not a copy of proprietary Zepto/Zomato code or branding.

## What is included
- Customer web/PWA ordering
- Customer account/login
- Restaurant dashboard and order workflow
- Delivery partner workflow + GPS location updates
- Admin API/dashboard statistics
- Restaurant/menu creation APIs
- One-restaurant cart protection
- COD + Razorpay checkout flow
- Razorpay payment signature verification endpoint
- Socket.IO realtime order/location events
- GPS browser permission and map view
- SQLite local development database
- PWA manifest + service worker
- Role-based authorization on order workflows
- Order event/audit trail

## Run locally
1. Install Node.js 20+
2. Copy `.env.example` to `.env`
3. Set JWT_SECRET
4. `npm install`
5. `npm start`
6. Open http://localhost:3000

## Production deployment checklist
Before public launch:
1. Replace SQLite with PostgreSQL/Supabase or another managed production database.
2. Use HTTPS and a real domain.
3. Set a long random JWT secret and never commit `.env`.
4. Create a Razorpay merchant account, set production keys, configure webhook signing secret, and verify webhook signatures against the raw request body.
5. Configure Google Maps Platform if you want Google Maps/Places/Routes instead of the included OpenStreetMap fallback. Google Maps production use requires a Google Cloud project/API key and billing setup; restrict the browser key by website. See official docs.
6. Connect an OTP/SMS provider for phone verification.
7. Add push notifications (FCM) for Android/web.
8. Add restaurant KYC, delivery-partner KYC, commission, GST/tax, invoice, refund and cancellation rules.
9. Add rate limiting, secure headers, audit logging, backups and monitoring.
10. Disable/remove `/api/dev/create-admin` before production.
11. Add native Android packaging if you want a Play Store APK/AAB. The PWA can be packaged using a trusted Android wrapper workflow after the production URL is live.
12. Test payment success/failure, duplicate webhooks, cancellation, refunds, delivery reassignment, GPS permissions and offline behavior.

## Important
This package is launch-oriented source code, not a hosted/live marketplace. Real payment, SMS, maps, hosting and production database accounts must belong to you and be configured with your own credentials.

## Google Maps
The app currently includes an OpenStreetMap/Leaflet fallback. Google Maps Platform supports Maps, Places, Geocoding and Routes libraries for web apps. Use a restricted API key in production.


## UPI collection
The default MAZON UPI ID is:
`ranjaldigal-4@oksbi`

The build can generate a UPI intent URI for the customer's UPI app. A UPI intent/QR payment must still be verified before the order is marked `PAID`; the app must never trust a client-side "paid" button.

Razorpay remains available for a verified gateway flow when its production credentials are configured.

## WhatsApp OTP
The login UI now has a WhatsApp OTP flow and backend OTP verification scaffolding. Actual WhatsApp delivery requires an approved WhatsApp Business/API sender and an OTP message template/provider. Provider credentials are kept server-side in `.env`.


## Production payment rule
The app never accepts a browser-side "paid" declaration as proof. Razorpay payment status is queried from the backend, and production webhooks should be configured and signature-verified before final payment reconciliation. Razorpay's security guidance recommends keeping API secrets server-side, HTTPS, signature validation and HMAC-validated webhooks. citeturn0search0turn0search1

## WhatsApp OTP
The build includes a Meta WhatsApp Cloud API adapter. Configure:
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_GRAPH_API_VERSION`
- an approved authentication/OTP template name
- the correct template language

The access token stays on the server. Do not put it in browser JavaScript.
