// Couche base de données (PostgreSQL) — schéma + requêtes.
// Conçu single-tenant mais "tenant-ready" : chaque objet appartient à un
// routeur ; ajouter un tenant_id plus tard ne demandera pas de réécriture.

import { readFileSync } from "node:fs";
import pg from "pg";
import { config } from "./config.js";

function buildDbSsl() {
  const ca = process.env.DATABASE_CA_CERT;
  if (ca) {
    const pem = ca.includes("BEGIN CERTIFICATE") ? ca : readFileSync(ca, "utf8");
    return { ca: pem };
  }
  if (config.databaseUrl.includes("localhost") || config.databaseUrl.includes("127.0.0.1")) {
    return false;
  }
  if (String(process.env.DATABASE_SSL_INSECURE || "false") === "true") {
    console.warn("[db] ATTENTION : SSL PostgreSQL sans vérification (DATABASE_SSL_INSECURE).");
    return { rejectUnauthorized: false };
  }
  return true;
}

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: buildDbSsl(),
  // Échouer vite plutôt que pendre (offres gratuites : la base s'endort).
  connectionTimeoutMillis: 8000,
  statement_timeout: 8000,
  idle_in_transaction_session_timeout: 8000,
  // Peu de connexions : les offres gratuites (Neon, Supabase) en allouent peu,
  // et la charge ici est faible (quelques routeurs, du polling léger).
  max: Number(process.env.DB_POOL_MAX || 5),
  // Rendre les connexions inactives : une base "serverless" se met en veille,
  // garder des sockets ouvertes ne sert à rien et gêne la reconnexion.
  idleTimeoutMillis: 30000,
});
pool.on("error", (err) => console.error("[db] erreur du pool:", err.message));

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS routers (
      id          SERIAL PRIMARY KEY,
      slug        TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      pull_token  TEXT UNIQUE NOT NULL,
      portal_url  TEXT NOT NULL DEFAULT '',   -- ex: http://lambda.connect/prix.html
      last_seen   TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE routers ADD COLUMN IF NOT EXISTS portal_url TEXT NOT NULL DEFAULT '';
    -- Dernier rapport d'état envoyé par l'agent (identité, version, CPU...).
    ALTER TABLE routers ADD COLUMN IF NOT EXISTS info JSONB;

    -- Sessions hotspot actives, remplacées à chaque rapport de l'agent.
    CREATE TABLE IF NOT EXISTS sessions (
      id          SERIAL PRIMARY KEY,
      router_id   INT NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
      username    TEXT NOT NULL,
      address     TEXT,
      mac         TEXT,
      uptime      TEXT,
      bytes_in    BIGINT DEFAULT 0,
      bytes_out   BIGINT DEFAULT 0,
      time_left   TEXT,
      seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS time_left TEXT;
    CREATE INDEX IF NOT EXISTS sessions_router_idx ON sessions (router_id);

    CREATE TABLE IF NOT EXISTS plans (
      id          SERIAL PRIMARY KEY,
      router_id   INT NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
      code        TEXT NOT NULL,
      label       TEXT NOT NULL,
      price_htg   INT NOT NULL,
      uptime      TEXT NOT NULL,
      shared_users INT NOT NULL DEFAULT 1,
      active      BOOLEAN NOT NULL DEFAULT true,
      UNIQUE (router_id, code)
    );
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS shared_users INT NOT NULL DEFAULT 1;

    -- File de commandes que chaque routeur vient tirer (modèle pull/CGNAT).
    CREATE TABLE IF NOT EXISTS commands (
      id          SERIAL PRIMARY KEY,
      router_id   INT NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
      action      TEXT NOT NULL,             -- 'add' | 'remove'
      payload     JSONB NOT NULL,            -- {code, uptime, comment}
      status      TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | DONE
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      done_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS commands_pending_idx
      ON commands (router_id, id) WHERE status = 'PENDING';

    CREATE TABLE IF NOT EXISTS vouchers (
      id          SERIAL PRIMARY KEY,
      router_id   INT NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
      code        TEXT NOT NULL,
      plan_id     INT REFERENCES plans(id),
      source      TEXT NOT NULL,             -- 'batch' | 'order'
      status      TEXT NOT NULL DEFAULT 'QUEUED', -- QUEUED | ON_ROUTER
      command_id  INT REFERENCES commands(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (router_id, code)
    );

    CREATE TABLE IF NOT EXISTS orders (
      reference           TEXT PRIMARY KEY,
      router_id           INT NOT NULL REFERENCES routers(id),
      plan_id             INT NOT NULL REFERENCES plans(id),
      amount_htg          INTEGER NOT NULL,
      method              TEXT NOT NULL,
      claim_hash          TEXT NOT NULL,
      retrieval_pin       TEXT UNIQUE,
      handoff_hash        TEXT,
      handoff_expires     TIMESTAMPTZ,
      status              TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|PAID|DELIVERED|EXPIRED
      voucher_id          INT REFERENCES vouchers(id),
      paym_transaction_id TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at             TIMESTAMPTZ,
      delivered_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
    CREATE INDEX IF NOT EXISTS orders_handoff_idx
      ON orders (handoff_hash) WHERE handoff_hash IS NOT NULL;
  `);
}

// ---------------------------------------------------------------- routers --
export async function listRouters() {
  const { rows } = await pool.query(
    `SELECT r.*,
            (SELECT count(*) FROM commands c WHERE c.router_id = r.id AND c.status='PENDING') AS pending_commands
       FROM routers r ORDER BY r.id`);
  return rows;
}
export async function getRouter(id) {
  const { rows } = await pool.query(`SELECT * FROM routers WHERE id = $1`, [id]);
  return rows[0] || null;
}
export async function getRouterBySlug(slug) {
  const { rows } = await pool.query(`SELECT * FROM routers WHERE slug = $1`, [slug]);
  return rows[0] || null;
}
export async function getRouterByToken(token) {
  const { rows } = await pool.query(`SELECT * FROM routers WHERE pull_token = $1`, [token]);
  return rows[0] || null;
}
export async function createRouter({ slug, name, pullToken, portalUrl }) {
  const { rows } = await pool.query(
    `INSERT INTO routers (slug, name, pull_token, portal_url) VALUES ($1,$2,$3,$4) RETURNING *`,
    [slug, name, pullToken, portalUrl || ""]);
  return rows[0];
}
export async function touchRouter(id) {
  await pool.query(`UPDATE routers SET last_seen = now() WHERE id = $1`, [id]);
}
export async function updateRouterInfo(id, info) {
  await pool.query(`UPDATE routers SET info = $2, last_seen = now() WHERE id = $1`,
    [id, info]);
}

// Remplace l'instantané des sessions actives d'un routeur (vue "qui est en
// ligne maintenant" — c'est un instantané, pas un historique).
export async function replaceSessions(routerId, rows) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM sessions WHERE router_id = $1`, [routerId]);
    for (const s of rows) {
      await client.query(
        `INSERT INTO sessions (router_id, username, address, mac, uptime, bytes_in, bytes_out, time_left)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [routerId, s.username, s.address, s.mac, s.uptime, s.bytesIn, s.bytesOut, s.timeLeft]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listSessions(routerId) {
  // Le nom d'utilisateur d'une session EST le code du voucher : on remonte
  // ainsi au forfait acheté (durée, nombre d'appareils, prix).
  const { rows } = await pool.query(
    `SELECT s.*, p.label AS plan_label, p.uptime AS plan_uptime,
            p.shared_users, v.source AS voucher_source
       FROM sessions s
       LEFT JOIN vouchers v ON v.router_id = s.router_id AND v.code = s.username
       LEFT JOIN plans p ON p.id = v.plan_id
      WHERE s.router_id = $1
      ORDER BY s.username`, [routerId]);
  return rows;
}

// Met en file une commande brute pour un routeur (ex : suppression d'un code).
export async function queueCommand(routerId, action, payload) {
  const { rows } = await pool.query(
    `INSERT INTO commands (router_id, action, payload) VALUES ($1,$2,$3) RETURNING *`,
    [routerId, action, payload]);
  return rows[0];
}

export async function setVoucherPlan(routerId, voucherId, planId) {
  const { rows } = await pool.query(
    `UPDATE vouchers SET plan_id = $3 WHERE id = $1 AND router_id = $2 RETURNING code`,
    [voucherId, routerId, planId]);
  return rows[0] || null;
}

export async function deleteVoucher(routerId, voucherId) {
  const { rows } = await pool.query(
    `DELETE FROM vouchers WHERE id = $1 AND router_id = $2 RETURNING code`,
    [voucherId, routerId]);
  return rows[0] || null;
}
export async function deleteRouter(id) {
  await pool.query(`DELETE FROM routers WHERE id = $1`, [id]);
}

// ------------------------------------------------------------------ plans --
export async function listPlans(routerId) {
  const { rows } = await pool.query(
    `SELECT * FROM plans WHERE router_id = $1 ORDER BY price_htg`, [routerId]);
  return rows;
}
export async function getPlan(routerId, code) {
  const { rows } = await pool.query(
    `SELECT * FROM plans WHERE router_id = $1 AND code = $2 AND active`, [routerId, code]);
  return rows[0] || null;
}
export async function getPlanById(id) {
  const { rows } = await pool.query(`SELECT * FROM plans WHERE id = $1`, [id]);
  return rows[0] || null;
}
export async function upsertPlan({ routerId, code, label, priceHtg, uptime, sharedUsers }) {
  await pool.query(
    `INSERT INTO plans (router_id, code, label, price_htg, uptime, shared_users)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (router_id, code)
     DO UPDATE SET label=$3, price_htg=$4, uptime=$5, shared_users=$6, active=true`,
    [routerId, code, label, priceHtg, uptime, sharedUsers || 1]);
}
export async function deactivatePlan(routerId, code) {
  await pool.query(
    `UPDATE plans SET active=false WHERE router_id=$1 AND code=$2`, [routerId, code]);
}

export async function activatePlan(routerId, code) {
  await pool.query(
    `UPDATE plans SET active=true WHERE router_id=$1 AND code=$2`, [routerId, code]);
}

// Retire un forfait : suppression réelle s'il n'a jamais servi, sinon simple
// désactivation (des vouchers/ventes le référencent, on ne casse pas l'historique).
// Renvoie 'deleted' ou 'deactivated'.
export async function removePlan(routerId, code) {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM plans WHERE router_id=$1 AND code=$2`, [routerId, code]);
    return rowCount === 1 ? "deleted" : "absent";
  } catch (err) {
    if (String(err.code) === "23503") { // foreign_key_violation
      await deactivatePlan(routerId, code);
      return "deactivated";
    }
    throw err;
  }
}

// --------------------------------------------------- vouchers + commandes --
// Crée un voucher et sa commande de création routeur, atomiquement.
export async function createVoucher({ routerId, code, planId, uptime, source, comment, profile, sharedUsers }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cmd = await client.query(
      `INSERT INTO commands (router_id, action, payload)
       VALUES ($1,'add',$2) RETURNING id`,
      [routerId, {
        code, uptime, comment: comment || "",
        profile: profile || "", shared: sharedUsers || 1,
      }]);
    const v = await client.query(
      `INSERT INTO vouchers (router_id, code, plan_id, source, command_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [routerId, code, planId, source, cmd.rows[0].id]);
    await client.query("COMMIT");
    return v.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
export async function listVouchers(routerId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT v.*, p.label AS plan_label, p.price_htg
       FROM vouchers v LEFT JOIN plans p ON p.id = v.plan_id
      WHERE v.router_id = $1 ORDER BY v.id DESC LIMIT $2`,
    [routerId, limit]);
  return rows;
}
export async function getVouchersByIds(ids) {
  const { rows } = await pool.query(
    `SELECT v.*, p.label AS plan_label, p.price_htg
       FROM vouchers v LEFT JOIN plans p ON p.id = v.plan_id
      WHERE v.id = ANY($1) ORDER BY v.id`, [ids]);
  return rows;
}

// Prochaine commande PENDING pour un routeur (la plus ancienne).
export async function nextCommand(routerId) {
  const { rows } = await pool.query(
    `SELECT * FROM commands
      WHERE router_id = $1 AND status = 'PENDING'
      ORDER BY id LIMIT 1`, [routerId]);
  return rows[0] || null;
}
// Marque une commande faite ; met à jour voucher + ordre liés. Idempotent.
export async function ackCommand(routerId, commandId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const upd = await client.query(
      `UPDATE commands SET status='DONE', done_at=now()
        WHERE id = $1 AND router_id = $2 AND status = 'PENDING'
        RETURNING id`, [commandId, routerId]);
    if (upd.rowCount === 1) {
      const v = await client.query(
        `UPDATE vouchers SET status='ON_ROUTER' WHERE command_id = $1 RETURNING id`,
        [commandId]);
      if (v.rowCount === 1) {
        await client.query(
          `UPDATE orders SET status='DELIVERED', delivered_at=now()
            WHERE voucher_id = $1 AND status = 'PAID'`, [v.rows[0].id]);
      }
    }
    await client.query("COMMIT");
    return upd.rowCount === 1;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------- orders --
export async function createOrder({ reference, routerId, planId, amountHtg, method, claimHash, retrievalPin, transactionId }) {
  await pool.query(
    `INSERT INTO orders (reference, router_id, plan_id, amount_htg, method,
                         claim_hash, retrieval_pin, paym_transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [reference, routerId, planId, amountHtg, method, claimHash, retrievalPin, transactionId]);
}
export async function getOrder(reference) {
  const { rows } = await pool.query(`SELECT * FROM orders WHERE reference = $1`, [reference]);
  return rows[0] || null;
}
export async function getOrderByPin(pin) {
  const { rows } = await pool.query(`SELECT * FROM orders WHERE retrieval_pin = $1`, [pin]);
  return rows[0] || null;
}
export async function getOrderByHandoff(handoffHash) {
  const { rows } = await pool.query(
    `SELECT * FROM orders
      WHERE handoff_hash = $1 AND handoff_expires IS NOT NULL AND handoff_expires > now()`,
    [handoffHash]);
  return rows[0] || null;
}
export async function setHandoff(reference, handoffHash, expiresAt) {
  await pool.query(
    `UPDATE orders SET handoff_hash = $2, handoff_expires = $3 WHERE reference = $1`,
    [reference, handoffHash, expiresAt]);
}
// Réclamation ATOMIQUE PENDING -> PAID (un seul gagnant).
export async function claimPaid(reference, transactionId) {
  const { rowCount } = await pool.query(
    `UPDATE orders SET status='PAID', paid_at=now(),
            paym_transaction_id = COALESCE(paym_transaction_id, $2)
      WHERE reference = $1 AND status = 'PENDING'`,
    [reference, transactionId]);
  return rowCount === 1;
}
export async function attachVoucherToOrder(reference, voucherId) {
  await pool.query(
    `UPDATE orders SET voucher_id = $2 WHERE reference = $1`, [reference, voucherId]);
}
export async function getPendingOrders() {
  const { rows } = await pool.query(
    `SELECT * FROM orders
      WHERE status = 'PENDING'
        AND created_at > now() - ($1 || ' minutes')::interval`,
    [config.orderExpiryMinutes]);
  return rows;
}
export async function expireOrder(reference) {
  await pool.query(
    `UPDATE orders SET status='EXPIRED' WHERE reference = $1 AND status = 'PENDING'`,
    [reference]);
}
export async function getVoucherById(id) {
  const { rows } = await pool.query(`SELECT * FROM vouchers WHERE id = $1`, [id]);
  return rows[0] || null;
}
export async function listOrders(limit = 200) {
  const { rows } = await pool.query(
    `SELECT o.*, r.name AS router_name, p.label AS plan_label,
            v.code AS voucher_code
       FROM orders o
       JOIN routers r ON r.id = o.router_id
       JOIN plans p ON p.id = o.plan_id
       LEFT JOIN vouchers v ON v.id = o.voucher_id
      ORDER BY o.created_at DESC LIMIT $1`, [limit]);
  return rows;
}
export async function salesSummary() {
  const { rows } = await pool.query(
    `SELECT r.name AS router_name,
            count(*) FILTER (WHERE o.status IN ('PAID','DELIVERED')) AS paid_count,
            COALESCE(sum(o.amount_htg) FILTER (WHERE o.status IN ('PAID','DELIVERED')), 0) AS total_htg
       FROM orders o JOIN routers r ON r.id = o.router_id
      GROUP BY r.name ORDER BY total_htg DESC`);
  return rows;
}

export { pool };
