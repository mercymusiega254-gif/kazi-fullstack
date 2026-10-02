const express = require("express");
const { pool } = require("../db");
const { requireAuth, optionalAuth } = require("../auth");

const router = express.Router();

function publicProfile(row) {
  return {
    id: row.id,
    name: row.name,
    bio: row.bio,
    county: row.county,
    area: row.area,
    isTasker: row.is_tasker,
    ratingSum: row.rating_sum,
    ratingCount: row.rating_count,
    completedTasks: row.completed_tasks,
    posterSubExpiresAt: row.poster_sub_expires_at,
    proExpiresAt: row.pro_expires_at,
    createdAt: row.created_at,
  };
}

function privateProfile(row) {
  return {
    ...publicProfile(row),
    paymentMethods: {
      mpesaPhone: row.mpesa_phone || "",
      bankName: row.bank_name || "",
      bankAccountName: row.bank_account_name || "",
      bankAccountNumber: row.bank_account_number || "",
      paypalEmail: row.paypal_email || "",
      googlePayEmail: row.google_pay_email || "",
    },
  };
}

router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE id=$1`,
    [req.userId]
  );

  if (!rows[0]) {
    return res.status(404).json({ error: "Profile not found." });
  }

  res.json({ profile: privateProfile(rows[0]) });
});

router.get("/:id", optionalAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE id=$1`,
    [req.params.id]
  );

  if (!rows[0]) {
    return res.status(404).json({ error: "Profile not found." });
  }

  res.json({ profile: publicProfile(rows[0]) });
});

router.patch("/me", requireAuth, async (req, res) => {
  const {
    bio,
    county,
    area,
    isTasker,
    paymentMethods
  } = req.body || {};

  const pm = paymentMethods || {};

  const { rows } = await pool.query(
    `UPDATE users SET
      bio=COALESCE($1,bio),
      county=COALESCE($2,county),
      area=COALESCE($3,area),
      is_tasker=COALESCE($4,is_tasker),
      mpesa_phone=COALESCE($5,mpesa_phone),
      bank_name=COALESCE($6,bank_name),
      bank_account_name=COALESCE($7,bank_account_name),
      bank_account_number=COALESCE($8,bank_account_number),
      paypal_email=COALESCE($9,paypal_email),
      google_pay_email=COALESCE($10,google_pay_email)
    WHERE id=$11
    RETURNING *`,
    [
      bio,
      county,
      area,
      typeof isTasker === "boolean" ? isTasker : null,
      pm.mpesaPhone ?? null,
      pm.bankName ?? null,
      pm.bankAccountName ?? null,
      pm.bankAccountNumber ?? null,
      pm.paypalEmail ?? null,
      pm.googlePayEmail ?? null,
      req.userId
    ]
  );

  res.json({ profile: privateProfile(rows[0]) });
});

module.exports = router;