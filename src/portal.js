// API utilisée par les portails captifs (prix.html sur chaque routeur).
// Reprend le flux éprouvé en production : checkout -> redirection Pay'm ->
// retour (Return URL) -> suivi -> livraison par l'agent du routeur.

import { Router } from "express";
import { config } from "./config.js";
import {
  getRouterBySlug, getPlan, createOrder, getOrder, getOrderByPin,
  getOrderByHandoff, setHandoff, getPendingOrders, expireOrder,
  expireUsedVouchers,
} from "./db.js";
import { paymentsEnabled, createPayment, verifyPayment } from "./paym.js";
import {
  generateReference, generateClaimToken, generateRetrievalPin, sha256, safeEqual,
} from "./codes.js";
import { processOrder } from "./deliver.js";

export const portalRouter = Router();

// Filet de sécurité : un handler async qui rejette ne doit jamais tuer le
// process (Express 4 ne les rattrape pas de lui-même).
["get", "post"].forEach(function (method) {
  const original = portalRouter[method].bind(portalRouter);
  portalRouter[method] = function (path, ...handlers) {
    return original(path, ...handlers.map((h) =>
      typeof h === "function" && h.length < 4
        ? function (req, res, next) { Promise.resolve(h(req, res, next)).catch(next); }
        : h));
  };
});

const METHODS = new Set(["moncash", "natcash", "kashpaw", "all"]);

// --- Limiteur de débit en mémoire (par IP) -----------------------------------
const hits = new Map();
function rateLimit(max) {
  return function (req, res, next) {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const rec = hits.get(ip) || { count: 0, reset: now + 60_000 };
    if (now > rec.reset) { rec.count = 0; rec.reset = now + 60_000; }
    rec.count += 1;
    hits.set(ip, rec);
    if (rec.count > max) return res.status(429).json({ error: "Trop de tentatives, réessayez dans une minute." });
    next();
  };
}

// Anti-martèlement de Pay'm : un verify max par commande par intervalle.
const lastVerify = new Map();
function verifyThrottled(reference) {
  const last = lastVerify.get(reference) || 0;
  if (Date.now() - last < config.verifyThrottleMs) return true;
  lastVerify.set(reference, Date.now());
  return false;
}

