// src/mpesa.js
// Wraps Safaricom's Daraja API: OAuth token + Lipa Na M-Pesa Online (STK Push).
// Docs: https://developer.safaricom.co.ke/APIs/MpesaExpressSimulate

const axios = require("axios");

const BASE_URL =
  process.env.MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken;
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  const auth = Buffer.from(`${key}:${secret}`).toString("base64");

  const { data } = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + Number(data.expires_in || 3599) * 1000;
  return cachedToken;
}

function timestampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/** Normalize a Kenyan phone number to Safaricom's 2547XXXXXXXX format. */
function normalizePhone(raw) {
  let p = String(raw).replace(/\D/g, "");
  if (p.startsWith("0")) p = "254" + p.slice(1);
  if (p.startsWith("7") || p.startsWith("1")) p = "254" + p;
  if (!p.startsWith("254")) throw new Error("Invalid Kenyan phone number: " + raw);
  return p;
}

/**
 * Initiate an STK Push — pops a PIN prompt on the payer's phone. Used for
 * every Kazi charge: poster subscription, bidding fee, Pro plan, and a
 * poster paying their tasker once a task is done.
 */
async function stkPush({ phone, amount, accountRef, description }) {
  const token = await getAccessToken();
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const timestamp = timestampNow();
  const password = Buffer.from(shortcode + passkey + timestamp).toString("base64");

  const payload = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.round(amount),
    PartyA: normalizePhone(phone),
    PartyB: shortcode,
    PhoneNumber: normalizePhone(phone),
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: (accountRef || "Kazi").slice(0, 12),
    TransactionDesc: (description || "Kazi payment").slice(0, 13),
  };

  const { data } = await axios.post(
    `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data; // { MerchantRequestID, CheckoutRequestID, ResponseCode, ResponseDescription, CustomerMessage }
}

async function stkQuery(checkoutRequestId) {
  const token = await getAccessToken();
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const timestamp = timestampNow();
  const password = Buffer.from(shortcode + passkey + timestamp).toString("base64");

  const { data } = await axios.post(
    `${BASE_URL}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data;
}

module.exports = { stkPush, stkQuery, normalizePhone };

/*
 * PAYING TASKERS OUT (B2C): this starter only collects money (STK Push /
 * C2B). Actually disbursing a tasker's share is Daraja's separate B2C
 * product, which needs Safaricom to approve B2C on your shortcode plus an
 * encrypted initiator credential — a bigger compliance step (KYC on your
 * business). Add it once you're ready to go live:
 * https://developer.safaricom.co.ke/APIs/BusinessToCustomer
 */
