// Authentification du dashboard : comptes nominatifs et rôles.
//
// Avant, un seul mot de passe partagé vivait dans les variables
// d'environnement. Impossible de savoir qui avait fait quoi, et impossible de
// confier la vente à quelqu'un sans lui ouvrir les finances.
//
// ADMIN_PASSWORD reste accepté **tant qu'aucun compte n'existe**, le temps de
// créer le premier propriétaire. Dès qu'un compte actif existe, il cesse de
// fonctionner : le laisser vivre en ferait une porte dérobée permanente.

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { safeEqual } from "../codes.js";
import { layout } from "./html.js";
import {
  compterUtilisateurs, getUserByEmail, getUserById, verifierMotDePasse,
  touchUserLogin, createUser, getTenant,
} from "../db.js";

const SESSION_COOKIE = "mvm_session";

// Le secret de session dérive d'ADMIN_PASSWORD, déjà obligatoire : aucune
// variable d'environnement supplémentaire à poser, et le changer déconnecte
// tout le monde — ce qu'on veut d'un mot de passe de secours.
function signer(charge) {
  return createHmac("sha256", config.adminPassword)
    .update("mikrovoucher-session-v2|" + charge).digest("hex");
}

// La signature couvre l'empreinte du mot de passe : changer son mot de passe
// invalide ses propres sessions, y compris celles ouvertes ailleurs.
function jeton(user) {
  const charge = `${user.id}.${String(user.pass_hash).slice(-12)}`;
  return charge + "." + signer(charge);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Renvoie l'utilisateur du cookie, ou null. `null` avec bootstrap=true
// signifie « connecté par le mot de passe de secours, aucun compte encore ».
async function utilisateurDeLaRequete(req) {
  const brut = parseCookies(req)[SESSION_COOKIE] || "";
  const bouts = brut.split(".");
  if (bouts.length !== 3) return null;
  const [id, empreinte, signature] = bouts;
  const charge = `${id}.${empreinte}`;
  const attendu = Buffer.from(signer(charge), "utf8");
  const recu = Buffer.from(signature, "utf8");
  if (attendu.length !== recu.length || !timingSafeEqual(attendu, recu)) return null;

  if (id === "bootstrap") {
    // Session de secours : ne vaut que tant qu'aucun compte n'existe.
    return (await compterUtilisateurs()) === 0
      ? { id: null, email: "secours", name: "Accès de secours", role: "owner", bootstrap: true }
      : null;
  }
  const user = await getUserById(Number(id));
  if (!user || !user.active) return null;
  if (String(user.pass_hash).slice(-12) !== empreinte) return null;  // mot de passe changé
  // Organisation suspendue : le tableau de bord se ferme. Le portail, lui,
  // continue de servir les clients finaux — ils ont payé, ils n'y sont pour
  // rien.
  if (user.tenant_id) {
    const t = await getTenant(user.tenant_id);
    if (!t || !t.active) return null;
  }
  return user;
}

export function requireAdmin(req, res, next) {
  utilisateurDeLaRequete(req).then((user) => {
    if (!user) return res.redirect("/admin/login");
    req.user = user;
    next();
  }).catch(next);
}

// Réservé à l'exploitant du service : organisations et invitations.
export function requirePlatform(req, res, next) {
  if (req.user && (req.user.platform_admin || req.user.bootstrap)) return next();
  res.status(403).type("html").send(layout("Accès refusé", `
    <div class="card" style="max-width:460px;margin:60px auto;text-align:center">
      <h1>Accès refusé</h1>
      <p class="sub">Cette page est réservée à l'exploitant du service.</p>
      <a class="btn ghost" href="/admin/routers">Retour</a>
    </div>`));
}

// Réservé aux propriétaires : finances, réglages, comptes, tout ce qui
// détruit. Un vendeur crée et imprime des codes, il ne voit pas la caisse.
export function requireOwner(req, res, next) {
  if (req.user && req.user.role === "owner") return next();
  res.status(403).type("html").send(layout("Accès refusé", `
    <div class="card" style="max-width:460px;margin:60px auto;text-align:center">
      <h1>Accès refusé</h1>
      <p class="sub">Cette page est réservée au propriétaire du compte.</p>
      <a class="btn ghost" href="/admin/routers">Retour</a>
    </div>`));
}

// Anti brute-force du login (par IP).
const fails = new Map();
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60_000;

export async function loginPage(res, error = "") {
  const vierge = (await compterUtilisateurs()) === 0;
  res.type("html").send(layout("Connexion", `
    <div class="card" style="max-width:400px;margin:60px auto;text-align:center">
      <h1>Connexion</h1>
      <p class="sub">Dashboard Mikrovoucher</p>
      ${error ? `<p class="err-msg">${error}</p>` : ""}
      ${vierge ? `
        <p class="sub" style="margin-bottom:14px">Aucun compte n'existe encore.
        Entrez le mot de passe d'administration pour créer le premier.</p>
        <form method="post" action="/admin/login" style="display:flex;flex-direction:column;gap:12px">
          <input type="password" name="password" placeholder="Mot de passe d'administration" autofocus required>
          <button type="submit">Entrer</button>
        </form>` : `
        <form method="post" action="/admin/login" style="display:flex;flex-direction:column;gap:12px">
          <input type="email" name="email" placeholder="Adresse e-mail" autocomplete="username" autofocus required>
          <input type="password" name="password" placeholder="Mot de passe" autocomplete="current-password" required>
          <button type="submit">Entrer</button>
        </form>`}
    </div>`));
}

function poserCookie(req, res, valeur) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=${valeur}; HttpOnly; SameSite=Lax; Path=/;` +
    `${secure ? " Secure;" : ""} Max-Age=${7 * 86400}`);
}

export async function handleLogin(req, res) {
  const ip = req.ip || "unknown";
  const rec = fails.get(ip);
  if (rec && rec.count >= MAX_FAILS && Date.now() < rec.lockUntil) {
    return loginPage(res, "Trop de tentatives. Réessayez dans un quart d'heure.");
  }
  const echec = () => {
    const r = fails.get(ip) || { count: 0, lockUntil: 0 };
    r.count += 1; r.lockUntil = Date.now() + LOCK_MS;
    fails.set(ip, r);
  };

  const motDePasse = String((req.body || {}).password || "");
  const email = String((req.body || {}).email || "").trim();

  // Aucun compte : le mot de passe de secours ouvre une session le temps de
  // créer le premier propriétaire.
  if ((await compterUtilisateurs()) === 0) {
    if (!safeEqual(motDePasse, config.adminPassword)) {
      echec();
      return loginPage(res, "Mot de passe incorrect.");
    }
    fails.delete(ip);
    poserCookie(req, res, "bootstrap.-." + signer("bootstrap.-"));
    return res.redirect("/admin/premier-demarrage");
  }

  const user = email ? await getUserByEmail(email) : null;
  // Message unique : dire « cet e-mail n'existe pas » livrerait la liste des
  // comptes à qui essaie.
  if (!user || !user.active || !verifierMotDePasse(motDePasse, user.pass_hash)) {
    echec();
    return loginPage(res, "E-mail ou mot de passe incorrect.");
  }
  if (user.tenant_id) {
    const t = await getTenant(user.tenant_id);
    if (!t || !t.active) {
      return loginPage(res, "Ce compte est suspendu. Contactez le service.");
    }
  }
  fails.delete(ip);
  await touchUserLogin(user.id);
  poserCookie(req, res, jeton(user));
  res.redirect("/admin/routers");
}

export function handleLogout(req, res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.redirect("/admin/login");
}

// Réouvre une session après un changement de mot de passe : sans cela, la
// personne qui vient de changer le sien serait déconnectée sur-le-champ.
export function reposerSession(req, res, user) {
  poserCookie(req, res, jeton(user));
}

export { createUser };
