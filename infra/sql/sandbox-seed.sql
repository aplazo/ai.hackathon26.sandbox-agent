-- SandboxAgent — Golden seed schema + sample data
--
-- This SQL is loaded into the sandboxagent-seed RDS instance ONCE.
-- After it's loaded, we take a snapshot named "sandboxagent-golden-v1"
-- and every per-sandbox RDS gets restored from that snapshot.
--
-- The schema is a minimal, hackathon-grade approximation of what staging
-- might contain. Tables, names, and shapes are simplified — when DevOps
-- copies the real apzdbstg-hackathon-2026-05-20 snapshot, we swap the
-- SnapshotIdentifier and this seed becomes irrelevant.

\set ON_ERROR_STOP on
\connect postgres

-- ---------- 1. Database ----------
DROP DATABASE IF EXISTS aplazo_sandbox;
CREATE DATABASE aplazo_sandbox;
\connect aplazo_sandbox

-- ---------- 2. Schema ----------
CREATE SCHEMA IF NOT EXISTS aplazo;
SET search_path TO aplazo, public;

CREATE TABLE IF NOT EXISTS merchants (
  id              SERIAL PRIMARY KEY,
  external_id     VARCHAR(120) UNIQUE NOT NULL,
  name            VARCHAR(255) NOT NULL,
  integration_type VARCHAR(40) NOT NULL CHECK (integration_type IN ('API','API_OFFLINE')),
  api_token       VARCHAR(120),
  status          VARCHAR(20) NOT NULL DEFAULT 'active',
  customer_fee    NUMERIC(5,4) NOT NULL DEFAULT 0.18,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id           SERIAL PRIMARY KEY,
  external_id  VARCHAR(120) NOT NULL,
  email        VARCHAR(255),
  first_name   VARCHAR(120),
  last_name    VARCHAR(120),
  phone        VARCHAR(20),
  credit_limit NUMERIC(10,2) NOT NULL DEFAULT 10000.00,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (external_id)
);

CREATE TABLE IF NOT EXISTS loans (
  id           SERIAL PRIMARY KEY,
  loan_uuid    VARCHAR(64) UNIQUE NOT NULL,
  merchant_id  INT NOT NULL REFERENCES merchants(id),
  customer_id  INT REFERENCES customers(id),
  total_amount NUMERIC(10,2) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','paid','cancelled')),
  cart_id      VARCHAR(120),
  checkout_url VARCHAR(500),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id         SERIAL PRIMARY KEY,
  loan_id    INT NOT NULL REFERENCES loans(id),
  amount     NUMERIC(10,2) NOT NULL,
  status     VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','successful','failed')),
  paid_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_loans_merchant ON loans(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loans_status   ON loans(status);
CREATE INDEX IF NOT EXISTS idx_payments_loan  ON payments(loan_id);

-- ---------- 3. Sample data (minimal — proves the snapshot works) ----------
INSERT INTO merchants (external_id, name, integration_type, api_token, customer_fee) VALUES
  ('seed_walmart_mx',   'Walmart México',   'API',         'seed-token-walmart',   0.18),
  ('seed_tienda_pos',   'Tienda POS Demo',  'API_OFFLINE', 'seed-token-tiendapos', 0.20),
  ('seed_aliexpress_mx','AliExpress MX',    'API',         'seed-token-aliexpress',0.18);

INSERT INTO customers (external_id, email, first_name, last_name, phone, credit_limit) VALUES
  ('seed_user_1', 'ana@example.com',   'Ana',   'López',   '5512345678', 12000.00),
  ('seed_user_2', 'jorge@example.com', 'Jorge', 'Pérez',   '5523456789',  8000.00),
  ('seed_user_3', 'luis@example.com',  'Luis',  'García',  '5534567890', 15000.00);

INSERT INTO loans (loan_uuid, merchant_id, customer_id, total_amount, status, cart_id) VALUES
  ('seed-loan-001', 1, 1, 1499.00, 'approved', 'seed-cart-001'),
  ('seed-loan-002', 1, 2,  799.50, 'paid',     'seed-cart-002'),
  ('seed-loan-003', 2, 3, 3200.00, 'pending',  'seed-cart-003');

INSERT INTO payments (loan_id, amount, status, paid_at) VALUES
  (2, 799.50, 'successful', NOW() - INTERVAL '2 days'),
  (1, 374.75, 'pending',    NULL),
  (1, 374.75, 'pending',    NULL);

-- ---------- 4. Verification ----------
\echo
\echo '── Counts ──'
SELECT 'merchants' AS table, COUNT(*) AS rows FROM merchants
UNION ALL SELECT 'customers', COUNT(*) FROM customers
UNION ALL SELECT 'loans',     COUNT(*) FROM loans
UNION ALL SELECT 'payments',  COUNT(*) FROM payments;

\echo
\echo '✓ Seed data loaded. Take a snapshot now.'
