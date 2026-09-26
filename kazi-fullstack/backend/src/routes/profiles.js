// src/routes/profiles.js
const express = require("express");
const { pool } = require("../db");
const { requireAuth, optionalAuth } = require("../auth");

const router = express.Router();

function publicProfile(row) {
  return {
    id: row.id, name: row.name, bio: row.bio, county: row.county, area: row.area,
    isTasker: row.is_tasker, ratingSum: row.rating_sum, ratingCount: row.rating_count,
    completedTasks: row.completed_tasks,
    posterSubExpiresAt: row.poster_sub_expires_at, proExpiresAt: row.pro_expires_at,
    createdAt: row.created_at,
  };
}

router.get("/:id", optionalAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Profile not found." });
  res.json({ profile: publicProfile(rows[0]) });
});

router.patch("/me", requireAuth, async (req, res) => {
  const { bio, county, area, isTasker } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE users SET bio=COALESCE($1,bio), county=COALESCE($2,county), area=COALESCE($3,area),
     is_tasker=COALESCE($4,is_tasker) WHERE id=$5 RETURNING *`,
    [bio, county, area, typeof isTasker === "boolean" ? isTasker : null, req.userId]
  );
  res.json({ profile: publicProfile(rows[0]) });
});

module.exports = router;
