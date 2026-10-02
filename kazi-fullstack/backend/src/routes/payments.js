// src/routes/payments.js
// Two kinds of M-Pesa charge are left in Kazi:
//   pro_sub      - KSh 250/mo, tasker priority   (meta = {})
//   task_payment - poster pays the assigned tasker once a task is done (meta = {taskId})
//
// Posting a task and sending an offer are free, so they no longer go
// through M-Pesa.
//
// The DB write for each charge (extending a subscription, marking a task
// paid) only happens once Safaricom's callback confirms success, never
// optimistically before payment.

const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../auth");
const { stkPush, stkQuery } = require("../mpesa");

const router = express.Router();

const FEES = {
  pro_sub: Number(process.env.FEE_PRO_SUB || 250),
};

router.post("/stk", requireAuth, async (req, res) => {
  const { purpose, phone, meta } = req.body || {};
  if (!["pro_sub", "task_payment"].includes(purpose)) {
    return res.status(400).json({ error: "Invalid purpose." });
  }
  if (!phone) return res.status(400).json({ error: "Phone number required." });

  let amount, description, accountRef = "Kazi";

  if (purpose === "task_payment") {
    const { rows } = await pool.query(`SELECT * FROM tasks WHERE id=$1`, [(meta || {}).taskId]);
    const task = rows[0];
    if (!task) return res.status(404).json({ error: "Task not found." });
    if (task.posted_by !== req.userId) return res.status(403).json({ error: "Only the poster can pay for this task." });
    if (task.status !== "completed") return res.status(400).json({ error: "Task isn't marked completed yet." });
    amount = Number(task.budget);
    description = "Kazi task payment";
    accountRef = task.id.slice(0, 8);
  } else {
    amount = FEES[purpose];
    description = "Kazi Pro plan";
  }

  try {
    const result = await stkPush({ phone, amount, accountRef, description });
    if (result.ResponseCode !== "0") {
      return res.status(502).json({ error: result.ResponseDescription || "STK push failed." });
    }
    await pool.query(
      `INSERT INTO payments (checkout_request_id, purpose, user_id, amount, phone, meta) VALUES ($1,$2,$3,$4,$5,$6)`,
      [result.CheckoutRequestID, purpose, req.userId, amount, phone, JSON.stringify(meta || {})]
    );
    res.json({ ok: true, checkoutRequestId: result.CheckoutRequestID, message: result.CustomerMessage });
  } catch (err) {
    console.error("STK push error:", err.response ? err.response.data : err.message);
    res.status(500).json({ error: "Could not start M-Pesa payment." });
  }
});

// Safaricom calls this - no auth (Safaricom can't send your JWT), so it must
// stay narrowly scoped to just recording the result and running the matching
// finalize step below.
router.post("/callback", async (req, res) => {
  const cb = req.body && req.body.Body && req.body.Body.stkCallback;
  if (!cb) return res.sendStatus(400);

  const { rows } = await pool.query(`SELECT * FROM payments WHERE checkout_request_id=$1`, [cb.CheckoutRequestID]);
  const payment = rows[0];
  if (!payment) return res.json({ ResultCode: 0, ResultDesc: "Accepted" }); // unknown ref - ack anyway

  if (cb.ResultCode === 0) {
    const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
    const get = (name) => (items.find((i) => i.Name === name) || {}).Value;
    const receipt = get("MpesaReceiptNumber");
    await pool.query(`UPDATE payments SET status='success', receipt=$1 WHERE id=$2`, [receipt, payment.id]);
    await finalizePayment(payment);
  } else {
    await pool.query(`UPDATE payments SET status='failed' WHERE id=$1`, [payment.id]);
  }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

async function finalizePayment(payment) {
  const meta = payment.meta || {};
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  if (payment.purpose === "pro_sub") {
    await pool.query(`UPDATE users SET pro_expires_at=$1, is_tasker=true WHERE id=$2`, [in30Days, payment.user_id]);
  } else if (payment.purpose === "task_payment") {
    await pool.query(`UPDATE tasks SET paid=true WHERE id=$1`, [meta.taskId]);
  }
  // Older payment rows with purpose poster_sub or bid_fee (from before those
  // fees were removed) are simply ignored here.
}

// Frontend polls this while waiting for the callback to land.
router.get("/status/:checkoutRequestId", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM payments WHERE checkout_request_id=$1 AND user_id=$2`, [req.params.checkoutRequestId, req.userId]);
  const payment = rows[0];
  if (!payment) return res.status(404).json({ error: "Payment not found." });
  if (payment.status !== "pending") {
    return res.json({ status: payment.status, receipt: payment.receipt });
  }
  // Callback hasn't arrived yet - ask Safaricom directly as a fallback.
  try {
    const q = await stkQuery(req.params.checkoutRequestId);
    if (q.ResultCode === "0") {
      await pool.query(`UPDATE payments SET status='success' WHERE id=$1`, [payment.id]);
      await finalizePayment(payment);
      return res.json({ status: "success" });
    }
  } catch (e) {}
  res.json({ status: "pending" });
});

module.exports = router;
