// Authentification du dashboard : un seul admin (c'est votre instance).
// Cookie de session = HMAC dérivé du mot de passe -> changer ADMIN_PASSWORD
// invalide toutes les sessions.

import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { safeEqual } from "../codes.js";
import { layout } from "./html.js";

const SESSION_COOKIE = "mvm_session";

function sessionValue() {
  return createHmac("sha256", config.adminPassword)
    .update("mikrovoucher-admin-session-v1").digest("hex");
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function isLoggedIn(req) {
  const cookie = parseCookies(req)[SESSION_COOKIE] || "";
  return safeEqual(cookie, sessionValue());
}

export function requireAdmin(req, res, next) {
  if (isLoggedIn(req)) return next();
  res.redirect("/admin/login");
}

// Anti brute-force du login (par IP).
const fails = new Map();
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60_000;

export function loginPage(res, error = "") {
  res.type("html").send(layout("Connexion", `
    <div class="card" style="max-width:380px;margin:60px auto;text-align:center">
      <h1>Connexion</h1>
      <p class="sub">Dashboard Mikrovoucher</p>
      ${error ? `<p class="err-msg">${error}</p>` : ""}
      <form method="post" action="/admin/login" style="display:flex;flex-direction:column;gap:12px">
        <input type="password" name="password" placeholder="Mot de passe admin" autofocus required>
        <button type="submit">Entrer</button>
      </form>
    </div>`));
}

export function handleLogin(req, res) {
  const ip = req.ip || "unknown";
  const rec = fails.get(ip);
  if (rec && rec.count >= MAX_FAILS && Date.now() < rec.lockUntil) {
    return loginPage(res, "Trop de tentatives. Réessayez plus tard.");
  }
  const password = String((req.body || {}).password || "");
  if (!safeEqual(password, config.adminPassword)) {
    const r = fails.get(ip) || { count: 0, lockUntil: 0 };
    r.count += 1; r.lockUntil = Date.now() + LOCK_MS;
    fails.set(ip, r);
    return loginPage(res, "Mot de passe incorrect.");
  }
  fails.delete(ip);
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=${sessionValue()}; HttpOnly; SameSite=Lax; Path=/;${secure ? " Secure;" : ""} Max-Age=${7 * 86400}`);
  res.redirect("/admin/routers");
}

export function handleLogout(req, res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.redirect("/admin/login");
}
