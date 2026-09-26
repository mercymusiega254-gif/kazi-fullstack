// src/routes/tasks.js
const express = require("express");
const { pool } = require("../db");
const { requireAuth, optionalAuth } = require("../auth");

const router = express.Router();
const EARLY_ACCESS_MS = 2 * 60 * 60 * 1000; // Pro taskers see new tasks 2h before everyone else

function isProActive(proExpiresAt) {
  return !!proExpiresAt && new Date(proExpiresAt).getTime() > Date.now();
}
function isPosterSubActive(expiresAt) {
  return !!expiresAt && new Date(expiresAt).getTime() > Date.now();
}
function toTaskJson(t) {
  return {
    id: t.id, title: t.title, description: t.description, category: t.category,
    county: t.county, area: t.area, budgetType: t.budget_type, budget: Number(t.budget),
    dueDate: t.due_date, status: t.status, paid: t.paid,
    postedById: t.posted_by, postedByName: t.posted_by_name,
    assignedToId: t.assigned_to, assignedToName: t.assigned_to_name,
    assigneeIsPro: isProActive(t.assignee_pro),
    createdAt: t.created_at,
  };
}

// Every route below may be called with or without a token, so resolve the
// caller's identity (if any) and Pro status once, up front.
router.use(optionalAuth);
router.use(async (req, res, next) => {
  req._viewerIsPro = false;
  if (req.userId) {
    const { rows } = await pool.query(`SELECT pro_expires_at FROM users WHERE id=$1`, [req.userId]);
    req._viewerIsPro = rows[0] ? isProActive(rows[0].pro_expires_at) : false;
  }
  next();
});

// GET /api/tasks?county=&category=&q=
router.get("/", async (req, res) => {
  const { county, category, q } = req.query;
  const clauses = [];
  const params = [];
  if (county) { params.push(county); clauses.push(`t.county = $${params.length}`); }
  if (category) { params.push(category); clauses.push(`t.category = $${params.length}`); }
  if (q) { params.push(`%${q}%`); clauses.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length})`); }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";

  const { rows } = await pool.query(
    `SELECT t.*, u.name AS posted_by_name, a.name AS assigned_to_name, a.pro_expires_at AS assignee_pro
     FROM tasks t
     JOIN users u ON u.id = t.posted_by
     LEFT JOIN users a ON a.id = t.assigned_to
     ${where}
     ORDER BY t.created_at DESC
     LIMIT 200`,
    params
  );

  // Tasks under 2h old are flagged "locked" for anyone who isn't Pro and isn't
  // the poster — the frontend shows them as a preview with an upgrade prompt
  // rather than a full "send an offer" button.
  const meId = req.userId;
  const out = rows.map((t) => {
    const ageMs = Date.now() - new Date(t.created_at).getTime();
    const inWindow = t.status === "open" && ageMs < EARLY_ACCESS_MS;
    const locked = inWindow && t.posted_by !== meId && !req._viewerIsPro;
    return { ...toTaskJson(t), earlyAccessWindow: inWindow, lockedForMe: locked };
  });
  res.json({ tasks: out });
});

router.get("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*, u.name AS posted_by_name, a.name AS assigned_to_name, a.pro_expires_at AS assignee_pro
     FROM tasks t JOIN users u ON u.id = t.posted_by LEFT JOIN users a ON a.id = t.assigned_to
     WHERE t.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Task not found." });
  const t = rows[0];
  const ageMs = Date.now() - new Date(t.created_at).getTime();
  const inWindow = t.status === "open" && ageMs < EARLY_ACCESS_MS;
  const locked = inWindow && t.posted_by !== req.userId && !req._viewerIsPro;
  res.json({ task: { ...toTaskJson(t), earlyAccessWindow: inWindow, lockedForMe: locked } });
});

// Posting requires an active poster subscription. If the caller doesn't have
// one, the frontend should call POST /api/payments/stk with purpose
// "poster_sub" and the draft task in `meta` — the payment callback creates
// the task once M-Pesa confirms, so this endpoint is only reached once a
// subscription is already active.
router.post("/", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT poster_sub_expires_at FROM users WHERE id=$1`, [req.userId]);
  if (!isPosterSubActive(rows[0] && rows[0].poster_sub_expires_at)) {
    return res.status(402).json({ error: "PAYMENT_REQUIRED", message: "An active poster plan is needed to post a task." });
  }
  const t = req.body || {};
  if (!t.title || !t.description || !t.county || !t.budget) {
    return res.status(400).json({ error: "title, description, county and budget are required." });
  }
  const { rows: created } = await pool.query(
    `INSERT INTO tasks (title, description, category, county, area, budget_type, budget, due_date, posted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [t.title, t.description, t.category || "other", t.county, t.area || "", t.budgetType || "fixed", t.budget, t.dueDate || null, req.userId]
  );
  res.json({ task: toTaskJson({ ...created[0], posted_by_name: req.userName }) });
});

router.post("/:id/accept-offer", requireAuth, async (req, res) => {
  const { offerId } = req.body || {};
  const { rows: taskRows } = await pool.query(`SELECT * FROM tasks WHERE id=$1`, [req.params.id]);
  const task = taskRows[0];
  if (!task) return res.status(404).json({ error: "Task not found." });
  if (task.posted_by !== req.userId) return res.status(403).json({ error: "Only the poster can accept an offer." });

  const { rows: offerRows } = await pool.query(`SELECT * FROM offers WHERE id=$1 AND task_id=$2`, [offerId, req.params.id]);
  const offer = offerRows[0];
  if (!offer) return res.status(404).json({ error: "Offer not found." });

  await pool.query(`UPDATE tasks SET status='assigned', assigned_to=$1 WHERE id=$2`, [offer.tasker_id, req.params.id]);
  await pool.query(`UPDATE offers SET status='accepted' WHERE id=$1`, [offerId]);
  res.json({ ok: true });
});

router.post("/:id/complete", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM tasks WHERE id=$1`, [req.params.id]);
  const task = rows[0];
  if (!task) return res.status(404).json({ error: "Task not found." });
  if (task.posted_by !== req.userId) return res.status(403).json({ error: "Only the poster can mark this complete." });
  await pool.query(`UPDATE tasks SET status='completed' WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// ---- Offers on a task ----
router.get("/:id/offers", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, u.name AS tasker_name, u.pro_expires_at
     FROM offers o JOIN users u ON u.id = o.tasker_id
     WHERE o.task_id = $1
     ORDER BY (u.pro_expires_at IS NOT NULL AND u.pro_expires_at > now()) DESC, o.created_at DESC`,
    [req.params.id]
  );
  res.json({ offers: rows.map((o) => ({
    id: o.id, taskId: o.task_id, taskerId: o.tasker_id, taskerName: o.tasker_name,
    amount: Number(o.amount), message: o.message, status: o.status, createdAt: o.created_at,
    taskerIsPro: isProActive(o.pro_expires_at),
  })) });
});

// Sending an offer costs a KSh 50 bidding fee — same pattern as posting:
// pay via POST /api/payments/stk (purpose "bid_fee"), the callback inserts
// the row. This endpoint exists only to give a clear error if a client tries
// to skip that step.
router.post("/:id/offers", requireAuth, async (req, res) => {
  res.status(402).json({ error: "PAYMENT_REQUIRED", message: "A KSh 50 bidding fee applies to send an offer. Use /api/payments/stk." });
});

module.exports = router;
