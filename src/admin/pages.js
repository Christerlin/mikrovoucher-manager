// Pages du dashboard : routeurs, plans, vouchers, ventes.

import { Router } from "express";
import { config } from "../config.js";
import {
  listRouters, getRouter, createRouter, deleteRouter,
  listPlans, upsertPlan, deactivatePlan, getPlan,
  createVoucher, listVouchers, getVouchersByIds,
  listOrders, salesSummary,
} from "../db.js";
import { generateRouterToken, generateVoucherCode } from "../codes.js";
import { layout, esc } from "./html.js";
import { requireAdmin, loginPage, handleLogin, handleLogout } from "./auth.js";

export const adminRouter = Router();

adminRouter.get("/admin/login", (req, res) => loginPage(res));
adminRouter.post("/admin/login", handleLogin);
adminRouter.post("/admin/logout", handleLogout);
adminRouter.get("/admin", requireAdmin, (req, res) => res.redirect("/admin/routers"));

// Base publique de l'app (pour générer les scripts routeur).
function publicBase(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  return `${proto}://${req.headers.host}`;
}

function onlinePill(lastSeen) {
  if (!lastSeen) return `<span class="pill off">Jamais vu</span>`;
  const ageS = (Date.now() - new Date(lastSeen).getTime()) / 1000;
  if (ageS < 90) return `<span class="pill ok">En ligne</span>`;
  return `<span class="pill off">Hors ligne (${Math.round(ageS / 60)} min)</span>`;
}

// ------------------------------------------------------------- routeurs ----
adminRouter.get("/admin/routers", requireAdmin, async (req, res) => {
  const routers = await listRouters();
  const rows = routers.map((r) => `
    <tr>
      <td><a href="/admin/routers/${r.id}"><strong>${esc(r.name)}</strong></a></td>
      <td class="mono">${esc(r.slug)}</td>
      <td>${onlinePill(r.last_seen)}</td>
      <td>${r.pending_commands > 0 ? `<span class="pill wait">${r.pending_commands} en file</span>` : "—"}</td>
    </tr>`).join("");

  res.type("html").send(layout("Routeurs", `
    <h1>Routeurs</h1>
    <p class="sub">Chaque routeur MikroTik vient tirer ses commandes ici (aucun port à ouvrir chez lui).</p>
    <div class="card">
      <table>
        <tr><th>Nom</th><th>Slug</th><th>État</th><th>Commandes</th></tr>
        ${rows || `<tr><td colspan="4" style="color:var(--ink-soft)">Aucun routeur — ajoutez le premier ci-dessous.</td></tr>`}
      </table>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Ajouter un routeur</h2>
      <form class="inline" method="post" action="/admin/routers">
        <label>Nom <input name="name" placeholder="LambdaWifi principal" required></label>
        <label>Slug <input name="slug" pattern="[a-z0-9-]+" placeholder="lambda" required></label>
        <label>URL du portail <input name="portal_url" placeholder="http://lambda.connect/prix.html" size="32"></label>
        <button type="submit">Créer</button>
      </form>
      <p class="sub" style="margin:10px 0 0">Le slug identifie le routeur dans l'API du portail
      (lettres minuscules/chiffres/tirets). L'URL du portail sert au retour de paiement.</p>
    </div>`, { active: "routers" }));
});

adminRouter.post("/admin/routers", requireAdmin, async (req, res) => {
  const { name, slug, portal_url } = req.body || {};
  if (!name || !/^[a-z0-9-]+$/.test(String(slug || ""))) return res.redirect("/admin/routers");
  try {
    const r = await createRouter({
      name: String(name), slug: String(slug),
      pullToken: generateRouterToken(),
      portalUrl: String(portal_url || ""),
    });
    res.redirect(`/admin/routers/${r.id}`);
  } catch (err) {
    console.error("[routers:create]", err.message);
    res.redirect("/admin/routers");
  }
});

adminRouter.post("/admin/routers/:id/delete", requireAdmin, async (req, res) => {
  await deleteRouter(Number(req.params.id));
  res.redirect("/admin/routers");
});

