// src/routes/messages.js
const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();

async function assertParticipant(taskId, userId) {
  const { rows } = await pool.query(`SELECT posted_by, assigned_to FROM tasks WHERE id=$1`, [taskId]);
  const t = rows[0];
  if (!t) return false;
  return t.posted_by === userId || t.assigned_to === userId;
}

router.get("/:taskId", requireAuth, async (req, res) => {
  if (!(await assertParticipant(req.params.taskId, req.userId))) {
    return res.status(403).json({ error: "Not part of this conversation." });
  }
  const { rows } = await pool.query(
    `SELECT m.*, u.name AS from_name FROM messages m JOIN users u ON u.id = m.from_id
     WHERE m.task_id = $1 ORDER BY m.created_at ASC LIMIT 500`,
    [req.params.taskId]
  );
  res.json({ messages: rows.map((m) => ({
    id: m.id, taskId: m.task_id, fromId: m.from_id, fromName: m.from_name, text: m.text, createdAt: m.created_at,
  })) });
});

router.post("/:taskId", requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Message text required." });
  if (!(await assertParticipant(req.params.taskId, req.userId))) {
    return res.status(403).json({ error: "Not part of this conversation." });
  }
  await pool.query(`INSERT INTO messages (task_id, from_id, text) VALUES ($1,$2,$3)`, [req.params.taskId, req.userId, text.trim()]);
  res.json({ ok: true });
});

module.exports = router;
