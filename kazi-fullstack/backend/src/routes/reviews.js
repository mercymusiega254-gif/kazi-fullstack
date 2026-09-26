// src/routes/reviews.js
const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();

router.get("/user/:userId", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, u.name AS from_name FROM reviews r JOIN users u ON u.id = r.from_user_id
     WHERE r.for_user_id = $1 ORDER BY r.created_at DESC`,
    [req.params.userId]
  );
  res.json({ reviews: rows.map((r) => ({
    id: r.id, taskId: r.task_id, forUserId: r.for_user_id, fromUserId: r.from_user_id,
    fromName: r.from_name, rating: r.rating, comment: r.comment, createdAt: r.created_at,
  })) });
});

router.post("/", requireAuth, async (req, res) => {
  const { taskId, forUserId, rating, comment } = req.body || {};
  if (!taskId || !forUserId || !rating) return res.status(400).json({ error: "taskId, forUserId and rating are required." });
  const { rows: taskRows } = await pool.query(`SELECT * FROM tasks WHERE id=$1`, [taskId]);
  const task = taskRows[0];
  if (!task || task.posted_by !== req.userId || task.status !== "completed") {
    return res.status(403).json({ error: "You can only review a completed task you posted." });
  }
  await pool.query(
    `INSERT INTO reviews (task_id, for_user_id, from_user_id, rating, comment) VALUES ($1,$2,$3,$4,$5)`,
    [taskId, forUserId, req.userId, rating, comment || ""]
  );
  await pool.query(
    `UPDATE users SET rating_sum = rating_sum + $1, rating_count = rating_count + 1, completed_tasks = completed_tasks + 1 WHERE id=$2`,
    [rating, forUserId]
  );
  res.json({ ok: true });
});

module.exports = router;