// Script RouterOS généré pour un routeur donné (agent pull + walled-garden).
function agentRsc(router, base) {
  const host = base.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return `# =====================================================================
# Mikrovoucher — agent pour "${router.name}" (genere par le dashboard)
# RouterOS v7. Importer sur le routeur : /import mikrovoucher-agent.rsc
# Prerequis : /system device-mode print -> hotspot=yes fetch=yes scheduler=yes
# =====================================================================
/system script
add name=mikrovoucher-agent dont-require-permissions=no source={
  :local backend "${base}";
  :local token "${router.pull_token}";
  :local more true;
  :for i from=1 to=10 do={
    :if ($more) do={
      :local body "";
      :do {
        :set body ([/tool fetch url=("$backend/agent/next") \\
          http-header-field=("x-router-token: $token") \\
          http-method=get output=user as-value]->"data");
      } on-error={ :set body ""; }
      :if ([:len $body] = 0) do={ :set more false; } else={
        :local p1 [:find $body "|"];
        :local cmdid [:pick $body 0 $p1];
        :local rest [:pick $body ($p1 + 1) [:len $body]];
        :local p2 [:find $rest "|"];
        :local action [:pick $rest 0 $p2];
        :set rest [:pick $rest ($p2 + 1) [:len $rest]];
        :local p3 [:find $rest "|"];
        :local code [:pick $rest 0 $p3];
        :set rest [:pick $rest ($p3 + 1) [:len $rest]];
        :local p4 [:find $rest "|"];
        :local up [:pick $rest 0 $p4];
        :local cmt [:pick $rest ($p4 + 1) [:len $rest]];
        :if ($action = "add") do={
          :if ([:len [/ip hotspot user find name=$code]] = 0) do={
            :do { /ip hotspot user add name=$code password=$code \\
              limit-uptime=$up comment=$cmt; } on-error={}
          }
        }
        :if ($action = "remove") do={
          :do { /ip hotspot user remove [find name=$code]; } on-error={}
        }
        :do {
          /tool fetch url=("$backend/agent/ack?id=$cmdid") \\
            http-header-field=("x-router-token: $token") \\
            http-method=get keep-result=no;
        } on-error={}
      }
    }
  }
}
/system scheduler
add name=mikrovoucher-sched interval=15s on-event="/system script run mikrovoucher-agent" \\
  comment="Mikrovoucher : tire les commandes du manager"
# Walled-garden : les clients non connectes doivent atteindre le manager
/ip hotspot walled-garden
add dst-host=${host} comment="mikrovoucher manager"
`;
}

