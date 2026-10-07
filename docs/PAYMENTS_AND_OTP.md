# MAZON Payments + WhatsApp OTP

## Payments
- MAZON UPI ID: ranjaldigal-4@oksbi
- Recommended production path: Razorpay UPI checkout with your merchant account.
- The app creates the payment order on the backend.
- The browser callback is signature-checked.
- Backend payment status can be fetched from Razorpay.
- Configure Razorpay webhooks and verify their HMAC signature using the raw request body before production launch.
- Never mark an order PAID from a customer-entered transaction ID alone.

## WhatsApp OTP
- Use an approved WhatsApp Business sender.
- Create an approved authentication/OTP template in Meta Business Manager.
- Put the template name in WHATSAPP_OTP_TEMPLATE.
- Put the WhatsApp Business phone-number ID and access token in server .env.
- Test with a real verified recipient.
- Never expose the access token in frontend code.
