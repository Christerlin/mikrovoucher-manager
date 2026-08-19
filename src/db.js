// Couche base de données (PostgreSQL) — schéma + requêtes.
// Conçu single-tenant mais "tenant-ready" : chaque objet appartient à un
// routeur ; ajouter un tenant_id plus tard ne demandera pas de réécriture.

import { readFileSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import pg from "pg";
import { config } from "./config.js";
import { durationToSeconds, generateRouterToken } from "./codes.js";

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
    -- Dossier du portail sur le routeur. Varie selon le modele (avec ou sans
    -- flash) : verifiable par /file print sur le routeur concerne.
    ALTER TABLE routers ADD COLUMN IF NOT EXISTS portal_dir TEXT NOT NULL DEFAULT 'hotspot';
    -- Essai gratuit : duree offerte / delai avant qu'un appareil y ait droit
    -- a nouveau. Regle depuis le dashboard, applique au routeur par l'agent.
    ALTER TABLE routers ADD COLUMN IF NOT EXISTS trial_limit TEXT NOT NULL DEFAULT '5m';
    ALTER TABLE routers ADD COLUMN IF NOT EXISTS trial_reset TEXT NOT NULL DEFAULT '1d';

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
      rate_limit  TEXT NOT NULL DEFAULT '',
      -- Validité en secondes à partir de la PREMIÈRE connexion. C'est elle qui
      -- fait foi : limit-uptime seul ne compte que le temps réellement connecté,
      -- donc un forfait "30 jours" pouvait durer des mois.
      validity_seconds INT NOT NULL DEFAULT 0,
      active      BOOLEAN NOT NULL DEFAULT true,
      UNIQUE (router_id, code)
    );
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS shared_users INT NOT NULL DEFAULT 1;
    -- Débit RouterOS "montant/descendant" (ex : 1M/5M). Vide = illimité.
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS rate_limit TEXT NOT NULL DEFAULT '';
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS validity_seconds INT NOT NULL DEFAULT 0;

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

    -- Fichiers du portail captif, pousses sur le routeur par l'agent.
    -- Stockes en base et non sur disque : l'hebergeur peut recycler le
    -- conteneur a tout moment, un fichier ecrit sur disque disparaitrait.
    CREATE TABLE IF NOT EXISTS portal_files (
      id          SERIAL PRIMARY KEY,
      router_id   INT NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
      path        TEXT NOT NULL,             -- relatif au dossier du hotspot
      content     BYTEA NOT NULL,
      bytes       INT NOT NULL,
      pushed_at   TIMESTAMPTZ,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (router_id, path)
    );

    -- Sponsors : commerces du quartier qui paient une place sur le portail.
    -- Ce qui se vend ici n'est pas de l'impression au mille, c'est l'attention
    -- des gens du coin ; d'ou des dates de contrat et des compteurs, qui
    -- servent a renouveler.
    -- Comptes du dashboard. Avant, un seul mot de passe partage vivait dans
    -- les variables d'environnement : impossible de savoir qui avait fait
    -- quoi, et impossible de confier la vente a quelqu'un sans lui ouvrir
    -- les finances.
    -- Un client du service : l'operateur qui vend du WiFi sur ses routeurs.
    -- Tout objet appartient a un routeur, et tout routeur a un locataire :
    -- c'est la seule chose qui separe deux clients.
    CREATE TABLE IF NOT EXISTS tenants (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      slug          TEXT NOT NULL UNIQUE,
      active        BOOLEAN NOT NULL DEFAULT true,
      -- 'direct' : l'operateur pose ses propres identifiants Pay'm, l'argent
      -- va chez lui sans nous passer entre les mains. 'central' (encaissement
      -- par nos soins puis reversement) est prevu par le schema mais pas
      -- implemente : il ferait de nous un transmetteur de fonds.
      payout_mode   TEXT NOT NULL DEFAULT 'direct',
      paym_client_id     TEXT,
      paym_client_secret TEXT,
      -- Repli sur les variables d'environnement, reserve au locataire issu de
      -- l'installation d'origine : sans ce verrou, un nouveau client qui n'a
      -- pas encore pose ses identifiants encaisserait sur NOTRE compte, en
      -- silence. C'est la pire panne possible de ce systeme.
      paym_from_env      BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL DEFAULT '',
      pass_hash     TEXT NOT NULL,      -- scrypt : sel:cle, en hexadecimal
      role          TEXT NOT NULL DEFAULT 'vendeur',  -- owner | vendeur
      active        BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login    TIMESTAMPTZ,
      -- L'exploitant du service lui-meme : il gere les organisations et les
      -- invitations. Distinct du proprietaire d'une organisation, qui ne voit
      -- que la sienne.
      platform_admin BOOLEAN NOT NULL DEFAULT false
    );

    -- Inscription sur invitation. Une inscription ouverte a tout venant
    -- laisserait n'importe qui creer des organisations sur le service ; les
    -- premiers operateurs se recrutent de toute facon un par un.
    CREATE TABLE IF NOT EXISTS invitations (
      token       TEXT PRIMARY KEY,
      note        TEXT NOT NULL DEFAULT '',
      created_by  INT REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      tenant_id   INT REFERENCES tenants(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS sponsors (
      id          SERIAL PRIMARY KEY,
      router_id   INT NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      baseline    TEXT NOT NULL DEFAULT '',
      contact     TEXT NOT NULL DEFAULT '',   -- telephone ou lien
      image_path  TEXT NOT NULL DEFAULT '',   -- chemin dans le portail
      placement   TEXT NOT NULL DEFAULT 'login', -- login | trial | both
      starts_on   DATE,
      ends_on     DATE,
      active      BOOLEAN NOT NULL DEFAULT true,
      views       BIGINT NOT NULL DEFAULT 0,
      clicks      BIGINT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS vouchers (
      id          SERIAL PRIMARY KEY,
      router_id   INT NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
      code        TEXT NOT NULL,
      plan_id     INT REFERENCES plans(id),
      source      TEXT NOT NULL,             -- 'batch' | 'order'
      status      TEXT NOT NULL DEFAULT 'QUEUED', -- QUEUED | ON_ROUTER
      command_id  INT REFERENCES commands(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Première utilisation constatée sur le routeur. Pour un voucher vendu
      -- en espèces, c'est le meilleur indice qu'il a bien été vendu.
      used_at     TIMESTAMPTZ,
      used_uptime TEXT,
      used_bytes  BIGINT DEFAULT 0,
      UNIQUE (router_id, code)
    );
    -- Recharges cumulees sur ce code : le client prolonge son acces sans
    -- changer de code ni se deconnecter. S'ajoute a la duree du forfait,
    -- pour le compteur du routeur comme pour l'echeance calendaire.
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS extra_seconds INT NOT NULL DEFAULT 0;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS used_uptime TEXT;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS used_bytes BIGINT DEFAULT 0;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

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
    -- Apres la creation de la table, sinon un demarrage sur base neuve
    -- echoue : la colonne serait ajoutee a une table qui n'existe pas encore.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS recharge_code TEXT;
    ALTER TABLE users   ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE;
    ALTER TABLE routers ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS routers_tenant_idx ON routers (tenant_id);
    CREATE INDEX IF NOT EXISTS users_tenant_idx   ON users (tenant_id);
    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
    CREATE INDEX IF NOT EXISTS orders_handoff_idx
      ON orders (handoff_hash) WHERE handoff_hash IS NOT NULL;
  `);
}

// Rattache a un locataire ce qui n'en a pas : une installation existante
// devient le premier client du service, sans rien perdre. Idempotent.
export async function backfillTenants() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: orphelins } = await client.query(
      `SELECT (SELECT count(*) FROM routers WHERE tenant_id IS NULL)::int AS r,
              (SELECT count(*) FROM users   WHERE tenant_id IS NULL)::int AS u`);
    if (orphelins[0].r === 0 && orphelins[0].u === 0) {
      await client.query("COMMIT");
      return null;
    }
    // Le locataire par defaut porte le nom du premier routeur : sur une
    // installation existante, c'est celui que l'exploitant reconnaitra.
    const { rows: premier } = await client.query(
      `SELECT name, slug FROM routers ORDER BY id LIMIT 1`);
    const nom = premier[0] ? premier[0].name : "Mon réseau";
    const slug = premier[0] ? premier[0].slug : "principal";
    // Seul ce locataire-la herite des identifiants Pay'm de l'environnement :
    // c'est l'exploitation qui tournait avant, elle ne doit rien ressaisir.
    const { rows: t } = await client.query(
      `INSERT INTO tenants (name, slug, paym_from_env) VALUES ($1,$2,true)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`, [nom, slug]);
    const id = t[0].id;
    await client.query(`UPDATE routers SET tenant_id = $1 WHERE tenant_id IS NULL`, [id]);
    await client.query(`UPDATE users   SET tenant_id = $1 WHERE tenant_id IS NULL`, [id]);
    await client.query("COMMIT");
    return { id, nom, routeurs: orphelins[0].r, comptes: orphelins[0].u };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getTenant(id) {
  const { rows } = await pool.query(`SELECT * FROM tenants WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Identifiants Pay'm du locataire qui possede ce routeur. Repli sur les
// variables d'environnement : l'installation d'origine continue de marcher
// telle quelle, sans rien saisir.
export async function paymDuRouteur(routerId) {
  const { rows } = await pool.query(
    `SELECT t.payout_mode, t.paym_client_id, t.paym_client_secret, t.paym_from_env
       FROM routers r JOIN tenants t ON t.id = r.tenant_id
      WHERE r.id = $1`, [routerId]);
  const t = rows[0];
  if (!t) return null;
  return {
    ...t,
    // Le repli sur l'environnement n'existe que pour l'installation d'origine.
    paym_client_id: t.paym_client_id
      || (t.paym_from_env ? (config.paym.clientId || null) : null),
  };
}

export async function setTenantNom(id, nom) {
  await pool.query(`UPDATE tenants SET name = $2 WHERE id = $1`, [id, nom]);
}

export async function setTenantPaym(id, { clientId, clientSecret }) {
  // Un secret vide ne doit pas effacer celui en place : on ne le reaffiche
  // jamais, l'operateur ne peut donc pas le retaper a chaque fois.
  await pool.query(
    `UPDATE tenants SET paym_client_id = $2,
            paym_client_secret = COALESCE(NULLIF($3, ''), paym_client_secret)
      WHERE id = $1`, [id, clientId || null, clientSecret || ""]);
}

// Les forfaits créés avant l'expiration calendaire ont validity_seconds = 0
// et n'expireraient jamais. On la déduit une fois de leur durée.
export async function backfillPlanValidity() {
  const { rows } = await pool.query(
    `SELECT id, uptime FROM plans WHERE validity_seconds = 0`);
  let n = 0;
  for (const p of rows) {
    const secondes = durationToSeconds(p.uptime);
    if (secondes > 0) {
      await pool.query(`UPDATE plans SET validity_seconds = $2 WHERE id = $1`,
        [p.id, secondes]);
      n += 1;
    }
  }
  return n;
}

// Vouchers déjà utilisés depuis plus longtemps que leur forfait ne le permet :
// activer l'expiration les retirerait immédiatement. À signaler avant, pour ne
// pas couper des clients sans le savoir.
export async function vouchersDejaEchus() {
  const { rows } = await pool.query(`
    SELECT count(*)::int AS n
      FROM vouchers v JOIN plans p ON p.id = v.plan_id
     WHERE v.used_at IS NOT NULL AND v.expired_at IS NULL
       AND p.validity_seconds > 0
       AND v.used_at + ((p.validity_seconds + v.extra_seconds) || ' seconds')::interval < now()`);
  return rows[0].n;
}

// ---------------------------------------------------------------- routers --
export async function listRouters(tenantId) {
  const { rows } = await pool.query(
    `SELECT r.*,
            (SELECT count(*) FROM commands c WHERE c.router_id = r.id AND c.status='PENDING') AS pending_commands
       FROM routers r WHERE r.tenant_id = $1 ORDER BY r.id`, [tenantId]);
  return rows;
}
// Routeurs qui ne rapportent plus. L'agent passe toutes les 15 s : au-delà de
// quelques minutes, le routeur est éteint, sans Internet, ou son agent est
// cassé — dans tous les cas les clients ne peuvent plus se connecter.
export async function routersSilencieux(secondes) {
  const { rows } = await pool.query(
    `SELECT name, slug,
            EXTRACT(EPOCH FROM (now() - last_seen))::int AS depuis
       FROM routers
      WHERE last_seen IS NULL
         OR last_seen < now() - ($1 || ' seconds')::interval
      ORDER BY name`, [secondes]);
  return rows;
}

export async function getRouter(id, tenantId) {
  // tenantId est obligatoire cote dashboard : sans lui, un identifiant deviné
  // dans l'URL ouvrirait le routeur d'un autre client. Les appels internes
  // qui n'ont pas de locataire passent explicitement null.
  const { rows } = tenantId == null
    ? await pool.query(`SELECT * FROM routers WHERE id = $1`, [id])
    : await pool.query(`SELECT * FROM routers WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]);
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
export async function createRouter({ slug, name, pullToken, portalUrl, tenantId }) {
  const { rows } = await pool.query(
    `INSERT INTO routers (slug, name, pull_token, portal_url, tenant_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [slug, name, pullToken, portalUrl || "", tenantId || null]);
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
            p.shared_users, v.source AS voucher_source,
            -- Echeance calendaire : le routeur, lui, ne renvoie que le temps
            -- de CONNEXION restant. Les deux different des qu'un client se
            -- deconnecte, et c'est la plus proche qui coupe l'acces.
            CASE WHEN v.used_at IS NOT NULL AND p.validity_seconds > 0
                 THEN EXTRACT(EPOCH FROM (v.used_at
                        + ((p.validity_seconds + v.extra_seconds) || ' seconds')::interval
                        - now()))::int
            END AS validity_left
       FROM sessions s
       LEFT JOIN vouchers v ON v.router_id = s.router_id AND v.code = s.username
       LEFT JOIN plans p ON p.id = v.plan_id
      WHERE s.router_id = $1
      ORDER BY s.username`, [routerId]);
  return rows;
}

// Met en file une commande brute pour un routeur (ex : suppression d'un code).
// ---------------------------------------------- fichiers du portail ----

// Chemin de destination sur le routeur. Verrou volontairement etroit : le
// tableau de bord ne doit jamais pouvoir ecrire ailleurs que dans le dossier
// du portail. Sans cela, quiconque obtient le mot de passe admin ecraserait
// n'importe quel fichier du routeur.
export function cheminPortailValide(chemin) {
  const p = String(chemin || "").replace(/^\/+/, "");
  if (p.length === 0 || p.length > 120) return null;
  if (p.includes("..") || p.includes("\\")) return null;
  if (!/^[A-Za-z0-9._\/-]+$/.test(p)) return null;
  if (p.endsWith("/")) return null;
  return p;
}

// Duree RouterOS : un nombre suivi de son unite (30m, 2h, 1d). Valide ici
// parce que la valeur part telle quelle dans une commande du routeur.
export function dureeRouterOsValide(v) {
  const t = String(v || "").trim().toLowerCase();
  return /^[1-9][0-9]{0,3}[smhdw]$/.test(t) ? t : null;
}

export async function setTrial(routerId, limite, reset) {
  await pool.query(
    `UPDATE routers SET trial_limit = $2, trial_reset = $3 WHERE id = $1`,
    [routerId, limite, reset]);
}

export async function setPortalDir(routerId, dir) {
  await pool.query(`UPDATE routers SET portal_dir = $2 WHERE id = $1`, [routerId, dir]);
}

// Echeance calendaire d'un voucher deja utilise. Le routeur, lui, ne connait
// que le temps de connexion restant : il ignore que le code meurt 24 h apres
// la premiere connexion, meme passees hors ligne.
export async function echeanceVoucher(routerId, code) {
  const { rows } = await pool.query(
    `SELECT CASE
              -- Code pret mais jamais connecte : l'horloge ne demarre qu'a la
              -- premiere connexion, il a donc sa duree entiere devant lui.
              WHEN v.used_at IS NULL THEN (p.validity_seconds + v.extra_seconds)
              ELSE EXTRACT(EPOCH FROM (v.used_at
                     + ((p.validity_seconds + v.extra_seconds) || ' seconds')::interval
                     - now()))::int
            END AS restant,
            (v.used_at IS NOT NULL) AS demarre,
            (v.expired_at IS NOT NULL) AS echu
       FROM vouchers v JOIN plans p ON p.id = v.plan_id
      WHERE v.router_id = $1 AND v.code = $2
        AND p.validity_seconds > 0`, [routerId, code]);
  return rows[0] || null;
}

// ------------------------------------------------------------ comptes ----

// scrypt : livre avec Node, donc aucune dependance native a compiler chez
// l'hebergeur. Le sel est tire par compte et voyage avec l'empreinte.
export function hacherMotDePasse(motDePasse) {
  const sel = randomBytes(16);
  const cle = scryptSync(String(motDePasse), sel, 32);
  return sel.toString("hex") + ":" + cle.toString("hex");
}

export function verifierMotDePasse(motDePasse, empreinte) {
  const [selHex, cleHex] = String(empreinte || "").split(":");
  if (!selHex || !cleHex) return false;
  const attendu = Buffer.from(cleHex, "hex");
  const calcule = scryptSync(String(motDePasse), Buffer.from(selHex, "hex"), attendu.length);
  return attendu.length === calcule.length && timingSafeEqual(attendu, calcule);
}

// Cree une organisation et son premier proprietaire d'un seul tenant : sans
// cela, un compte sans organisation ne verrait rien et ne pourrait rien
// reparer lui-meme.
export async function creerOrganisation({ nom, slug, email, motDePasse, platformAdmin = false }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: t } = await client.query(
      `INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING *`, [nom, slug]);
    const { rows: u } = await client.query(
      `INSERT INTO users (email, name, pass_hash, role, tenant_id, platform_admin)
       VALUES ($1,$2,$3,'owner',$4,$5) RETURNING *`,
      [String(email).trim(), "", hacherMotDePasse(motDePasse), t[0].id, platformAdmin]);
    await client.query("COMMIT");
    return { tenant: t[0], user: u[0] };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Slug libre derive du nom : il voyage dans aucune URL publique pour l'instant,
// mais il doit rester unique.
export async function slugLibre(base) {
  const propre = String(base || "org").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "org";
  for (let i = 0; i < 50; i++) {
    const essai = i === 0 ? propre : `${propre}-${i + 1}`;
    const { rowCount } = await pool.query(`SELECT 1 FROM tenants WHERE slug = $1`, [essai]);
    if (rowCount === 0) return essai;
  }
  return `${propre}-${Date.now().toString(36)}`;
}

// ------------------------------------------------------- invitations ----

export async function creerInvitation({ note, parId, jours = 14 }) {
  const token = randomBytes(24).toString("hex");
  const { rows } = await pool.query(
    `INSERT INTO invitations (token, note, created_by, expires_at)
     VALUES ($1,$2,$3, now() + ($4 || ' days')::interval) RETURNING *`,
    [token, String(note || "").slice(0, 120), parId || null, jours]);
  return rows[0];
}

export async function listInvitations() {
  const { rows } = await pool.query(
    `SELECT i.*, t.name AS tenant_name
       FROM invitations i LEFT JOIN tenants t ON t.id = i.tenant_id
      ORDER BY i.created_at DESC LIMIT 100`);
  return rows;
}

export async function invitationValide(token) {
  const { rows } = await pool.query(
    `SELECT * FROM invitations
      WHERE token = $1 AND used_at IS NULL AND expires_at > now()`, [String(token || "")]);
  return rows[0] || null;
}

export async function consommerInvitation(token, tenantId) {
  // La condition used_at IS NULL est dans l'UPDATE : deux inscriptions
  // simultanees avec le meme lien, une seule passe.
  const { rowCount } = await pool.query(
    `UPDATE invitations SET used_at = now(), tenant_id = $2
      WHERE token = $1 AND used_at IS NULL AND expires_at > now()`, [token, tenantId]);
  return rowCount === 1;
}

export async function supprimerInvitation(token) {
  await pool.query(`DELETE FROM invitations WHERE token = $1 AND used_at IS NULL`, [token]);
}

// --------------------------------------------------- organisations ----

export async function listTenants() {
  const { rows } = await pool.query(
    `SELECT t.*,
            (SELECT count(*)::int FROM routers r WHERE r.tenant_id = t.id) AS routeurs,
            (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active) AS comptes
       FROM tenants t ORDER BY t.created_at DESC`);
  return rows;
}

export async function setTenantActif(id, actif) {
  await pool.query(`UPDATE tenants SET active = $2 WHERE id = $1`, [id, actif]);
}

export async function compterUtilisateurs() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users WHERE active`);
  return rows[0].n;
}

export async function listUsers(tenantId) {
  const { rows } = await pool.query(
    `SELECT id, email, name, role, active, created_at, last_login
       FROM users WHERE tenant_id = $1 ORDER BY active DESC, email`, [tenantId]);
  return rows;
}

export async function getUserById(id) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function getUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE lower(email) = lower($1)`, [String(email || "")]);
  return rows[0] || null;
}

export async function createUser({ email, name, motDePasse, role, tenantId }) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, pass_hash, role, tenant_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [String(email).trim(), String(name || "").trim(),
     hacherMotDePasse(motDePasse), role === "owner" ? "owner" : "vendeur",
     tenantId || null]);
  return rows[0];
}

export async function setUserPassword(id, motDePasse) {
  await pool.query(`UPDATE users SET pass_hash = $2 WHERE id = $1`,
    [id, hacherMotDePasse(motDePasse)]);
}

export async function touchUserLogin(id) {
  await pool.query(`UPDATE users SET last_login = now() WHERE id = $1`, [id]);
}

// Compte les proprietaires encore actifs, en excluant eventuellement l'un
// d'eux : sert a refuser la modification qui fermerait la porte a tout le
// monde. Un dashboard sans proprietaire ne se recupere que par la base.
async function autresProprietaires(client, saufId) {
  // Compte dans le meme locataire : le proprietaire d'un autre client du
  // service ne peut evidemment pas reprendre la main ici.
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM users
      WHERE role = 'owner' AND active AND id <> $1
        AND tenant_id IS NOT DISTINCT FROM
            (SELECT tenant_id FROM users WHERE id = $1)`, [saufId]);
  return rows[0].n;
}

export async function updateUser(id, { role, active }, tenantId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM users WHERE id = $1
        AND ($2::int IS NULL OR tenant_id = $2) FOR UPDATE`, [id, tenantId ?? null]);
    if (rows.length === 0) { await client.query("ROLLBACK"); return { ok: false, raison: "introuvable" }; }
    const perdProprietaire = rows[0].role === "owner"
      && (role === "vendeur" || active === false);
    if (perdProprietaire && (await autresProprietaires(client, id)) === 0) {
      await client.query("ROLLBACK");
      return { ok: false, raison: "dernier-proprietaire" };
    }
    await client.query(
      `UPDATE users SET role = COALESCE($2, role), active = COALESCE($3, active)
        WHERE id = $1`,
      [id, role === undefined ? null : role, active === undefined ? null : active]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteUser(id, tenantId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT role FROM users WHERE id = $1
        AND ($2::int IS NULL OR tenant_id = $2) FOR UPDATE`, [id, tenantId ?? null]);
    if (rows.length === 0) { await client.query("ROLLBACK"); return { ok: false, raison: "introuvable" }; }
    if (rows[0].role === "owner" && (await autresProprietaires(client, id)) === 0) {
      await client.query("ROLLBACK");
      return { ok: false, raison: "dernier-proprietaire" };
    }
    await client.query(`DELETE FROM users WHERE id = $1`, [id]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// --------------------------------------------------------- sponsors ----

export async function listSponsors(routerId) {
  const { rows } = await pool.query(
    `SELECT * FROM sponsors WHERE router_id = $1 ORDER BY active DESC, name`,
    [routerId]);
  return rows;
}

// Sponsors visibles maintenant : actifs et dans leur fenetre de contrat.
// Un contrat echu s'eteint tout seul — sans cela on afficherait gratuitement
// un commerce qui ne paie plus.
export async function sponsorsEnCours(routerId, placement) {
  const { rows } = await pool.query(
    `SELECT id, name, baseline, contact, image_path, placement
       FROM sponsors
      WHERE router_id = $1 AND active
        AND (starts_on IS NULL OR starts_on <= current_date)
        AND (ends_on   IS NULL OR ends_on   >= current_date)
        AND placement IN ($2, 'both')
      ORDER BY name`, [routerId, placement]);
  return rows;
}

export async function createSponsor(routerId, s) {
  const { rows } = await pool.query(
    `INSERT INTO sponsors (router_id, name, baseline, contact, placement, starts_on, ends_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [routerId, s.name, s.baseline || "", s.contact || "", s.placement || "login",
     s.startsOn || null, s.endsOn || null]);
  return rows[0];
}

export async function setSponsorImage(routerId, id, chemin) {
  await pool.query(`UPDATE sponsors SET image_path = $3 WHERE id = $2 AND router_id = $1`,
    [routerId, id, chemin]);
}

export async function toggleSponsor(routerId, id, actif) {
  await pool.query(`UPDATE sponsors SET active = $3 WHERE id = $2 AND router_id = $1`,
    [routerId, id, actif]);
}

export async function deleteSponsor(routerId, id) {
  const { rows } = await pool.query(
    `DELETE FROM sponsors WHERE id = $2 AND router_id = $1 RETURNING image_path`,
    [routerId, id]);
  return rows[0] || null;
}

// Compteurs. Une seule requete, sans lecture prealable : ces increments
// arrivent a chaque affichage de page et ne doivent rien couter.
export async function compterVues(ids) {
  if (ids.length === 0) return;
  await pool.query(`UPDATE sponsors SET views = views + 1 WHERE id = ANY($1)`, [ids]);
}

export async function compterClic(routerId, id) {
  const { rowCount } = await pool.query(
    `UPDATE sponsors SET clicks = clicks + 1 WHERE id = $2 AND router_id = $1`,
    [routerId, id]);
  return rowCount === 1;
}

// ----------------------------------------------------- recharges ----

export async function getVoucherByCode(routerId, code) {
  const { rows } = await pool.query(
    `SELECT v.*, p.uptime AS plan_uptime, p.code AS plan_code
       FROM vouchers v LEFT JOIN plans p ON p.id = v.plan_id
      WHERE v.router_id = $1 AND v.code = $2`, [routerId, code]);
  return rows[0] || null;
}

// Prolonge un code deja en service : le compteur du routeur ET l'echeance
// calendaire avancent d'autant. Le client garde son code et sa session ; se
// deconnecter pour ressaisir un nouveau code fait perdre la moitie des
// acheteurs au moment ou ils sont decides.
export async function prolongerVoucher(routerId, code, secondes, plan = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Code deja echu : il a ete retire du routeur, il n'y a plus de compte a
    // prolonger. On le fait renaitre avec le forfait qui vient d'etre paye —
    // le client reprend SON code au lieu d'en apprendre un nouveau.
    const { rows: exist } = await client.query(
      `SELECT id, plan_id, expired_at FROM vouchers
        WHERE router_id = $1 AND code = $2 FOR UPDATE`, [routerId, code]);
    if (exist.length === 0) { await client.query("ROLLBACK"); return null; }

    if (exist[0].expired_at) {
      if (!plan) { await client.query("ROLLBACK"); return null; }
      const cmd = await client.query(
        `INSERT INTO commands (router_id, action, payload)
         VALUES ($1,'add',$2) RETURNING id`,
        [routerId, {
          code, uptime: plan.uptime, comment: `recharge ${plan.code}`,
          profile: `mv-${plan.code}`, shared: plan.shared_users,
          rate: plan.rate_limit || "",
        }]);
      // Compteur remis a neuf : l'echeance repartira de la prochaine
      // connexion, comme pour un code jamais utilise.
      await client.query(
        `UPDATE vouchers SET plan_id = $2, expired_at = NULL, used_at = NULL,
                             used_uptime = NULL, used_bytes = 0,
                             extra_seconds = 0, status = 'QUEUED', command_id = $3
          WHERE id = $1`, [exist[0].id, plan.id, cmd.rows[0].id]);
      await client.query("COMMIT");
      return { voucherId: exist[0].id, mode: "reactive" };
    }

    const { rows } = await client.query(
      `UPDATE vouchers v SET extra_seconds = extra_seconds + $3
        WHERE v.router_id = $1 AND v.code = $2 AND v.expired_at IS NULL
        RETURNING v.id, v.plan_id, v.extra_seconds`, [routerId, code, secondes]);
    if (rows.length === 0) { await client.query("ROLLBACK"); return null; }
    const v = rows[0];

    const { rows: pl } = await client.query(
      `SELECT uptime FROM plans WHERE id = $1`, [v.plan_id]);
    // Nouveau plafond de temps de connexion : celui du forfait d'origine,
    // augmente de tout ce qui a ete recharge depuis.
    const base = pl[0] ? durationToSeconds(pl[0].uptime) : 0;
    const total = base + v.extra_seconds;

    const cmd = await client.query(
      `INSERT INTO commands (router_id, action, payload)
       VALUES ($1,'extend',$2) RETURNING id`,
      [routerId, { code, uptime: secondesEnDuree(total) }]);
    // Le meme accuse de reception qui confirme la commande fera passer la
    // vente en DELIVERED (voir ackCommand).
    await client.query(`UPDATE vouchers SET command_id = $2 WHERE id = $1`,
      [v.id, cmd.rows[0].id]);
    await client.query("COMMIT");
    return { voucherId: v.id, total, mode: "prolonge" };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Duree RouterOS a partir de secondes : "1d2h30m" plutot qu'un entier nu,
// dont l'interpretation depend du champ vise.
export function secondesEnDuree(sec) {
  sec = Math.max(0, Math.round(sec));
  const j = Math.floor(sec / 86400); sec %= 86400;
  const h = Math.floor(sec / 3600); sec %= 3600;
  const m = Math.floor(sec / 60); const s = sec % 60;
  return [[j, "d"], [h, "h"], [m, "m"], [s, "s"]]
    .filter(([n]) => n > 0).map(([n, u]) => n + u).join("") || "0s";
}

// -------------------------------------------------- restauration ----

// Restaure une sauvegarde. Volontairement ADDITIVE : elle remet ce qui
// manque et ne supprime jamais rien. Une restauration qui efface serait une
// deuxieme facon de perdre ses donnees.
//
// Les identifiants du fichier ne veulent rien dire dans une base neuve : on
// rapproche par slug (routeurs), par code (forfaits, vouchers) et par
// reference (ventes). Le jeton d'un routeur ne figure pas dans la sauvegarde
// — un routeur recree en obtient un neuf, et son script doit etre reimporte.
export async function restaurer(data, tenantId) {
  const bilan = { routeurs: 0, forfaits: 0, vouchers: 0, ventes: 0, ignores: 0,
                  slugsPris: [] };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const mapRouteur = new Map();   // ancien id -> nouvel id
    for (const r of data.routers || []) {
      if (!r.slug) { bilan.ignores += 1; continue; }
      // Rapprochement dans le locataire seulement : deux clients du service
      // peuvent avoir un routeur de meme nom sans se marcher dessus.
      let { rows } = await client.query(
        `SELECT id FROM routers WHERE slug = $1 AND tenant_id = $2`, [r.slug, tenantId]);
      if (rows.length === 0) {
        // Le slug identifie le routeur dans l'URL publique du portail : il est
        // donc unique pour tout le service. S'il est deja pris ailleurs, on
        // passe ce routeur et on le dit, plutot que de faire echouer toute la
        // restauration — un autre client aurait alors le pouvoir d'empecher
        // la reprise de celui-ci.
        // Point de reprise : dans PostgreSQL, une erreur avorte toute la
        // transaction. Sans SAVEPOINT, rattraper la collision ne servirait a
        // rien — les insertions suivantes seraient refusees jusqu'au rollback.
        await client.query("SAVEPOINT avant_routeur");
        try {
          const ins = await client.query(
            `INSERT INTO routers (slug, name, pull_token, portal_url, tenant_id)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [r.slug, r.name || r.slug, generateRouterToken(), r.portal_url || "", tenantId]);
          await client.query("RELEASE SAVEPOINT avant_routeur");
          rows = ins.rows;
          bilan.routeurs += 1;
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT avant_routeur");
          if (String(err.code) !== "23505") throw err;
          bilan.slugsPris.push(r.slug);
          bilan.ignores += 1;
          continue;
        }
      }
      mapRouteur.set(r.id, rows[0].id);
    }

    const mapPlan = new Map();
    for (const p of data.plans || []) {
      const rid = mapRouteur.get(p.router_id);
      if (!rid || !p.code) { bilan.ignores += 1; continue; }
      const { rows } = await client.query(
        `INSERT INTO plans (router_id, code, label, price_htg, uptime,
                            shared_users, rate_limit, validity_seconds, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (router_id, code) DO UPDATE SET code = EXCLUDED.code
         RETURNING id, (xmax = 0) AS cree`,
        [rid, p.code, p.label || p.code, p.price_htg || 0, p.uptime || "1d",
         p.shared_users || 1, p.rate_limit || "", p.validity_seconds || 0,
         p.active !== false]);
      if (rows[0].cree) bilan.forfaits += 1;
      mapPlan.set(p.id, rows[0].id);
    }

    const mapVoucher = new Map();
    for (const v of data.vouchers || []) {
      const rid = mapRouteur.get(v.router_id);
      if (!rid || !v.code) { bilan.ignores += 1; continue; }
      const { rows } = await client.query(
        `INSERT INTO vouchers (router_id, code, plan_id, source, status,
                               created_at, used_at, used_uptime, used_bytes, expired_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (router_id, code) DO UPDATE SET code = EXCLUDED.code
         RETURNING id, (xmax = 0) AS cree`,
        [rid, v.code, mapPlan.get(v.plan_id) || null, v.source || "batch",
         v.status || "QUEUED", v.created_at || new Date(), v.used_at || null,
         v.used_uptime || null, v.used_bytes || 0, v.expired_at || null]);
      if (rows[0].cree) bilan.vouchers += 1;
      mapVoucher.set(v.id, rows[0].id);
    }

    for (const o of data.orders || []) {
      const rid = mapRouteur.get(o.router_id);
      const pid = mapPlan.get(o.plan_id);
      if (!rid || !pid || !o.reference) { bilan.ignores += 1; continue; }
      const { rowCount } = await client.query(
        `INSERT INTO orders (reference, router_id, plan_id, amount_htg, method,
                             claim_hash, retrieval_pin, status, voucher_id,
                             paym_transaction_id, created_at, paid_at, delivered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (reference) DO NOTHING`,
        [o.reference, rid, pid, o.amount_htg || 0, o.method || "?",
         o.claim_hash || "", o.retrieval_pin || null, o.status || "PENDING",
         mapVoucher.get(o.voucher_id) || null, o.paym_transaction_id || null,
         o.created_at || new Date(), o.paid_at || null, o.delivered_at || null]);
      if (rowCount === 1) bilan.ventes += 1;
    }

    await client.query("COMMIT");
    return bilan;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ------------------------------------------------- remise a zero ----

// Efface l'historique des ventes, et si demande les vouchers eux-memes.
// Pensee pour la fin des tests : on repart sur des chiffres vrais. Les codes
// supprimes sont retires du routeur, sinon ils resteraient utilisables alors
// qu'ils ont disparu du manager.
export async function remiseAZero({ vouchers = false, tenantId } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Borne au locataire : sinon un client du service effacerait la
    // comptabilite de tous les autres.
    const { rowCount: commandes } = await client.query(
      `DELETE FROM orders o USING routers r
        WHERE r.id = o.router_id AND r.tenant_id = $1`, [tenantId]);

    let codes = 0;
    if (vouchers) {
      // Les remove partent AVANT la suppression : une fois la ligne partie,
      // on ne saurait plus quel compte retirer du routeur.
      const { rows } = await client.query(
        `SELECT v.router_id, v.code FROM vouchers v
           JOIN routers r ON r.id = v.router_id WHERE r.tenant_id = $1`, [tenantId]);
      for (const v of rows) {
        await client.query(
          `INSERT INTO commands (router_id, action, payload) VALUES ($1,'remove',$2)`,
          [v.router_id, { code: v.code }]);
      }
      // Le lien orders -> vouchers est deja tombe avec les commandes.
      await client.query(
        `UPDATE vouchers v SET command_id = NULL
          FROM routers r WHERE r.id = v.router_id AND r.tenant_id = $1`, [tenantId]);
      const r = await client.query(
        `DELETE FROM vouchers v USING routers r
          WHERE r.id = v.router_id AND r.tenant_id = $1`, [tenantId]);
      codes = r.rowCount;
    }
    await client.query("COMMIT");
    return { commandes, codes };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function upsertPortalFile(routerId, path, buffer) {
  const { rows } = await pool.query(
    `INSERT INTO portal_files (router_id, path, content, bytes)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (router_id, path) DO UPDATE
       SET content = $3, bytes = $4, updated_at = now(), pushed_at = NULL
     RETURNING id, path, bytes`,
    [routerId, path, buffer, buffer.length]);
  return rows[0];
}

export async function listPortalFiles(routerId) {
  const { rows } = await pool.query(
    `SELECT id, path, bytes, pushed_at, updated_at
       FROM portal_files WHERE router_id = $1 ORDER BY path`, [routerId]);
  return rows;
}

export async function getPortalFileContent(routerId, id) {
  const { rows } = await pool.query(
    `SELECT path, content FROM portal_files WHERE id = $1 AND router_id = $2`,
    [id, routerId]);
  return rows[0] || null;
}

export async function deletePortalFile(routerId, id) {
  await pool.query(`DELETE FROM portal_files WHERE id = $1 AND router_id = $2`,
    [id, routerId]);
}

export async function markPortalFilePushed(routerId, id) {
  await pool.query(
    `UPDATE portal_files SET pushed_at = now() WHERE id = $1 AND router_id = $2`,
    [id, routerId]);
}

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
export async function upsertPlan({ routerId, code, label, priceHtg, uptime, sharedUsers, rateLimit, validitySeconds }) {
  await pool.query(
    `INSERT INTO plans (router_id, code, label, price_htg, uptime, shared_users,
                        rate_limit, validity_seconds)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (router_id, code)
     DO UPDATE SET label=$3, price_htg=$4, uptime=$5, shared_users=$6,
                   rate_limit=$7, validity_seconds=$8, active=true`,
    [routerId, code, label, priceHtg, uptime, sharedUsers || 1, rateLimit || "",
     validitySeconds || 0]);
}

// Retire du routeur les vouchers dont la validité est écoulée depuis leur
// première utilisation. Une seule transaction : on met la commande en file ET
// on marque le voucher, pour ne jamais la reprogrammer deux fois.
export async function expireUsedVouchers() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`
      SELECT v.id, v.code, v.router_id
        FROM vouchers v JOIN plans p ON p.id = v.plan_id
       WHERE v.used_at IS NOT NULL AND v.expired_at IS NULL
         AND p.validity_seconds > 0
         AND v.used_at + ((p.validity_seconds + v.extra_seconds) || ' seconds')::interval < now()
       FOR UPDATE OF v SKIP LOCKED`);
    for (const v of rows) {
      await client.query(
        `INSERT INTO commands (router_id, action, payload) VALUES ($1,'remove',$2)`,
        [v.router_id, { code: v.code }]);
      await client.query(`UPDATE vouchers SET expired_at = now() WHERE id = $1`, [v.id]);
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
export async function createVoucher({ routerId, code, planId, uptime, source, comment, profile, sharedUsers, rateLimit }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cmd = await client.query(
      `INSERT INTO commands (router_id, action, payload)
       VALUES ($1,'add',$2) RETURNING id`,
      [routerId, {
        code, uptime, comment: comment || "",
        profile: profile || "", shared: sharedUsers || 1,
        rate: rateLimit || "",
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
    `SELECT v.*, p.label AS plan_label, p.price_htg, p.validity_seconds
       FROM vouchers v LEFT JOIN plans p ON p.id = v.plan_id
      WHERE v.router_id = $1
      ORDER BY (v.used_at IS NOT NULL), v.id DESC LIMIT $2`,
    [routerId, limit]);
  return rows;
}
export async function getVouchersByIds(ids, tenantId) {
  const { rows } = await pool.query(
    `SELECT v.*, p.label AS plan_label, p.price_htg, p.shared_users,
            r.name AS router_name, r.info AS router_info
       FROM vouchers v
       LEFT JOIN plans p ON p.id = v.plan_id
       JOIN routers r ON r.id = v.router_id
      WHERE v.id = ANY($1) AND r.tenant_id = $2 ORDER BY v.id`, [ids, tenantId]);
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
      // Un push de fichier est confirme par le meme accuse de reception.
      await client.query(
        `UPDATE portal_files SET pushed_at = now()
          WHERE id = (SELECT (payload->>'fileId')::int FROM commands
                       WHERE id = $1 AND action = 'fetch')`, [commandId]);
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

// Marque comme utilisés les vouchers que le routeur signale avoir servi.
// used_at n'est posé qu'une fois : c'est la date de première utilisation.
export async function markVouchersUsed(routerId, rows) {
  if (rows.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      await client.query(
        `UPDATE vouchers
            SET used_at = COALESCE(used_at, now()),
                used_uptime = $3, used_bytes = $4
          WHERE router_id = $1 AND code = $2`,
        [routerId, r.code, r.uptime, r.bytes]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Vouchers qui devraient exister sur le routeur en ce moment.
export async function activeVouchers(routerId) {
  const { rows } = await pool.query(
    `SELECT v.code, v.plan_id, p.uptime, p.code AS plan_code,
            p.shared_users, p.rate_limit
       FROM vouchers v JOIN plans p ON p.id = v.plan_id
      WHERE v.router_id = $1 AND v.expired_at IS NULL`, [routerId]);
  return rows;
}

// Remet en file la création de tous les vouchers actifs. L'agent ignore ceux
// qui existent déjà, donc c'est sans risque : sert à réparer un routeur remis
// à zéro ou restauré depuis une vieille sauvegarde.
export async function resyncVouchers(routerId) {
  const list = await activeVouchers(routerId);
  if (list.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const v of list) {
      await client.query(
        `INSERT INTO commands (router_id, action, payload) VALUES ($1,'add',$2)`,
        [routerId, {
          code: v.code, uptime: v.uptime, profile: `mv-${v.plan_code}`,
          shared: v.shared_users, rate: v.rate_limit, comment: "resync",
        }]);
    }
    await client.query(
      `UPDATE vouchers SET status='QUEUED' WHERE router_id=$1 AND expired_at IS NULL`,
      [routerId]);
    await client.query("COMMIT");
    return list.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------- orders --
export async function createOrder({ reference, routerId, planId, amountHtg, method, claimHash, retrievalPin, transactionId, rechargeCode = null }) {
  await pool.query(
    `INSERT INTO orders (reference, router_id, plan_id, amount_htg, method,
                         claim_hash, retrieval_pin, paym_transaction_id, recharge_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [reference, routerId, planId, amountHtg, method, claimHash, retrievalPin,
     transactionId, rechargeCode]);
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
export async function listOrders(tenantId, limit = 200) {
  const { rows } = await pool.query(
    `SELECT o.*, r.name AS router_name, p.label AS plan_label,
            v.code AS voucher_code
       FROM orders o
       JOIN routers r ON r.id = o.router_id
       JOIN plans p ON p.id = o.plan_id
       LEFT JOIN vouchers v ON v.id = o.voucher_id
      WHERE r.tenant_id = $1
      ORDER BY o.created_at DESC LIMIT $2`, [tenantId, limit]);
  return rows;
}
// --- Finances ---------------------------------------------------------------
// Toutes les agrégations par jour se font dans le fuseau du commerce, sinon
// "aujourd'hui" bascule 5 h trop tôt (la base stocke en UTC).
const TZ = process.env.BUSINESS_TZ || "America/Port-au-Prince";
const PAID = "status IN ('PAID','DELIVERED')";
// Meme condition, qualifiee : des qu'on joint orders a routers, `status` seul
// devient ambigu.
const PAIDO = "o.status IN ('PAID','DELIVERED')";

// Recette "espèces" : un voucher d'un lot qui a servi a forcément été vendu.
// C'est le seul indice fiable dont on dispose pour les ventes de la main à la
// main, et il évite de compter comme vendu un carnet imprimé mais pas écoulé.
const CASH = `
  SELECT v.used_at AS at, p.price_htg AS htg
    FROM vouchers v JOIN plans p ON p.id = v.plan_id
    JOIN routers r ON r.id = v.router_id
   WHERE v.source = 'batch' AND v.used_at IS NOT NULL
     AND r.tenant_id = $2`;

export async function cashSummary(tenantId) {
  const { rows } = await pool.query(`
    WITH c AS (${CASH}), j AS (SELECT (now() AT TIME ZONE $1)::date AS today)
    SELECT
      COALESCE(SUM(htg),0)::int AS total_htg,
      COUNT(*)::int AS total_count,
      COALESCE(SUM(htg) FILTER (WHERE (at AT TIME ZONE $1)::date = j.today),0)::int AS today_htg,
      COUNT(*) FILTER (WHERE (at AT TIME ZONE $1)::date = j.today)::int AS today_count,
      COALESCE(SUM(htg) FILTER (WHERE (at AT TIME ZONE $1)::date > j.today - 7),0)::int AS week_htg,
      COALESCE(SUM(htg) FILTER (WHERE date_trunc('month', at AT TIME ZONE $1)
              = date_trunc('month', j.today)),0)::int AS month_htg
    FROM c, j`, [TZ, tenantId]);
  return rows[0];
}

// Vouchers d'un lot restant à vendre, par forfait : ce qu'il reste en stock.
export async function stockByPlan(tenantId) {
  const { rows } = await pool.query(`
    SELECT p.label, r.name AS router_name, p.price_htg,
           COUNT(*)::int AS restants
      FROM vouchers v
      JOIN plans p ON p.id = v.plan_id
      JOIN routers r ON r.id = v.router_id
     WHERE v.source = 'batch' AND v.used_at IS NULL
       AND r.tenant_id = $1
     GROUP BY p.label, r.name, p.price_htg
     ORDER BY restants DESC`, [tenantId]);
  return rows;
}

export async function financeSummary(tenantId) {
  const { rows } = await pool.query(`
    WITH j AS (SELECT (now() AT TIME ZONE $1)::date AS today)
    SELECT
      COALESCE(SUM(o.amount_htg) FILTER (WHERE ${PAIDO}),0)::int AS total_htg,
      COUNT(*) FILTER (WHERE ${PAIDO})::int AS total_count,
      COALESCE(SUM(o.amount_htg) FILTER (WHERE ${PAIDO}
        AND (o.created_at AT TIME ZONE $1)::date = j.today),0)::int AS today_htg,
      COUNT(*) FILTER (WHERE ${PAIDO}
        AND (o.created_at AT TIME ZONE $1)::date = j.today)::int AS today_count,
      COALESCE(SUM(o.amount_htg) FILTER (WHERE ${PAIDO}
        AND (o.created_at AT TIME ZONE $1)::date > j.today - 7),0)::int AS week_htg,
      COALESCE(SUM(o.amount_htg) FILTER (WHERE ${PAIDO}
        AND date_trunc('month', o.created_at AT TIME ZONE $1)
            = date_trunc('month', j.today)),0)::int AS month_htg,
      COUNT(*) FILTER (WHERE o.status = 'PENDING')::int AS pending_count,
      COUNT(*) FILTER (WHERE o.status = 'EXPIRED')::int AS expired_count
    FROM orders o
    JOIN routers r ON r.id = o.router_id, j
    WHERE r.tenant_id = $2`, [TZ, tenantId]);
  return rows[0];
}

// Recette par jour sur une fenêtre glissante, jours vides inclus (sinon le
// graphique ment en resserrant les jours sans vente).
export async function salesByDay(tenantId, days = 30) {
  const { rows } = await pool.query(`
    WITH bornes AS (
      SELECT generate_series(
        (now() AT TIME ZONE $1)::date - ($2::int - 1),
        (now() AT TIME ZONE $1)::date,
        '1 day')::date AS jour
    ),
    ventes AS (
      SELECT (o.created_at AT TIME ZONE $1)::date AS jour, o.amount_htg AS htg
        FROM orders o JOIN routers r ON r.id = o.router_id
       WHERE ${PAIDO} AND r.tenant_id = $3
      UNION ALL
      SELECT (v.used_at AT TIME ZONE $1)::date, p.price_htg
        FROM vouchers v JOIN plans p ON p.id = v.plan_id
        JOIN routers r ON r.id = v.router_id
       WHERE v.source = 'batch' AND v.used_at IS NOT NULL AND r.tenant_id = $3
    )
    SELECT b.jour,
           COALESCE(SUM(x.htg),0)::int AS htg,
           COUNT(x.*)::int AS ventes
      FROM bornes b LEFT JOIN ventes x ON x.jour = b.jour
     GROUP BY b.jour ORDER BY b.jour`, [TZ, days, tenantId]);
  return rows;
}

export async function salesByPlan(tenantId) {
  const { rows } = await pool.query(`
    WITH tout AS (
      SELECT o.plan_id, o.router_id, o.amount_htg AS htg, 'en ligne' AS canal
        FROM orders o JOIN routers r ON r.id = o.router_id
       WHERE ${PAIDO} AND r.tenant_id = $1
      UNION ALL
      SELECT v.plan_id, v.router_id, p.price_htg, 'espèces'
        FROM vouchers v JOIN plans p ON p.id = v.plan_id
        JOIN routers r ON r.id = v.router_id
       WHERE v.source = 'batch' AND v.used_at IS NOT NULL AND r.tenant_id = $1
    )
    SELECT p.label, r.name AS router_name,
           COUNT(*)::int AS ventes,
           COALESCE(SUM(t.htg),0)::int AS htg,
           COUNT(*) FILTER (WHERE t.canal = 'en ligne')::int AS en_ligne,
           COUNT(*) FILTER (WHERE t.canal = 'espèces')::int AS especes
      FROM tout t
      JOIN plans p ON p.id = t.plan_id
      JOIN routers r ON r.id = t.router_id
     GROUP BY p.label, r.name
     ORDER BY htg DESC`, [tenantId]);
  return rows;
}

export async function salesByMethod(tenantId) {
  const { rows } = await pool.query(`
    SELECT o.method, COUNT(*)::int AS ventes,
           COALESCE(SUM(o.amount_htg),0)::int AS htg
      FROM orders o JOIN routers r ON r.id = o.router_id
     WHERE ${PAIDO} AND r.tenant_id = $1
     GROUP BY o.method ORDER BY htg DESC`, [tenantId]);
  return rows;
}

// Toutes les ventes, tous canaux, pour l'export comptable.
export async function allSales(tenantId) {
  const { rows } = await pool.query(`
    SELECT o.created_at AS date, r.name AS routeur, p.label AS forfait,
           o.amount_htg AS montant, 'en ligne' AS canal, o.method AS moyen,
           o.reference, o.status AS etat,
           (SELECT code FROM vouchers WHERE id = o.voucher_id) AS code
      FROM orders o JOIN routers r ON r.id = o.router_id
      JOIN plans p ON p.id = o.plan_id
     WHERE ${PAIDO} AND r.tenant_id = $1
    UNION ALL
    SELECT v.used_at, r.name, p.label, p.price_htg, 'espèces', 'espèces',
           '', 'utilisé', v.code
      FROM vouchers v JOIN routers r ON r.id = v.router_id
      JOIN plans p ON p.id = v.plan_id
     WHERE v.source = 'batch' AND v.used_at IS NOT NULL AND r.tenant_id = $1
    ORDER BY date DESC`, [tenantId]);
  return rows;
}

export async function salesSummary(tenantId) {
  const { rows } = await pool.query(
    `SELECT r.name AS router_name,
            count(*) FILTER (WHERE o.status IN ('PAID','DELIVERED')) AS paid_count,
            COALESCE(sum(o.amount_htg) FILTER (WHERE o.status IN ('PAID','DELIVERED')), 0) AS total_htg
       FROM orders o JOIN routers r ON r.id = o.router_id
      WHERE r.tenant_id = $1
      GROUP BY r.name ORDER BY total_htg DESC`, [tenantId]);
  return rows;
}

// Sauvegarde complète, portable : de quoi tout reconstruire si la base est
// perdue (l'offre gratuite d'un hébergeur n'est pas une sauvegarde).
export async function dumpAll(tenantId) {
  const t = async (sql) => (await pool.query(sql, [tenantId])).rows;
  const [routers, plans, vouchers, orders] = await Promise.all([
    t(`SELECT id, slug, name, portal_url, last_seen, created_at
         FROM routers WHERE tenant_id = $1 ORDER BY id`),
    t(`SELECT p.* FROM plans p JOIN routers r ON r.id = p.router_id
        WHERE r.tenant_id = $1 ORDER BY p.id`),
    t(`SELECT v.* FROM vouchers v JOIN routers r ON r.id = v.router_id
        WHERE r.tenant_id = $1 ORDER BY v.id`),
    t(`SELECT o.* FROM orders o JOIN routers r ON r.id = o.router_id
        WHERE r.tenant_id = $1 ORDER BY o.created_at`),
  ]);
  return {
    version: 1,
    genere_le: new Date().toISOString(),
    // Les jetons des routeurs sont volontairement exclus : une sauvegarde
    // circule (mail, clé USB) et ne doit pas donner la main sur un routeur.
    // Les identifiants Pay'm sont exclus au meme titre : une sauvegarde
    // circule, et ceux-la donnent acces a l'encaissement.
    note: "pull_token et identifiants Pay'm exclus",
    routers, plans, vouchers, orders,
  };
}

export { pool };