adminRouter.get("/admin/routers/:id", requireAdmin, async (req, res) => {
  const router = await getRouter(Number(req.params.id));
  if (!router) return res.redirect("/admin/routers");
  const [plans, vouchers] = await Promise.all([
    listPlans(router.id), listVouchers(router.id, 40),
  ]);
  const base = publicBase(req);

  const planRows = plans.map((p) => `
    <tr>
      <td class="mono">${esc(p.code)}</td><td>${esc(p.label)}</td>
      <td>${p.price_htg} HTG</td><td class="mono">${esc(p.uptime)}</td>
      <td>${p.active ? "" : `<span class="pill off">inactif</span>`}</td>
      <td><form method="post" action="/admin/routers/${router.id}/plans/delete" style="margin:0">
        <input type="hidden" name="code" value="${esc(p.code)}">
        <button class="danger">retirer</button></form></td>
    </tr>`).join("");

  const activePlans = plans.filter((p) => p.active);
  const voucherRows = vouchers.map((v) => `
    <tr>
      <td class="mono"><strong>${esc(v.code)}</strong></td>
      <td>${esc(v.plan_label || "—")}</td>
      <td>${v.source === "order" ? "vente en ligne" : "lot"}</td>
      <td>${v.status === "ON_ROUTER"
        ? `<span class="pill ok">sur le routeur</span>`
        : `<span class="pill wait">en file</span>`}</td>
      <td style="color:var(--ink-soft)">${new Date(v.created_at).toLocaleString("fr-FR")}</td>
    </tr>`).join("");

  res.type("html").send(layout(router.name, `
    <h1>${esc(router.name)} ${onlinePill(router.last_seen)}</h1>
    <p class="sub">Slug : <span class="mono">${esc(router.slug)}</span>
      &middot; Portail : <span class="mono">${esc(router.portal_url || "non défini")}</span></p>

    <div class="grid2">
      <div class="card">
        <h2 style="margin-top:0">Forfaits</h2>
        <table>
          <tr><th>Code</th><th>Nom</th><th>Prix</th><th>Durée</th><th></th><th></th></tr>
          ${planRows || `<tr><td colspan="6" style="color:var(--ink-soft)">Aucun forfait.</td></tr>`}
        </table>
        <h2>Ajouter / modifier un forfait</h2>
        <form class="inline" method="post" action="/admin/routers/${router.id}/plans">
          <label>Code <input name="code" placeholder="3j" size="4" required></label>
          <label>Nom <input name="label" placeholder="3 jours" size="10" required></label>
          <label>Prix HTG <input name="price_htg" type="number" min="20" size="6" required></label>
          <label>Durée RouterOS <input name="uptime" placeholder="3d" size="5" required></label>
          <button type="submit">Enregistrer</button>
        </form>
      </div>

      <div class="card">
        <h2 style="margin-top:0">Générer des vouchers (lot)</h2>
        <form class="inline" method="post" action="/admin/routers/${router.id}/vouchers">
          <label>Forfait
            <select name="plan_code" required>
              ${activePlans.map((p) => `<option value="${esc(p.code)}">${esc(p.label)} — ${p.price_htg} HTG</option>`).join("")}
            </select></label>
          <label>Quantité <input name="count" type="number" min="1" max="200" value="10" required></label>
          <button type="submit" ${activePlans.length === 0 ? "disabled" : ""}>Générer + imprimer</button>
        </form>
        <p class="sub" style="margin:10px 0 0">Les codes sont créés sur le routeur par l'agent
        (&le; 15 s s'il est en ligne), puis la page d'impression s'ouvre.</p>

        <h2>Script agent (à importer une fois sur ce routeur)</h2>
        <textarea readonly onclick="this.select()">${esc(agentRsc(router, base))}</textarea>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Derniers vouchers</h2>
      <table>
        <tr><th>Code</th><th>Forfait</th><th>Origine</th><th>État</th><th>Créé</th></tr>
        ${voucherRows || `<tr><td colspan="5" style="color:var(--ink-soft)">Aucun voucher.</td></tr>`}
      </table>
    </div>

    <form method="post" action="/admin/routers/${router.id}/delete"
          onsubmit="return confirm('Supprimer ce routeur et tout son historique ?')">
      <button class="danger">Supprimer ce routeur</button>
    </form>`, { active: "routers" }));
});

adminRouter.post("/admin/routers/:id/plans", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { code, label, price_htg, uptime } = req.body || {};
  if (code && label && price_htg && uptime) {
    await upsertPlan({
      routerId: id, code: String(code).toLowerCase(), label: String(label),
      priceHtg: Number(price_htg), uptime: String(uptime),
    });
  }
  res.redirect(`/admin/routers/${id}`);
});

adminRouter.post("/admin/routers/:id/plans/delete", requireAdmin, async (req, res) => {
  await deactivatePlan(Number(req.params.id), String((req.body || {}).code || ""));
  res.redirect(`/admin/routers/${req.params.id}`);
});

adminRouter.post("/admin/routers/:id/vouchers", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const router = await getRouter(id);
  if (!router) return res.redirect("/admin/routers");
  const plan = await getPlan(id, String((req.body || {}).plan_code || ""));
  const count = Math.min(Math.max(Number((req.body || {}).count || 0), 1), 200);
  if (!plan) return res.redirect(`/admin/routers/${id}`);

  const ids = [];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const v = await createVoucher({
          routerId: id, code: generateVoucherCode(8), planId: plan.id,
          uptime: plan.uptime, source: "batch", comment: `lot ${new Date().toISOString().slice(0, 10)}`,
        });
        ids.push(v.id);
        break;
      } catch (err) {
        if (String(err.code) !== "23505") throw err; // collision -> retirage
      }
    }
  }
  res.redirect(`/admin/print?ids=${ids.join(",")}`);
});