// Page de retour de Pay'm. L'URL de retour se regle une seule fois dans le
// compte Pay'm, pour tout le monde : si elle pointait vers le portail d'un
// operateur, les clients d'un autre atterriraient sur un hote qui n'existe
// pas chez eux. Elle pointe donc ici — le gestionnaire est deja joignable
// depuis tous les reseaux, l'agent l'ajoute lui-meme aux accès sans code.
//
// Aucune décision ne se prend ici : c'est l'onglet resté ouvert qui interroge
// le résultat et délivre le code. Cette page ne fait que le dire.
portalRouter.get("/retour", (req, res) => {
  const ok = String(req.query.statut || "").toLowerCase() === "ok";
  res.type("html").send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? "Paiement reçu" : "Paiement interrompu"}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#eef1f5;color:#101720;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;padding:24px}
  .c{background:#fff;border:1px solid #dde3ec;border-radius:20px;padding:30px 28px;
    max-width:380px;text-align:center;box-shadow:0 20px 40px -16px rgba(16,23,32,.18)}
  h1{font-family:Georgia,serif;font-size:22px;margin:0 0 8px}
  p{font-size:14px;line-height:1.5;color:#5c6b7a;margin:0 0 10px}
  .pastille{display:inline-block;padding:5px 14px;border-radius:999px;font-size:12px;
    font-weight:700;margin-bottom:14px}
  .ok{background:rgba(13,148,136,.14);color:#0d9488}
  .ko{background:rgba(217,119,6,.16);color:#d97706}
  strong{color:#101720}
</style></head><body><div class="c">
  <div class="pastille ${ok ? "ok" : "ko"}">${ok ? "Paiement reçu" : "Paiement non terminé"}</div>
  <h1>${ok ? "C'est bon." : "Rien n'a été prélevé."}</h1>
  ${ok
    ? `<p><strong>Revenez à l'onglet précédent</strong> — celui où vous avez
       choisi votre forfait. Votre code y apparaît tout seul, et la connexion
       se fait automatiquement.</p>
       <p>Ne fermez pas cet onglet-ci avant d'avoir vu votre code.</p>`
    : `<p>Le paiement n'est pas allé au bout. <strong>Revenez à l'onglet
       précédent</strong> pour réessayer.</p>`}
</div></body></html>`);
});

// 0) Plans d'un routeur (le portail peut s'afficher dynamiquement).
portalRouter.get("/api/portal/:slug/plans", rateLimit(60), async (req, res) => {
  try {
    const router = await getRouterBySlug(String(req.params.slug));
    if (!router) return res.status(404).json({ error: "Routeur inconnu." });
    const { listPlans } = await import("./db.js");
    const plans = await listPlans(router.id);
    res.json(plans.filter((p) => p.active).map((p) => ({
      id: p.code, label: p.label, htg: p.price_htg,
      uptime: p.uptime, devices: p.shared_users,
    })));
  } catch (err) {
    console.error("[plans]", err.message);
    res.status(502).json({ error: "Indisponible." });
  }
});

// 0b) Echeance reelle d'un code. Le routeur decompte le temps de CONNEXION ;
// l'acces, lui, expire 24 h apres la premiere connexion, hors ligne compris.
// Sans cela la page de statut annonce au client bien plus de temps qu'il n'en
// a vraiment, et le code meurt sans prevenir.
portalRouter.get("/api/portal/:slug/expiry/:code", rateLimit(60), async (req, res) => {
  try {
    const router = await getRouterBySlug(String(req.params.slug));
    if (!router) return res.status(404).json({ error: "Inconnu." });
    const code = String(req.params.code || "");
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(code)) return res.status(404).json({ error: "Inconnu." });
    const { echeanceVoucher } = await import("./db.js");
    const e = await echeanceVoucher(router.id, code);
    // Meme reponse pour un code inconnu, echu ou sans echeance : l'API ne
    // doit pas dire ce qui n'existe plus.
    if (!e) return res.status(404).json({ error: "Inconnu." });
    // Un code echu reste connu, et rechargeable : le portail doit pouvoir
    // proposer de le reprendre, alors qu'un code inconnu n'ouvre sur rien.
    res.json({
      restant: e.echu ? 0 : Math.max(0, e.restant),
      demarre: e.demarre, echu: e.echu,
    });
  } catch (err) {
    console.error("[expiry]", err.message);
    res.status(502).json({ error: "Indisponible." });
  }
});

// 0b-bis) Duree de l'essai, pour que la page de connexion l'annonce sans
// qu'on ait a rouvrir config.js sur le routeur a chaque changement.
portalRouter.get("/api/portal/:slug/trial", rateLimit(120), async (req, res) => {
  try {
    const router = await getRouterBySlug(String(req.params.slug));
    if (!router) return res.status(404).json({ error: "Inconnu." });
    res.json({ limite: router.trial_limit || "", reset: router.trial_reset || "" });
  } catch (err) {
    console.error("[trial]", err.message);
    res.status(502).json({ error: "Indisponible." });
  }
});

// 0c) Sponsors visibles maintenant. La vue est comptee ici : une requete =
// un affichage, plutot qu'un second aller-retour depuis la page.
portalRouter.get("/api/portal/:slug/sponsors", rateLimit(120), async (req, res) => {
  try {
    const router = await getRouterBySlug(String(req.params.slug));
    if (!router) return res.status(404).json({ error: "Inconnu." });
    const placement = ["login", "trial"].includes(String(req.query.ou))
      ? String(req.query.ou) : "login";
    const { sponsorsEnCours, compterVues } = await import("./db.js");
    const rows = await sponsorsEnCours(router.id, placement);
    if (rows.length > 0) {
      // Sans await : le client n'a pas a attendre un compteur.
      compterVues(rows.map((r) => r.id)).catch((e) => console.error("[vues]", e.message));
    }
    res.json(rows.map((r) => ({
      id: r.id, nom: r.name, accroche: r.baseline,
      contact: r.contact, image: r.image_path, ou: r.placement,
    })));
  } catch (err) {
    console.error("[sponsors]", err.message);
    res.status(502).json({ error: "Indisponible." });
  }
});

// 0d) Clic sur un sponsor. Sans reponse utile : c'est un compteur.
portalRouter.get("/api/portal/:slug/sponsors/:id/clic", rateLimit(120), async (req, res) => {
  try {
    const router = await getRouterBySlug(String(req.params.slug));
    const id = Number(req.params.id);
    if (!router || !Number.isInteger(id)) return res.status(204).end();
    const { compterClic } = await import("./db.js");
    await compterClic(router.id, id);
    res.status(204).end();
  } catch (err) {
    console.error("[clic]", err.message);
    res.status(204).end();
  }
});

// 1) Créer un paiement.
portalRouter.post("/api/checkout", rateLimit(12), async (req, res) => {
  try {
    const { routerSlug, planId, method, recharge } = req.body || {};
    if (!METHODS.has(method)) return res.status(400).json({ error: "Méthode de paiement invalide." });
    const router = await getRouterBySlug(String(routerSlug || ""));
    if (!router) return res.status(400).json({ error: "Routeur inconnu." });
    // Identifiants de l'operateur qui possede ce routeur : c'est chez lui que
    // l'argent arrive, pas chez nous.
    const { paymDuRouteur } = await import("./db.js");
    const compte = await paymDuRouteur(router.id);
    const clientId = compte ? compte.paym_client_id : null;
    // Fige a la commande qui a encaisse : le jour ou l'operateur pose ses
    // propres cles, l'historique doit rester lisible. Seul le drapeau
    // explicite compte — l'installation d'origine tire aussi ses cles de
    // l'environnement, mais ses ventes sont les siennes, pas une dette.
    const encaissePar = compte && compte.encaisse_par_service ? "service" : "operateur";
    if (!paymentsEnabled(clientId)) {
      return res.status(503).json({ error: "Paiement en ligne non configuré." });
    }
    // Abonnement de l'operateur echu : la vente en ligne s'arrete. Les codes
    // deja vendus, eux, continuent de fonctionner — leurs acheteurs n'y sont
    // pour rien.
    const { etatAbonnement } = await import("./db.js");
    const ab = router.tenant_id ? await etatAbonnement(router.tenant_id) : null;
    if (ab && ab.enRetard) {
      return res.status(503).json({
        error: "La vente en ligne est momentanément indisponible. Voyez le vendeur pour un code.",
      });
    }
    const plan = await getPlan(router.id, String(planId || ""));
    if (!plan) return res.status(400).json({ error: "Forfait invalide." });

    // Recharge : on prolonge un code en service au lieu d'en creer un neuf.
    // Verifie ici, avant tout paiement : prolonger un code inexistant ou deja
    // expire prendrait l'argent sans rien rendre.
    let rechargeCode = null;
    if (recharge) {
      const code = String(recharge).toUpperCase();
      if (!/^[A-Z0-9_-]{1,32}$/.test(code)) {
        return res.status(400).json({ error: "Code à recharger invalide." });
      }
      const { getVoucherByCode } = await import("./db.js");
      // Un code echu reste rechargeable : il renait avec le forfait paye, et
      // le client reprend SON code. Seul un code inconnu est refuse.
      const v = await getVoucherByCode(router.id, code);
      if (!v) {
        return res.status(400).json({ error: "Code inconnu : achetez un nouveau code." });
      }
      rechargeCode = code;
    }

    const reference = generateReference();
    const claimToken = generateClaimToken();
    const retrievalPin = generateRetrievalPin();
    const { redirectUrl, transactionId } = await createPayment({
      reference, montantHtg: plan.price_htg, method, clientId,
    });
    await createOrder({
      reference,
      routerId: router.id,
      planId: plan.id,
      amountHtg: plan.price_htg,
      method,
      claimHash: sha256(claimToken).toString("hex"),
      retrievalPin,
      transactionId,
      rechargeCode,
      encaissePar,
    });
    res.json({ reference, claimToken, retrievalPin, redirectUrl });
  } catch (err) {
    console.error("[checkout]", err.message);
    res.status(502).json({ error: "Échec de la création du paiement. Réessayez." });
  }
});

// 2) Suivi d'une commande (claim token requis — pas d'énumération).
portalRouter.get("/api/order/:reference", rateLimit(40), async (req, res) => {
  try {
    const order = await getOrder(String(req.params.reference));
    const claim = req.headers["x-claim-token"] || "";
    if (!order || !safeEqual(sha256(claim), Buffer.from(order.claim_hash, "hex"))) {
      return res.status(404).json({ error: "Commande introuvable." });
    }
    if (order.status === "PENDING" && verifyThrottled(order.reference)) {
      return res.json({ status: "PENDING" });
    }
    res.json(await processOrder(order));
  } catch (err) {
    console.error("[order]", err.message);
    res.status(502).json({ error: "Vérification indisponible, réessayez." });
  }
});

// 2b) Récupération par PIN (secours) — verrou par PIN contre le brute force.
const pinFails = new Map();
const PIN_MAX_ATTEMPTS = 8;
const PIN_LOCK_MS = 15 * 60_000;
portalRouter.get("/api/retrieve/:pin", rateLimit(15), async (req, res) => {
  try {
    const pin = String(req.params.pin || "").toUpperCase().replace(/\s+/g, "");
    if (!pin) return res.status(404).json({ error: "Code introuvable." });
    const rec = pinFails.get(pin);
    if (rec && rec.count >= PIN_MAX_ATTEMPTS && Date.now() < rec.lockUntil) {
      return res.status(429).json({ error: "Trop de tentatives pour ce code. Réessayez plus tard." });
    }
    const order = await getOrderByPin(pin);
    if (!order) {
      const r = pinFails.get(pin) || { count: 0, lockUntil: 0 };
      r.count += 1; r.lockUntil = Date.now() + PIN_LOCK_MS;
      pinFails.set(pin, r);
      return res.status(404).json({ error: "Code introuvable." });
    }
    pinFails.delete(pin);
    if (order.status === "PENDING" && verifyThrottled(order.reference)) {
      return res.json({ status: "PENDING" });
    }
    res.json(await processOrder(order));
  } catch (err) {
    console.error("[retrieve]", err.message);
    res.status(502).json({ error: "Vérification indisponible, réessayez." });
  }
});

// 2c) Échange du jeton de passation (remis par /return).
portalRouter.get("/api/handoff/:token", rateLimit(40), async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const order = token ? await getOrderByHandoff(sha256(token).toString("hex")) : null;
    if (!order) return res.status(404).json({ error: "Lien expiré ou invalide." });
    if (order.status === "PENDING" && verifyThrottled(order.reference)) {
      return res.json({ status: "PENDING" });
    }
    res.json(await processOrder(order));
  } catch (err) {
    console.error("[handoff]", err.message);
    res.status(502).json({ error: "Vérification indisponible, réessayez." });
  }
});

// 3) Return URL Pay'm. RÈGLE : toujours rediriger vite, même base morte.
//    Le portail de destination est celui du routeur de la commande.
portalRouter.get("/return", rateLimit(30), async (req, res) => {
  console.log("[return] query:", JSON.stringify(req.query));
  // Défaut si on ne retrouve pas la commande : page neutre.
  let target = null;
  try {
    const reference = Object.values(req.query)
      .map((v) => String(v))
      .find((v) => /^VCH-\d{8}-[A-Z0-9]+$/.test(v));
    if (reference) {
      const work = (async () => {
        const order = await getOrder(reference);
        if (!order) return null;
        const { getRouter } = await import("./db.js");
        const router = await getRouter(order.router_id);
        if (!router || !router.portal_url) return null;
        const handoff = generateClaimToken();
        await setHandoff(reference, sha256(handoff).toString("hex"),
          new Date(Date.now() + config.handoffTtlMs));
        const sep = router.portal_url.includes("?") ? "&" : "?";
        return `${router.portal_url}${sep}t=${encodeURIComponent(handoff)}`;
      })();
      target = await Promise.race([
        work,
        new Promise((resolve) => setTimeout(() => resolve(null), config.returnDbTimeoutMs)),
      ]);
    }
  } catch (err) {
    console.error("[return]", err.message);
  }
  if (target) return res.redirect(302, target);
  // Impossible d'identifier la commande/routeur : page neutre de confirmation.
  res.type("html").send(`<!doctype html><meta charset="utf-8">
    <title>Paiement reçu</title>
    <body style="font-family:system-ui;text-align:center;padding:40px">
    <h2>Paiement reçu</h2>
    <p>Reconnectez-vous au WiFi et ouvrez le portail pour récupérer votre code
    (bouton « Déjà payé ? »).</p></body>`);
});

// --- Cron de réconciliation (clients jamais revenus) -------------------------
export async function reconcile() {
  // Vouchers dont la validité calendaire est écoulée : on les retire du routeur.
  try {
    const n = await expireUsedVouchers();
    if (n > 0) console.log(`[expiry] ${n} voucher(s) arrivé(s) à échéance`);
  } catch (err) {
    console.error("[expiry]", err.message);
  }

  let pending;
  try { pending = await getPendingOrders(); }
  catch (err) { return console.error("[reconcile] lecture:", err.message); }
  for (const order of pending) {
    try { await processOrder(order); }
    catch (err) { console.error(`[reconcile] ${order.reference}:`, err.message); }
  }
  const ageMs = config.orderExpiryMinutes * 60_000;
  for (const order of pending) {
    if (Date.now() - new Date(order.created_at).getTime() < ageMs) continue;
    try {
      const { paid } = await verifyPayment(order.reference);
      if (!paid) await expireOrder(order.reference);
    } catch { /* prochain tour */ }
  }
}
