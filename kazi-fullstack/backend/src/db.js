// src/db.js
// Postgres connection pool + one-time schema setup. Run automatically on
// server start so there's no separate migration step for this MVP — every
// statement is "CREATE ... IF NOT EXISTS", so it's safe to run repeatedly.

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("sslmode=require")
    ? { rejectUnauthorized: false }
    : false,
});

async function initSchema() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      password_hash TEXT NOT NULL,
      is_tasker BOOLEAN NOT NULL DEFAULT false,
      bio TEXT DEFAULT '',
      county TEXT DEFAULT '',
      area TEXT DEFAULT '',
      rating_sum INTEGER NOT NULL DEFAULT 0,
      rating_count INTEGER NOT NULL DEFAULT 0,
      completed_tasks INTEGER NOT NULL DEFAULT 0,
      poster_sub_expires_at TIMESTAMPTZ,
      pro_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      county TEXT NOT NULL,
      area TEXT DEFAULT '',
      budget_type TEXT NOT NULL DEFAULT 'fixed',
      budget NUMERIC NOT NULL,
      due_date DATE,
      status TEXT NOT NULL DEFAULT 'open', -- open | assigned | completed | cancelled
      posted_by UUID NOT NULL REFERENCES users(id),
      assigned_to UUID REFERENCES users(id),
      paid BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS offers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      tasker_id UUID NOT NULL REFERENCES users(id),
      amount NUMERIC NOT NULL,
      message TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      for_user_id UUID NOT NULL REFERENCES users(id),
      from_user_id UUID NOT NULL REFERENCES users(id),
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      from_id UUID NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      checkout_request_id TEXT UNIQUE,
      purpose TEXT NOT NULL, -- poster_sub | pro_sub | bid_fee | task_payment
      user_id UUID NOT NULL REFERENCES users(id),
      amount NUMERIC NOT NULL,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | success | failed
      receipt TEXT,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_offers_task ON offers(task_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reviews_for ON reviews(for_user_id);`);
}

module.exports = { pool, initSchema };
