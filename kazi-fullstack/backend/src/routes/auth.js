// src/routes/auth.js
const express = require("express");
const { pool } = require("../db");
const { hashPassword, checkPassword, signToken, requireAuth } = require("../auth");

const router = express.Router();

function publicUser(row) {
  return {
    id: row.id, name: row.name, email: row.email, phone: row.phone,
    isTasker: row.is_tasker, bio: row.bio, county: row.county, area: row.area,
    ratingSum: row.rating_sum, ratingCount: row.rating_count, completedTasks: row.completed_tasks,
    posterSubExpiresAt: row.poster_sub_expires_at, proExpiresAt: row.pro_expires_at,
  };
}

router.post("/register", async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password are required." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  try {
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name.trim(), email.trim().toLowerCase(), phone || "", hash]
    );
    const user = rows[0];
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "An account with that email already exists." });
    console.error(e);
    res.status(500).json({ error: "Could not create account." });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  const { rows } = await pool.query(`SELECT * FROM users WHERE email=$1`, [email.trim().toLowerCase()]);
  const user = rows[0];
  if (!user || !(await checkPassword(password, user.password_hash))) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.userId]);
  if (!rows[0]) return res.status(404).json({ error: "User not found." });
  res.json({ user: publicUser(rows[0]) });
});

module.exports = { router, publicUser };
