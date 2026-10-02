// src/routes/tasks.js
const express = require("express");
const { pool } = require("../db");
const { requireAuth, optionalAuth } = require("../auth");

const router = express.Router();

const EARLY_ACCESS_MS = 2 * 60 * 60 * 1000;
// Pro taskers can see new tasks 2 hours before everyone else.

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function isProActive(proExpiresAt) {
  return !!proExpiresAt && new Date(proExpiresAt).getTime() > Date.now();
}

function toTaskJson(t) {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    category: t.category,
    county: t.county,
    area: t.area,
    budgetType: t.budget_type,
    budget: Number(t.budget),
    dueDate: t.due_date,
    status: t.status,
    paid: t.paid,
    postedById: t.posted_by,
    postedByName: t.posted_by_name,
    assignedToId: t.assigned_to,
    assignedToName: t.assigned_to_name,
    assigneeIsPro: isProActive(t.assignee_pro),
    createdAt: t.created_at
  };
}

// --------------------------------------------------
// AUTH / VIEWER STATUS
// --------------------------------------------------

router.use(optionalAuth);

router.use(async (req, res, next) => {
  try {
    req._viewerIsPro = false;

    if (req.userId) {
      const { rows } = await pool.query(
        `SELECT pro_expires_at FROM users WHERE id = $1`,
        [req.userId]
      );
      req._viewerIsPro = !!(rows[0] && isProActive(rows[0].pro_expires_at));
    }

    next();
  } catch (err) {
    console.error("Viewer status error:", err);
    next(err);
  }
});

// --------------------------------------------------
// GET ALL TASKS
// GET /api/tasks
// --------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const { county, category, q } = req.query;

    const clauses = [];
    const params = [];

    if (county) {
      params.push(county);
      clauses.push(`t.county = $${params.length}`);
    }

    if (category) {
      params.push(category);
      clauses.push(`t.category = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      clauses.push(
        `(t.title ILIKE $${params.length}
          OR t.description ILIKE $${params.length})`
      );
    }

    const where = clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";

    const { rows } = await pool.query(
      `SELECT
         t.*,
         u.name AS posted_by_name,
         a.name AS assigned_to_name,
         a.pro_expires_at AS assignee_pro
       FROM tasks t
       JOIN users u ON u.id = t.posted_by
       LEFT JOIN users a ON a.id = t.assigned_to
       ${where}
       ORDER BY t.created_at DESC
       LIMIT 200`,
      params
    );

    const meId = req.userId;

    const tasks = rows.map((t) => {
      const ageMs = Date.now() - new Date(t.created_at).getTime();
      const inWindow = t.status === "open" && ageMs < EARLY_ACCESS_MS;
      const locked = inWindow && t.posted_by !== meId && !req._viewerIsPro;

      return {
        ...toTaskJson(t),
        earlyAccessWindow: inWindow,
        lockedForMe: locked
      };
    });

    res.json({ tasks });
  } catch (err) {
    console.error("GET /api/tasks error:", err);
    res.status(500).json({ error: "Could not load tasks." });
  }
});

// --------------------------------------------------
// GET ONE TASK
// GET /api/tasks/:id
// --------------------------------------------------

router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         t.*,
         u.name AS posted_by_name,
         a.name AS assigned_to_name,
         a.pro_expires_at AS assignee_pro
       FROM tasks t
       JOIN users u ON u.id = t.posted_by
       LEFT JOIN users a ON a.id = t.assigned_to
       WHERE t.id = $1`,
      [req.params.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "Task not found." });
    }

    const t = rows[0];
    const ageMs = Date.now() - new Date(t.created_at).getTime();
    const inWindow = t.status === "open" && ageMs < EARLY_ACCESS_MS;
    const locked = inWindow && t.posted_by !== req.userId && !req._viewerIsPro;

    res.json({
      task: {
        ...toTaskJson(t),
        earlyAccessWindow: inWindow,
        lockedForMe: locked
      }
    });
  } catch (err) {
    console.error("GET /api/tasks/:id error:", err);
    res.status(500).json({ error: "Could not load task." });
  }
});

// --------------------------------------------------
// CREATE TASK
// POST /api/tasks
//
// Posting a task is free. No subscription needed.
// --------------------------------------------------

