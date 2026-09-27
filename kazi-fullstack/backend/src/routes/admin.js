const express = require("express");
const router = express.Router();

const { pool } = require("../db");

const DEFAULT_REVENUE_SETTINGS = {
  bookingFeePercent: 5,
  taskerServiceFeePercent: 10,
  paymentMarginPercent: 2,
  cancellationFeePercent: 5,
  insuranceFeePercent: 1,
  partnershipCommissionPercent: 10
};

// Get current revenue settings
router.get("/revenue-settings", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        booking_fee_percent,
        tasker_service_fee_percent,
        payment_margin_percent,
        cancellation_fee_percent,
        insurance_fee_percent,
        partnership_commission_percent
      FROM revenue_settings
      WHERE id = 1
    `);

    if (result.rows.length === 0) {
      return res.json({
        ok: true,
        settings: DEFAULT_REVENUE_SETTINGS
      });
    }

    const row = result.rows[0];

    res.json({
      ok: true,
      settings: {
        bookingFeePercent: Number(row.booking_fee_percent),
        taskerServiceFeePercent: Number(row.tasker_service_fee_percent),
        paymentMarginPercent: Number(row.payment_margin_percent),
        cancellationFeePercent: Number(row.cancellation_fee_percent),
        insuranceFeePercent: Number(row.insurance_fee_percent),
        partnershipCommissionPercent: Number(row.partnership_commission_percent)
      }
    });
  } catch (error) {
    console.error("Failed to get revenue settings:", error);
    res.status(500).json({
      error: "Failed to get revenue settings."
    });
  }
});

// Update revenue settings
router.put("/revenue-settings", async (req, res) => {
  try {
    const allowedFields = [
      "bookingFeePercent",
      "taskerServiceFeePercent",
      "paymentMarginPercent",
      "cancellationFeePercent",
      "insuranceFeePercent",
      "partnershipCommissionPercent"
    ];

    const current = await pool.query(`
      SELECT
        booking_fee_percent,
        tasker_service_fee_percent,
        payment_margin_percent,
        cancellation_fee_percent,
        insurance_fee_percent,
        partnership_commission_percent
      FROM revenue_settings
      WHERE id = 1
    `);

    const existing = current.rows[0] || {};

    const values = {
      bookingFeePercent:
        req.body.bookingFeePercent !== undefined
          ? Number(req.body.bookingFeePercent)
          : Number(existing.booking_fee_percent ?? DEFAULT_REVENUE_SETTINGS.bookingFeePercent),

      taskerServiceFeePercent:
        req.body.taskerServiceFeePercent !== undefined
          ? Number(req.body.taskerServiceFeePercent)
          : Number(existing.tasker_service_fee_percent ?? DEFAULT_REVENUE_SETTINGS.taskerServiceFeePercent),

      paymentMarginPercent:
        req.body.paymentMarginPercent !== undefined
          ? Number(req.body.paymentMarginPercent)
          : Number(existing.payment_margin_percent ?? DEFAULT_REVENUE_SETTINGS.paymentMarginPercent),

      cancellationFeePercent:
        req.body.cancellationFeePercent !== undefined
          ? Number(req.body.cancellationFeePercent)
          : Number(existing.cancellation_fee_percent ?? DEFAULT_REVENUE_SETTINGS.cancellationFeePercent),

      insuranceFeePercent:
        req.body.insuranceFeePercent !== undefined
          ? Number(req.body.insuranceFeePercent)
          : Number(existing.insurance_fee_percent ?? DEFAULT_REVENUE_SETTINGS.insuranceFeePercent),

      partnershipCommissionPercent:
        req.body.partnershipCommissionPercent !== undefined
          ? Number(req.body.partnershipCommissionPercent)
          : Number(existing.partnership_commission_percent ?? DEFAULT_REVENUE_SETTINGS.partnershipCommissionPercent)
    };

    for (const field of allowedFields) {
      if (!Number.isFinite(values[field]) || values[field] < 0 || values[field] > 100) {
        return res.status(400).json({
          error: `${field} must be a number between 0 and 100.`
        });
      }
    }

    await pool.query(`
      INSERT INTO revenue_settings (
        id,
        booking_fee_percent,
        tasker_service_fee_percent,
        payment_margin_percent,
        cancellation_fee_percent,
        insurance_fee_percent,
        partnership_commission_percent,
        updated_at
      )
      VALUES (1, $1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (id)
      DO UPDATE SET
        booking_fee_percent = EXCLUDED.booking_fee_percent,
        tasker_service_fee_percent = EXCLUDED.tasker_service_fee_percent,
        payment_margin_percent = EXCLUDED.payment_margin_percent,
        cancellation_fee_percent = EXCLUDED.cancellation_fee_percent,
        insurance_fee_percent = EXCLUDED.insurance_fee_percent,
        partnership_commission_percent = EXCLUDED.partnership_commission_percent,
        updated_at = now()
    `, [
      values.bookingFeePercent,
      values.taskerServiceFeePercent,
      values.paymentMarginPercent,
      values.cancellationFeePercent,
      values.insuranceFeePercent,
      values.partnershipCommissionPercent
    ]);

    res.json({
      ok: true,
      settings: values
    });
  } catch (error) {
    console.error("Failed to update revenue settings:", error);
    res.status(500).json({
      error: "Failed to update revenue settings."
    });
  }
});

module.exports = router;