// Page d'impression des vouchers (tickets à découper).
adminRouter.get("/admin/print", requireAdmin, async (req, res) => {
  const ids = String(req.query.ids || "").split(",").map(Number).filter(Number.isInteger);
  if (ids.length === 0) return res.redirect("/admin/routers");
  const vouchers = await getVouchersByIds(ids);
  const tickets = vouchers.map((v) => `
    <div class="tk">
      <div class="tk-brand">Code WiFi</div>
      <div class="tk-code">${esc(v.code)}</div>
      <div class="tk-plan">${esc(v.plan_label || "")} — ${v.price_htg ?? ""} HTG</div>
    </div>`).join("");

  res.type("html").send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Impression vouchers</title>
<style>
body{font-family:system-ui,Arial;margin:20px;background:#fff}
.bar{margin-bottom:16px}
.bar button{padding:10px 20px;border:0;border-radius:8px;background:#c2410c;color:#fff;font-weight:700;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
.tk{border:2px dashed #999;border-radius:10px;padding:12px;text-align:center;page-break-inside:avoid}
.tk-brand{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#666}
.tk-code{font-family:ui-monospace,Consolas,monospace;font-size:21px;font-weight:800;letter-spacing:.2em;margin:6px 0}
.tk-plan{font-size:11px;color:#444}
@media print{.bar{display:none}body{margin:0}}
</style></head><body>
<div class="bar"><button onclick="window.print()">Imprimer</button>
  <a href="javascript:history.back()" style="margin-left:12px">Retour</a></div>
<div class="grid">${tickets}</div>
</body></html>`);
});

// --------------------------------------------------------------- ventes ----
adminRouter.get("/admin/orders", requireAdmin, async (req, res) => {
  const [orders, summary] = await Promise.all([listOrders(200), salesSummary()]);
  const sumRows = summary.map((s) => `
    <tr><td>${esc(s.router_name)}</td><td>${s.paid_count}</td><td><strong>${s.total_htg} HTG</strong></td></tr>`).join("");
  const rows = orders.map((o) => `
    <tr>
      <td class="mono" style="font-size:12px">${esc(o.reference)}</td>
      <td>${esc(o.router_name)}</td>
      <td>${esc(o.plan_label)}</td>
      <td>${o.amount_htg} HTG</td>
      <td>${esc(o.method)}</td>
      <td>${o.status === "DELIVERED" ? `<span class="pill ok">livré</span>`
          : o.status === "PAID" ? `<span class="pill wait">payé</span>`
          : o.status === "EXPIRED" ? `<span class="pill off">expiré</span>`
          : `<span class="pill wait">en attente</span>`}</td>
      <td class="mono">${esc(o.voucher_code || "—")}</td>
      <td style="color:var(--ink-soft);font-size:12px">${new Date(o.created_at).toLocaleString("fr-FR")}</td>
    </tr>`).join("");

  res.type("html").send(layout("Ventes", `
    <h1>Ventes en ligne</h1>
    <p class="sub">Paiements Moncash / Natcash / Kashpaw via Pay'm.</p>
    <div class="card">
      <h2 style="margin-top:0">Résumé par routeur</h2>
      <table><tr><th>Routeur</th><th>Ventes payées</th><th>Total</th></tr>
      ${sumRows || `<tr><td colspan="3" style="color:var(--ink-soft)">Aucune vente.</td></tr>`}</table>
    </div>
    <div class="card">
      <table>
        <tr><th>Référence</th><th>Routeur</th><th>Forfait</th><th>Montant</th>
            <th>Méthode</th><th>État</th><th>Code</th><th>Date</th></tr>
        ${rows || `<tr><td colspan="8" style="color:var(--ink-soft)">Aucune commande.</td></tr>`}
      </table>
    </div>`, { active: "orders" }));
});