router.post("/", requireAuth, async (req, res) => {
  try {
    const t = req.body || {};

    if (!t.title || !t.description || !t.county || !t.budget) {
      return res.status(400).json({
        error: "title, description, county and budget are required."
      });
    }

    const { rows: created } = await pool.query(
      `INSERT INTO tasks (
         title, description, category, county, area,
         budget_type, budget, due_date, posted_by
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        t.title,
        t.description,
        t.category || "other",
        t.county,
        t.area || "",
        t.budgetType || "fixed",
        t.budget,
        t.dueDate || null,
        req.userId
      ]
    );

    res.status(201).json({
      task: toTaskJson({
        ...created[0],
        posted_by_name: req.userName,
        assigned_to_name: null,
        assignee_pro: null
      })
    });
  } catch (err) {
    console.error("POST /api/tasks error:", err);
    res.status(500).json({ error: "Could not create task." });
  }
});

// --------------------------------------------------
// ACCEPT OFFER
// POST /api/tasks/:id/accept-offer
// --------------------------------------------------

router.post("/:id/accept-offer", requireAuth, async (req, res) => {
  try {
    const { offerId } = req.body || {};

    if (!offerId) {
      return res.status(400).json({ error: "offerId is required." });
    }

    const { rows: taskRows } = await pool.query(
      `SELECT * FROM tasks WHERE id = $1`,
      [req.params.id]
    );

    const task = taskRows[0];

    if (!task) {
      return res.status(404).json({ error: "Task not found." });
    }

    if (task.posted_by !== req.userId) {
      return res.status(403).json({ error: "Only the poster can accept an offer." });
    }

    const { rows: offerRows } = await pool.query(
      `SELECT * FROM offers WHERE id = $1 AND task_id = $2`,
      [offerId, req.params.id]
    );

    const offer = offerRows[0];

    if (!offer) {
      return res.status(404).json({ error: "Offer not found." });
    }

    await pool.query(
      `UPDATE tasks SET status = 'assigned', assigned_to = $1 WHERE id = $2`,
      [offer.tasker_id, req.params.id]
    );

    await pool.query(
      `UPDATE offers SET status = 'accepted' WHERE id = $1`,
      [offerId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/tasks/:id/accept-offer error:", err);
    res.status(500).json({ error: "Could not accept offer." });
  }
});

// --------------------------------------------------
// COMPLETE TASK
// POST /api/tasks/:id/complete
// --------------------------------------------------

router.post("/:id/complete", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM tasks WHERE id = $1`,
      [req.params.id]
    );

    const task = rows[0];

    if (!task) {
      return res.status(404).json({ error: "Task not found." });
    }

    if (task.posted_by !== req.userId) {
      return res.status(403).json({ error: "Only the poster can mark this complete." });
    }

    await pool.query(
      `UPDATE tasks SET status = 'completed' WHERE id = $1`,
      [req.params.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/tasks/:id/complete error:", err);
    res.status(500).json({ error: "Could not complete task." });
  }
});

// --------------------------------------------------
// GET OFFERS FOR TASK
// GET /api/tasks/:id/offers
// --------------------------------------------------

router.get("/:id/offers", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         o.*,
         u.name AS tasker_name,
         u.pro_expires_at
       FROM offers o
       JOIN users u ON u.id = o.tasker_id
       WHERE o.task_id = $1
       ORDER BY
         (
           u.pro_expires_at IS NOT NULL
           AND u.pro_expires_at > now()
         ) DESC,
         o.created_at DESC`,
      [req.params.id]
    );

    res.json({
      offers: rows.map((o) => ({
        id: o.id,
        taskId: o.task_id,
        taskerId: o.tasker_id,
        taskerName: o.tasker_name,
        amount: Number(o.amount),
        message: o.message,
        status: o.status,
        createdAt: o.created_at,
        taskerIsPro: isProActive(o.pro_expires_at)
      }))
    });
  } catch (err) {
    console.error("GET /api/tasks/:id/offers error:", err);
    res.status(500).json({ error: "Could not load offers." });
  }
});

// --------------------------------------------------
// SEND OFFER
// POST /api/tasks/:id/offers
//
// Sending an offer is free. Sending again on the same task updates
// your earlier offer instead of creating a duplicate.
// --------------------------------------------------

router.post("/:id/offers", requireAuth, async (req, res) => {
  try {
    const amount = Number((req.body || {}).amount);
    const message = String((req.body || {}).message || "").slice(0, 1000);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Enter a valid offer amount." });
    }

    const { rows: taskRows } = await pool.query(
      `SELECT * FROM tasks WHERE id = $1`,
      [req.params.id]
    );
    const task = taskRows[0];

    if (!task) {
      return res.status(404).json({ error: "Task not found." });
    }

    if (task.posted_by === req.userId) {
      return res.status(400).json({ error: "You can't make an offer on your own task." });
    }

    if (task.status !== "open") {
      return res.status(400).json({ error: "This task is no longer open for offers." });
    }

    // Pro early-access window: only Pro taskers can bid in the first 2 hours.
    const ageMs = Date.now() - new Date(task.created_at).getTime();
    if (ageMs < EARLY_ACCESS_MS && !req._viewerIsPro) {
      return res.status(403).json({
        error: "This task is still in its Pro early-access window."
      });
    }

    const { rows: existing } = await pool.query(
      `SELECT id, status FROM offers WHERE task_id = $1 AND tasker_id = $2`,
      [req.params.id, req.userId]
    );

    if (existing[0]) {
      if (existing[0].status === "accepted") {
        return res.status(400).json({ error: "Your offer was already accepted." });
      }
      const { rows: updated } = await pool.query(
        `UPDATE offers SET amount = $1, message = $2 WHERE id = $3 RETURNING *`,
        [amount, message, existing[0].id]
      );
      return res.json({ ok: true, offer: updated[0] });
    }

    const { rows: created } = await pool.query(
      `INSERT INTO offers (task_id, tasker_id, amount, message)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.params.id, req.userId, amount, message]
    );

    res.status(201).json({ ok: true, offer: created[0] });
  } catch (err) {
    console.error("POST /api/tasks/:id/offers error:", err);
    res.status(500).json({ error: "Could not send offer." });
  }
});

// --------------------------------------------------
// EXPORT
// --------------------------------------------------

module.exports = router;
