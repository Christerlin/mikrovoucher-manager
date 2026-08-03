// Pages du dashboard : routeurs, plans, vouchers, ventes.

import { Router } from "express";
import multer from "multer";
import { config } from "../config.js";
import {
  listRouters, getRouter, createRouter, deleteRouter,
  listPlans, upsertPlan, removePlan, activatePlan, getPlan,
  createVoucher, listVouchers, getVouchersByIds, deleteVoucher, setVoucherPlan,
  listSessions, queueCommand, activeVouchers, resyncVouchers,
  listOrders, salesSummary, financeSummary, cashSummary, stockByPlan,
  salesByDay, salesByPlan, salesByMethod, allSales, dumpAll,
  cheminPortailValide, upsertPortalFile, listPortalFiles,
  deletePortalFile, setPortalDir,
  listSponsors, createSponsor, setSponsorImage, toggleSponsor, deleteSponsor,
  dureeRouterOsValide, setTrial,
} from "../db.js";
import { generateRouterToken, generateVoucherCode, durationToSeconds } from "../codes.js";
import { layout, esc } from "./html.js";
import { requireAdmin, loginPage, handleLogin, handleLogout } from "./auth.js";

export const adminRouter = Router();

// Fichiers du portail gardes en memoire puis ecrits en base : rien ne touche
// le disque de l'hebergeur, qui est jetable. Plafond volontairement bas, ce
// sont des pages et des images de portail captif.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 20 },
});

// Express 4 ne rattrape pas le rejet d'un handler async : une erreur SQL
// isolée suffirait à tuer le process (et donc tout le service). On enveloppe
// chaque handler pour renvoyer l'erreur au middleware d'erreur d'Express.
["get", "post"].forEach(function (method) {
  const original = adminRouter[method].bind(adminRouter);
  adminRouter[method] = function (path, ...handlers) {
    return original(path, ...handlers.map((h) =>
      typeof h === "function" && h.length < 4
        ? function (req, res, next) { Promise.resolve(h(req, res, next)).catch(next); }
        : h));
  };
});

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

// RouterOS stocke le débit en "montant/descendant" (rx/tx du point de vue du
// client). Affiché tel quel, on le lit à l'envers : on explicite le sens.
function formatRate(raw) {
  if (!raw) return "illimité";
  const [up, down] = String(raw).split("/");
  if (!down) return raw;
  const clean = (v) => String(v).replace(/M$/i, "");
  return `\u2193 ${clean(down)} \u00b7 \u2191 ${clean(up)} Mb/s`;
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
      <td>${r.pending_commands > 0 ? `<span class="pill wait">${r.pending_commands} en file</span>` : "–"}</td>
    </tr>`).join("");

  res.type("html").send(layout("Routeurs", `
    <h1>Routeurs</h1>
    <p class="sub">Chaque routeur MikroTik vient tirer ses commandes ici (aucun port à ouvrir chez lui).</p>
    <div class="card">
      <table>
        <tr><th>Nom</th><th>Slug</th><th>État</th><th>Commandes</th></tr>
        ${rows || `<tr><td colspan="4" style="color:var(--ink-soft)">Aucun routeur. Ajoutez le premier ci-dessous.</td></tr>`}
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
    </div>`, { active: "routers", side: menuGeneral("g-routeurs") }));
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
# Mikrovoucher : agent pour "${router.name}" (genere par le dashboard)
# RouterOS v7. Importer sur le routeur : /import mikrovoucher-agent.rsc
# Prerequis : /system device-mode print -> hotspot=yes fetch=yes scheduler=yes
#
# Reimportable autant de fois qu'on veut : chaque element est retire avant
# d'etre recree. Sans cela, "add" sur un nom deja pris renvoie une erreur et
# l'import s'arrete la — le reste du fichier ne serait jamais applique.
# =====================================================================

# Le planificateur d'abord : il ne doit pas lancer le script pendant qu'on
# est en train de le remplacer.
/system scheduler
remove [find name=mikrovoucher-sched]
/system script
remove [find name=mikrovoucher-agent]
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
        :set rest [:pick $rest ($p4 + 1) [:len $rest]];
        :local p5 [:find $rest "|"];
        :local prof [:pick $rest 0 $p5];
        :set rest [:pick $rest ($p5 + 1) [:len $rest]];
        :local p6 [:find $rest "|"];
        :local shr [:pick $rest 0 $p6];
        :set rest [:pick $rest ($p6 + 1) [:len $rest]];
        :local p7 [:find $rest "|"];
        :local rate [:pick $rest 0 $p7];
        :local cmt [:pick $rest ($p7 + 1) [:len $rest]];
        :if ($action = "add") do={
          # Profil par forfait : porte le nombre d'appareils simultanes.
          # idle-timeout / keepalive-timeout sont "none" par defaut chez
          # RouterOS : une session dont l'appareil s'eteint ou s'eloigne ne
          # se fermerait JAMAIS. Deux consequences : le forfait continue de
          # consommer le temps paye alors que personne n'est connecte, et la
          # place reste occupee (re-login refuse tant que shared-users=1).
          # Avec cookie/mac-cookie, la reconnexion est automatique : la
          # deconnexion passe inapercue, seul le compteur s'arrete.
          :if ([:len $prof] > 0) do={
            :if ([:len [/ip hotspot user profile find name=$prof]] = 0) do={
              :do { /ip hotspot user profile add name=$prof shared-users=$shr \\
                rate-limit=$rate idle-timeout=5m keepalive-timeout=2m; } on-error={}
            } else={
              :do { /ip hotspot user profile set [find name=$prof] shared-users=$shr \\
                rate-limit=$rate idle-timeout=5m keepalive-timeout=2m; } on-error={}
            }
          }
          :if ([:len [/ip hotspot user find name=$code]] = 0) do={
            :do {
              :if ([:len $prof] > 0) do={
                /ip hotspot user add name=$code password=$code \\
                  limit-uptime=$up profile=$prof comment=$cmt;
              } else={
                /ip hotspot user add name=$code password=$code \\
                  limit-uptime=$up comment=$cmt;
              }
            } on-error={}
          }
        }
        :if ($action = "remove") do={
          # Couper la session en cours AVANT de supprimer le compte : retirer
          # l'utilisateur ne deconnecte pas quelqu'un deja connecte.
          :do { /ip hotspot active remove [find user=$code]; } on-error={}
          :do { /ip hotspot cookie remove [find user=$code]; } on-error={}
          :do { /ip hotspot user remove [find name=$code]; } on-error={}
        }
        # Reglage de l'essai gratuit depuis le dashboard. $code porte la
        # duree offerte, $up le delai de remise a zero, $prof le profil des
        # utilisateurs d'essai. Sans erreur si l'essai n'est pas encore
        # active dans login-by : c'est l'import du .rsc qui l'allume.
        :if ($action = "trial") do={
          :do {
            /ip hotspot profile set [find name!="default"] \\
              trial-uptime-limit=$code trial-uptime-reset=$up \\
              trial-user-profile=$prof;
          } on-error={}
        }
        # Effacement d'un fichier du portail. Meme verrou de chemin que
        # l'envoi : $cmt est prefixe du dossier du hotspot et valide cote
        # serveur, on ne peut donc pas effacer ailleurs.
        :if ($action = "rmfile") do={
          :do { /file remove [find name=$cmt]; } on-error={}
        }
        # Fichier du portail pousse depuis le dashboard : $code porte
        # l'identifiant du fichier, $cmt le chemin de destination (deja
        # prefixe du dossier du hotspot et valide cote serveur).
        :if ($action = "fetch") do={
          :do {
            /tool fetch url=("$backend/agent/file/$code") \\
              http-header-field=("x-router-token: $token") \\
              dst-path=$cmt;
          } on-error={}
        }
        :do {
          /tool fetch url=("$backend/agent/ack?id=$cmdid") \\
            http-header-field=("x-router-token: $token") \\
            http-method=get keep-result=no;
        } on-error={}
      }
    }
  }
  :do {
    :local rid [/system identity get name];
    :local rver [/system resource get version];
    :local rbrd [/system resource get board-name];
    :local rupt [/system resource get uptime];
    :local rcpu [/system resource get cpu-load];
    :local rfm [/system resource get free-memory];
    :local rtm [/system resource get total-memory];
    :local ract [:len [/ip hotspot active find]];
    :local rusr [:len [/ip hotspot user find]];
    /tool fetch url=("$backend/agent/report") http-method=post \\
      http-header-field=("x-router-token: $token") \\
      http-data=("$rid|$rver|$rbrd|$rupt|$rcpu|$rfm|$rtm|$ract|$rusr") \\
      keep-result=no;
  } on-error={}
  :do {
    :local lines "";
    :foreach s in=[/ip hotspot active find] do={
      :local u [/ip hotspot active get $s user];
      :local a [/ip hotspot active get $s address];
      :local m [/ip hotspot active get $s mac-address];
      :local t [/ip hotspot active get $s uptime];
      :local bi [/ip hotspot active get $s bytes-in];
      :local bo [/ip hotspot active get $s bytes-out];
      :local tl "";
      :do { :set tl [/ip hotspot active get $s session-time-left]; } on-error={ :set tl ""; }
      :set lines ("$lines$u,$a,$m,$t,$bi,$bo,$tl\\n");
    }
    /tool fetch url=("$backend/agent/sessions") http-method=post \\
      http-header-field=("x-router-token: $token") \\
      http-data=$lines keep-result=no;
  } on-error={}
  :do {
    # Codes deja utilises : sert a savoir ce qui a ete vendu (lots en especes).
    :local used "";
    :foreach u in=[/ip hotspot user find] do={
      :local up [/ip hotspot user get $u uptime];
      :if ($up != "00:00:00") do={
        :local n [/ip hotspot user get $u name];
        :local bi 0;
        :do { :set bi [/ip hotspot user get $u bytes-in]; } on-error={ :set bi 0; }
        :set used ("$used$n,$up,$bi\\n");
      }
    }
    :if ([:len $used] > 0) do={
      /tool fetch url=("$backend/agent/users") http-method=post \\
        http-header-field=("x-router-token: $token") \\
        http-data=$used keep-result=no;
    }
  } on-error={}
}
/system scheduler
add name=mikrovoucher-sched interval=15s on-event="/system script run mikrovoucher-agent" \\
  comment="Mikrovoucher : tire les commandes du manager"
# Walled-garden : les clients non connectes doivent atteindre le manager.
# Retire puis ajoute, sinon chaque reimport empile une regle de plus.
/ip hotspot walled-garden
remove [find comment="mikrovoucher manager"]
add dst-host=${host} comment="mikrovoucher manager"
# Rattrapage : les profils crees avant cette version n'ont pas de timeouts,
# leurs sessions mortes continueraient a consommer le temps paye.
:foreach p in=[/ip hotspot user profile find where name!="default"] do={
  :do { /ip hotspot user profile set $p idle-timeout=5m keepalive-timeout=2m; } on-error={}
}
`;
}

// Menu vertical d'un routeur : une page par fonction, plutot qu'une seule
// page ou tout s'empile.
function menuRouteur(router, actif) {
  const b = `/admin/routers/${router.id}`;
  return {
    titre: router.name,
    actif,
    items: [
      [b, "Vue d'ensemble", "vue"],
      [`${b}/plans`, "Forfaits", "plans"],
      [`${b}/vouchers`, "Vouchers", "vouchers"],
      [`${b}/sponsors`, "Sponsors", "sponsors"],
      [`${b}/files`, "Fichiers du portail", "files"],
      [`${b}/agent`, "Script agent", "agent"],
    ],
    // Les deux sections du dashboard, pour ne pas avoir a remonter en haut.
    bas: [
      ["/admin/routers", "Routeurs", "g-routeurs"],
      ["/admin/orders", "Ventes", "g-ventes"],
    ],
  };
}

// Menu des pages qui ne dependent pas d'un routeur (liste, finances).
function menuGeneral(actif) {
  return { titre: "Menu", actif, items: [
    ["/admin/routers", "Routeurs", "g-routeurs"],
    ["/admin/orders", "Ventes", "g-ventes"],
  ] };
}

// Bandeau de retour d'action (depot de fichiers, effacement...) : sans lui,
// une operation refusee ne laissait aucune trace a l'ecran.
function bandeauMsg(req) {
  const msg = String(req.query.msg || "").slice(0, 400);
  return msg ? `<div class="card" style="border-color:var(--accent)">${esc(msg)}</div>` : "";
}

adminRouter.get("/admin/routers/:id", requireAdmin, async (req, res) => {
  const router = await getRouter(Number(req.params.id));
  if (!router) return res.redirect("/admin/routers");
  // Forfaits et vouchers ont leur propre page : les charger ici ferait lire
  // des centaines de lignes pour rien a chaque ouverture de la fiche.
  const [sessions, attendus] = await Promise.all([
    listSessions(router.id), activeVouchers(router.id),
  ]);


  const fmtBytes = (n) => {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + " Go";
    if (n >= 1048576) return Math.round(n / 1048576) + " Mo";
    if (n >= 1024) return Math.round(n / 1024) + " Ko";
    return n + " o";
  };
  // Le routeur decompte le temps de connexion, le manager la validite
  // calendaire : afficher l'un des deux ferait dire au dashboard autre chose
  // qu'au portail. On retient la plus proche, celle qui coupera l'acces.
  const resteReel = (s) => {
    const routeur = s.time_left ? durationToSeconds(s.time_left) : null;
    const cal = s.validity_left == null ? null : Math.max(0, s.validity_left);
    if (routeur == null) return cal;
    if (cal == null) return routeur;
    return Math.min(routeur, cal);
  };
  // Meme forme que live.js, qui reprend la main a la premiere seconde :
  // sinon la valeur change d'apparence sous les yeux au premier rafraichissement.
  const formatReste = (sec) => {
    if (sec == null) return null;
    const j = Math.floor(sec / 86400); sec %= 86400;
    const h = Math.floor(sec / 3600); sec %= 3600;
    const m = Math.floor(sec / 60), r = sec % 60;
    const p = (n) => (n < 10 ? "0" : "") + n;
    return (j > 0 ? j + "j " : "") + p(h) + ":" + p(m) + ":" + p(r);
  };

  const sessionRows = sessions.map((s) => `
    <tr>
      <td class="mono"><strong>${esc(s.username)}</strong></td>
      <td>${s.plan_label
        ? `${esc(s.plan_label)}${s.shared_users > 1 ? ` <span class="pill wait">${s.shared_users} app.</span>` : ""}`
        : `<span style="color:var(--ink-soft)">hors manager</span>`}</td>
      <td class="mono">${resteReel(s) != null
        ? `<strong data-left="${resteReel(s)}">${esc(formatReste(resteReel(s)))}</strong>`
        : `<span style="color:var(--ink-soft)">illimité</span>`}</td>
      <td class="mono">${esc(s.address || "–")}</td>
      <td class="mono" style="font-size:12px">${esc(s.mac || "–")}</td>
      <td class="mono">${esc(s.uptime || "–")}</td>
      <td>${fmtBytes(s.bytes_in)} / ${fmtBytes(s.bytes_out)}</td>
      <td><form method="post" action="/admin/routers/${router.id}/kick"
                style="margin:0" data-confirm="Déconnecter et supprimer ${esc(s.username)} ?">
        <input type="hidden" name="code" value="${esc(s.username)}">
        <button class="danger">Déconnecter</button></form></td>
    </tr>`).join("");

  const info = router.info || null;
  const mb = (b) => (b > 0 ? `${Math.round(b / 1048576)} Mo` : "–");
  const infoCard = info ? `
    <div class="card">
      <h2 style="margin-top:0">Informations du routeur <span class="sub" style="font-size:12px">
        (rapportées par l'agent, ${info.reportedAt ? new Date(info.reportedAt).toLocaleString("fr-FR") : ""})</span></h2>
      <table>
        <tr><th>Identité</th><th>Modèle</th><th>RouterOS</th><th>Uptime</th>
            <th>CPU</th><th>RAM libre</th><th>Connectés</th><th>Comptes hotspot</th></tr>
        <tr>
          <td><strong id="iIdentity">${esc(info.identity || "–")}</strong></td>
          <td id="iBoard">${esc(info.board || "–")}</td>
          <td class="mono" id="iVersion">${esc(info.version || "–")}</td>
          <td class="mono" id="iUptime">${esc(info.uptime || "–")}</td>
          <td id="iCpu">${info.cpuLoad}%</td>
          <td id="iMem">${mb(info.freeMem)} / ${mb(info.totalMem)}</td>
          <td><span class="pill ok" id="iActive">${info.activeUsers} en ligne</span></td>
          <td id="iUsers">${info.totalUsers}</td>
        </tr>
      </table>
    </div>` : `
    <div class="card"><p class="sub" style="margin:0">Aucun rapport reçu du routeur pour
    l'instant. Importez le script agent ci-dessous, le premier rapport arrive en ≤ 15 s.</p></div>`;

  // Le routeur compte aussi ses propres comptes (admin, anciens vouchers), donc
  // seul un écart important compte : il signale un routeur remis à zéro ou
  // restauré, dont les codes vendus ont disparu.
  const surRouteur = info ? Number(info.totalUsers) || 0 : null;
  const ecart = surRouteur !== null && attendus.length > 0 &&
    surRouteur < attendus.length * 0.5;
  const alerte = !ecart ? "" : `
    <div class="card" style="border-color:var(--warn)">
      <h2 style="margin-top:0;color:var(--warn)">Les codes semblent absents du routeur</h2>
      <p class="sub" style="margin:0 0 12px">Le manager compte
        <strong>${attendus.length}</strong> voucher(s) actif(s), mais le routeur
        n'annonce que <strong>${surRouteur}</strong> compte(s). Cela arrive après
        une remise à zéro ou la restauration d'une ancienne sauvegarde.
        La resynchronisation recrée les codes manquants ; ceux déjà présents
        sont ignorés.</p>
      <form method="post" action="/admin/routers/${router.id}/resync" style="margin:0"
            data-confirm="Recréer les ${attendus.length} vouchers actifs sur le routeur ?">
        <button type="submit">Resynchroniser les vouchers</button>
      </form>
    </div>`;

  res.type("html").send(layout(router.name, `
    <h1>${esc(router.name)} <span id="statePill">${onlinePill(router.last_seen)}</span></h1>
    ${bandeauMsg(req)}
    <p class="sub">Slug : <span class="mono">${esc(router.slug)}</span>
      &middot; Portail : <span class="mono">${esc(router.portal_url || "non défini")}</span></p>
    ${infoCard}
    ${alerte}

    <div class="card">
      <h2 style="margin-top:0">Clients connectés
        <span class="pill ok" id="sessCount">${sessions.length}</span></h2>
      <table>
        <tr><th>Code</th><th>Forfait</th><th>Temps restant</th><th>IP</th><th>MAC</th>
            <th>Connecté depuis</th><th>Données ↓ / ↑</th><th></th></tr>
        <tbody id="sessBody">
        ${sessionRows || `<tr><td colspan="8" style="color:var(--ink-soft)">Personne connecté pour l'instant.</td></tr>`}
        </tbody>
      </table>
    </div>

    <script id="liveScript" src="/admin/live.js" data-router-id="${router.id}"></script>

    <form method="post" action="/admin/routers/${router.id}/delete"
          data-confirm="Supprimer ce routeur et tout son historique ?">
      <button class="danger">Supprimer ce routeur</button>
    </form>`, { active: "routers", side: menuRouteur(router, "vue") }));
});

// Page dediee : commerces qui paient une place sur le portail.
adminRouter.get("/admin/routers/:id/sponsors", requireAdmin, async (req, res) => {
  const router = await getRouter(Number(req.params.id));
  if (!router) return res.redirect("/admin/routers");
  const sponsors = await listSponsors(router.id);

  const place = { login: "Page de connexion", trial: "Essai gratuit", both: "Les deux" };
  const jour = (d) => (d ? new Date(d).toLocaleDateString("fr-FR") : "–");
  // Un contrat echu n'affiche plus rien : on le dit ici, sinon on croit que
  // le sponsor est encore en ligne parce que sa ligne est "active".
  const echu = (s) => s.ends_on && new Date(s.ends_on) < new Date(new Date().toDateString());

  const rows = sponsors.map((s) => `
    <tr>
      <td>
        <strong>${esc(s.name)}</strong>
        ${s.baseline ? `<div style="font-size:12px;color:var(--ink-soft)">${esc(s.baseline)}</div>` : ""}
        ${s.image_path ? `<div style="font-size:11px;color:var(--ink-soft)" class="mono">${esc(s.image_path)}</div>` : ""}
      </td>
      <td>${esc(place[s.placement] || s.placement)}</td>
      <td style="font-size:12px">${jour(s.starts_on)} &rarr; ${jour(s.ends_on)}</td>
      <td class="num">${s.views}</td>
      <td class="num">${s.clicks}</td>
      <td>${!s.active ? `<span class="pill off">arrêté</span>`
            : echu(s) ? `<span class="pill wait">contrat fini</span>`
            : `<span class="pill ok">en ligne</span>`}</td>
      <td style="text-align:right;white-space:nowrap">
        <form method="post" style="display:inline"
              action="/admin/routers/${router.id}/sponsors/${s.id}/toggle">
          <input type="hidden" name="actif" value="${s.active ? "0" : "1"}">
          <button class="btn ghost" type="submit">${s.active ? "Arrêter" : "Remettre"}</button>
        </form>
        <form method="post" style="display:inline"
              action="/admin/routers/${router.id}/sponsors/${s.id}/delete"
              data-confirm="Supprimer ${esc(s.name)} ? Son image sera retirée du routeur.">
          <button class="danger" type="submit">Supprimer</button>
        </form>
      </td>
    </tr>`).join("");

  res.type("html").send(layout(`Sponsors : ${router.name}`, `
    <h1>Sponsors</h1>
    <p class="sub">${esc(router.name)}</p>
    ${bandeauMsg(req)}

    <div class="card">
      <table>
        <tr><th>Commerce</th><th>Emplacement</th><th>Contrat</th>
            <th class="num">Vues</th><th class="num">Clics</th><th>État</th><th></th></tr>
        ${rows || `<tr><td colspan="7" style="color:var(--ink-soft)">Aucun sponsor.</td></tr>`}
      </table>
      <p class="sub" style="margin:12px 0 0">« Vues » compte les affichages du
      portail, « Clics » les fois où quelqu'un a touché le contact. Ce sont ces
      deux chiffres qui font renouveler un contrat.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Ajouter un sponsor</h2>
      <form method="post" action="/admin/routers/${router.id}/sponsors"
            enctype="multipart/form-data" class="inline">
        <label>Commerce <input name="name" required placeholder="Boutique Marie"></label>
        <label>Accroche <input name="baseline" size="28" placeholder="Produits frais, en face de l'église"></label>
        <label>Contact <input name="contact" size="14" placeholder="509XXXXXXXX"></label>
        <label>Emplacement
          <select name="placement">
            <option value="login">Page de connexion</option>
            <option value="trial">Essai gratuit</option>
            <option value="both">Les deux</option>
          </select></label>
        <label>Du <input type="date" name="starts_on"></label>
        <label>Au <input type="date" name="ends_on"></label>
        <label>Logo <input type="file" name="image" accept="image/png,image/jpeg,image/webp"></label>
        <button type="submit">Ajouter</button>
      </form>
      <p class="sub" style="margin:12px 0 0">Le logo est déposé dans les fichiers
      du portail et envoyé au routeur automatiquement : il s'affiche donc même
      avant que le client soit connecté. PNG, JPEG ou WebP, 2 Mo maximum.
      « Essai gratuit » écrit « offertes par ... » sous le bouton d'essai —
      c'est la place qui se vend le mieux : le client reçoit un cadeau.</p>
    </div>`, { active: "routers", side: menuRouteur(router, "sponsors") }));
});

// Page dediee : fichiers du portail captif.
adminRouter.get("/admin/routers/:id/files", requireAdmin, async (req, res) => {
  const router = await getRouter(Number(req.params.id));
  if (!router) return res.redirect("/admin/routers");
  const fichiers = await listPortalFiles(router.id);

  res.type("html").send(layout(`Fichiers : ${router.name}`, `
    <h1>Fichiers du portail</h1>
    <p class="sub">${esc(router.name)}</p>
    ${bandeauMsg(req)}
    <div class="card">
      <h2 style="margin-top:0">Fichiers du portail</h2>
      <p class="sub" style="margin:0 0 12px">Déposez ici les pages du portail
      captif ; le routeur vient les chercher tout seul au prochain cycle. Le
      chemin est celui du sous-dossier, tel quel :
      <span class="mono">login.html</span>, <span class="mono">css/theme.css</span>,
      <span class="mono">img/logo.png</span>. Ils ne peuvent être écrits que
      dans le dossier du portail.</p>

      <form method="post" action="/admin/routers/${router.id}/files"
            enctype="multipart/form-data" class="inline" style="margin-bottom:14px">
        <label>Fichiers <input type="file" name="fichiers" multiple required></label>
        <label>Sous-dossier
          <input name="prefixe" placeholder="(racine), ex : css" size="10"></label>
        <button type="submit">Déposer</button>
      </form>

      <table>
        <tr><th>Chemin</th><th>Taille</th><th>État</th><th></th></tr>
        ${fichiers.map((f) => `
          <tr>
            <td class="mono">${esc(f.path)}</td>
            <td>${Math.max(1, Math.round(f.bytes / 1024))} Ko</td>
            <td>${f.pushed_at
                  ? `<span class="pill ok">Sur le routeur</span>`
                  : `<span class="pill wait">À pousser</span>`}</td>
            <td style="text-align:right;white-space:nowrap">
              <form method="post" style="display:inline"
                    action="/admin/routers/${router.id}/files/${f.id}/delete"
                    data-confirm="Retirer ${esc(f.path)} de cette liste ? Le fichier reste sur le routeur.">
                <button class="btn ghost" type="submit">Retirer d'ici</button>
              </form>
              ${f.pushed_at ? `
              <form method="post" style="display:inline"
                    action="/admin/routers/${router.id}/files/${f.id}/unlink"
                    data-confirm="Effacer ${esc(f.path)} SUR LE ROUTEUR ? Le portail cassera si la page est encore utilisée.">
                <button class="btn ghost" type="submit">Effacer du routeur</button>
              </form>` : ""}
            </td>
          </tr>`).join("") || `<tr><td colspan="4" style="color:var(--ink-soft)">
          Aucun fichier déposé.</td></tr>`}
      </table>

      ${fichiers.length > 0 ? `
      <form method="post" action="/admin/routers/${router.id}/files/push"
            style="margin-top:12px"
            data-confirm="Envoyer les ${fichiers.length} fichier(s) sur le routeur ?">
        <button type="submit">Pousser sur le routeur</button>
      </form>` : ""}

      <p class="sub" style="margin:14px 0 0">Dossier du portail sur ce routeur.
      Il dépend du modèle : vérifiez avec <span class="mono">/file print</span>
      si les fichiers n'arrivent pas.</p>
      <form class="inline" method="post" action="/admin/routers/${router.id}/portal-dir">
        <label>Dossier <input name="dir" value="${esc(router.portal_dir || "hotspot")}"
               pattern="[A-Za-z0-9._/-]+" size="16" required></label>
        <button type="submit">Enregistrer</button>
      </form>
    </div>
`, { active: "routers", side: menuRouteur(router, "files") }));
});


// Page dediee : script a importer sur le routeur.
adminRouter.get("/admin/routers/:id/agent", requireAdmin, async (req, res) => {
  const router = await getRouter(Number(req.params.id));
  if (!router) return res.redirect("/admin/routers");
  const base = publicBase(req);

  res.type("html").send(layout(`Script agent : ${router.name}`, `
    <h1>Script agent</h1>
    <p class="sub">${esc(router.name)}</p>
    <div class="card">
        <h2 style="margin-top:0">Script agent</h2>
        <p class="sub" style="margin:0 0 10px">Deux façons : <strong>Copier</strong> puis coller
        dans WinBox → New Terminal ; ou <strong>Télécharger</strong> le fichier
        <span class="mono">mikrovoucher-agent.rsc</span>, le glisser dans Files, puis lancer
        <span class="mono">/import mikrovoucher-agent.rsc</span>.
        Réimportable à volonté : le script se remplace lui-même, rien à
        supprimer d'abord.</p>
        <div style="display:flex;gap:10px;margin-bottom:10px">
          <button type="button" id="copyBtn" onclick="copyAgent()">Copier le script</button>
          <a class="btn ghost" href="/admin/routers/${router.id}/agent.rsc">Télécharger .rsc</a>
        </div>
        <textarea id="agentScript" readonly onclick="this.select()">${esc(agentRsc(router, base))}</textarea>
        <script>
          function copyAgent() {
            var ta = document.getElementById('agentScript');
            var btn = document.getElementById('copyBtn');
            ta.select();
            var done = function () { btn.textContent = 'Copié !';
              setTimeout(function () { btn.textContent = 'Copier le script'; }, 2000); };
            if (navigator.clipboard) {
              navigator.clipboard.writeText(ta.value).then(done, function () { document.execCommand('copy'); done(); });
            } else { document.execCommand('copy'); done(); }
          }
        </script>
      </div>
    </div>
`, { active: "routers", side: menuRouteur(router, "agent") }));
});

// Script client de la fiche routeur, servi comme fichier statique.
adminRouter.get("/admin/live.js", requireAdmin, (req, res) => {
  res.type("application/javascript").sendFile(
    new URL("./live.js", import.meta.url).pathname);
});

// Données rafraîchies sans recharger la page (fiche routeur).
adminRouter.get("/admin/api/routers/:id/live", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [router, sessions] = await Promise.all([getRouter(id), listSessions(id)]);
    if (!router) return res.status(404).json({ error: "introuvable" });
    res.json({
      lastSeen: router.last_seen,
      info: router.info || null,
      sessions: sessions.map((s) => ({
        username: s.username, address: s.address, mac: s.mac, uptime: s.uptime,
        bytesIn: Number(s.bytes_in), bytesOut: Number(s.bytes_out),
        timeLeft: s.time_left, validityLeft: s.validity_left,
        planLabel: s.plan_label, devices: s.shared_users,
      })),
    });
  } catch (err) {
    console.error("[live]", err.message);
    res.status(502).json({ error: "indisponible" });
  }
});

// Page dédiée aux forfaits d'un routeur.
adminRouter.get("/admin/routers/:id/plans", requireAdmin, async (req, res) => {
  const router = await getRouter(Number(req.params.id));
  if (!router) return res.redirect("/admin/routers");
  const plans = await listPlans(router.id);
  const active = plans.filter((p) => p.active);
  const retired = plans.filter((p) => !p.active);
  const rows = active.map((p) => `
    <tr>
      <td class="mono">${esc(p.code)}</td>
      <td>${esc(p.label)}</td>
      <td>${p.price_htg} HTG</td>
      <td class="mono">${esc(p.uptime)}</td>
      <td>${p.shared_users}</td>
      <td class="mono">${esc(formatRate(p.rate_limit))}</td>
      <td><form method="post" action="/admin/routers/${router.id}/plans/delete" style="margin:0"
                data-confirm="Retirer le forfait ${esc(p.label)} ?">
        <input type="hidden" name="code" value="${esc(p.code)}">
        <button class="danger">Retirer</button></form></td>
    </tr>`).join("");
  const retiredRows = retired.map((p) => `
    <tr>
      <td class="mono">${esc(p.code)}</td>
      <td>${esc(p.label)}</td>
      <td>${p.price_htg} HTG</td>
      <td class="mono">${esc(p.uptime)}</td>
      <td>${p.shared_users}</td>
      <td><form method="post" action="/admin/routers/${router.id}/plans/restore" style="margin:0">
        <input type="hidden" name="code" value="${esc(p.code)}">
        <button class="ghost">Réactiver</button></form></td>
    </tr>`).join("");
  const retiredCard = retired.length === 0 ? "" : `
    <div class="card">
      <h2 style="margin-top:0">Forfaits retirés</h2>
      <p class="sub" style="margin:0 0 10px">Conservés car des vouchers ou des ventes les
      utilisent. Ils n'apparaissent plus sur le portail.</p>
      <table>
        <tr><th>Code</th><th>Nom</th><th>Prix</th><th>Durée</th><th>Appareils</th><th></th></tr>
        ${retiredRows}
      </table>
    </div>`;

  res.type("html").send(layout(`Forfaits : ${router.name}`, `
    <h1>Forfaits</h1>
    <p class="sub">${esc(router.name)}</p>
    ${bandeauMsg(req)}
    <div class="card" style="display:flex;gap:10px;flex-wrap:wrap">
      <a class="btn ghost" href="/admin/routers/${router.id}">Fiche routeur</a>
      <a class="btn ghost" href="/admin/routers/${router.id}/vouchers">Vouchers</a>
    </div>

    <div class="card">
      <table>
        <tr><th>Code</th><th>Nom</th><th>Prix</th><th>Durée</th><th>Appareils</th><th>Débit</th><th></th></tr>
        ${rows || `<tr><td colspan="7" style="color:var(--ink-soft)">Aucun forfait actif.</td></tr>`}
      </table>
    </div>
    ${retiredCard}

    <div class="card">
      <h2 style="margin-top:0">Ajouter ou modifier un forfait</h2>
      <form class="inline" method="post" action="/admin/routers/${router.id}/plans">
        <label>Code <input name="code" placeholder="3j" size="5" required></label>
        <label>Nom <input name="label" placeholder="3 jours" size="12" required></label>
        <label>Prix HTG <input name="price_htg" type="number" min="20" size="6" required></label>
        <label>Durée RouterOS <input name="uptime" placeholder="3d" size="6" required></label>
        <label>Appareils <input name="shared_users" type="number" min="1" max="50" value="1" size="4" required></label>
        <label>Débit ↓ Mb/s <input name="down_mbps" type="number" min="0" step="0.5" placeholder="0 = illimité" size="5"></label>
        <label>Débit ↑ Mb/s <input name="up_mbps" type="number" min="0" step="0.5" placeholder="0 = illimité" size="5"></label>
        <button type="submit">Enregistrer</button>
      </form>
      <p class="sub" style="margin:12px 0 0">Un code existant est mis à jour.
      « Appareils » = nombre d'appareils pouvant utiliser le même voucher en même temps.
      Le débit limite chaque client de ce forfait ; laissez vide ou 0 pour ne pas limiter.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Essai gratuit</h2>
      <p class="sub" style="margin:0 0 12px">Ce que reçoit un appareil qui n'a
      jamais payé. C'est de la publicité, pas un contrôle d'accès : un
      téléphone qui change d'adresse Wi-Fi privée repart à zéro. Court, il
      montre que le réseau marche sans valoir la peine d'être contourné.</p>
      <form class="inline" method="post" action="/admin/routers/${router.id}/trial">
        <label>Durée offerte
          <input name="limite" value="${esc(router.trial_limit || "5m")}"
                 pattern="[1-9][0-9]{0,3}[smhdw]" size="6" required></label>
        <label>À nouveau après
          <input name="reset" value="${esc(router.trial_reset || "1d")}"
                 pattern="[1-9][0-9]{0,3}[smhdw]" size="6" required></label>
        <button type="submit">Appliquer au routeur</button>
      </form>
      <p class="sub" style="margin:12px 0 0">Format RouterOS :
      <span class="mono">30m</span>, <span class="mono">2h</span>,
      <span class="mono">1d</span>. « À nouveau après » compte depuis le début
      de l'essai. La page de connexion annonce la durée toute seule.</p>
    </div>`, { active: "routers", side: menuRouteur(router, "plans") }));
});

// Page dédiée aux vouchers d'un routeur (la fiche routeur reste légère).
adminRouter.get("/admin/routers/:id/vouchers", requireAdmin, async (req, res) => {
  const router = await getRouter(Number(req.params.id));
  if (!router) return res.redirect("/admin/routers");
  const [vouchers, sessions, plans] = await Promise.all([
    listVouchers(router.id, 500), listSessions(router.id), listPlans(router.id),
  ]);
  const online = new Set(sessions.map((s) => s.username));
  const activePlans = plans.filter((p) => p.active);
  const filter = String(req.query.q || "").toUpperCase();
  const shown = filter ? vouchers.filter((v) => v.code.includes(filter)) : vouchers;

  // Temps restant avant échéance, compté depuis la première utilisation.
  const restant = (v) => {
    if (!v.used_at || !v.validity_seconds) return "–";
    if (v.expired_at) return "terminé";
    const fin = new Date(v.used_at).getTime() + v.validity_seconds * 1000;
    const s = Math.round((fin - Date.now()) / 1000);
    if (s <= 0) return "échu";
    const j = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    return j > 0 ? `${j} j ${h} h` : `${h} h`;
  };

  const rows = shown.map((v) => `
    <tr>
      <td><input type="checkbox" class="pick" name="ids" value="${v.id}" form="lot"
                 aria-label="Sélectionner ${esc(v.code)}"></td>
      <td class="mono"><strong>${esc(v.code)}</strong></td>
      <td>
        <form method="post" action="/admin/routers/${router.id}/vouchers/${v.id}/plan"
              style="margin:0;display:flex;gap:6px">
          <select name="plan_code" onchange="this.form.submit()">
            ${activePlans.map((p) => `<option value="${esc(p.code)}"${p.id === v.plan_id ? " selected" : ""}>${esc(p.label)}</option>`).join("")}
          </select>
        </form>
      </td>
      <td>${v.source === "order" ? "vente en ligne" : "lot"}</td>
      <td>${v.expired_at ? `<span class="pill off">expiré</span>`
        : online.has(v.code) ? `<span class="pill ok">connecté</span>`
        : v.used_at ? `<span class="pill" style="background:color-mix(in srgb,var(--ink-soft) 14%,transparent);color:var(--ink-soft)">utilisé</span>`
        : v.status === "ON_ROUTER" ? `<span class="pill wait">à vendre</span>`
        : `<span class="pill wait">en file</span>`}</td>
      <td style="color:var(--ink-soft);font-size:12px">${restant(v)}</td>
      <td style="color:var(--ink-soft);font-size:12px">${new Date(v.created_at).toLocaleString("fr-FR")}</td>
      <td style="display:flex;gap:6px">
        <a class="btn ghost" href="/admin/print?ids=${v.id}">Imprimer</a>
        <form method="post" action="/admin/routers/${router.id}/vouchers/${v.id}/delete"
              style="margin:0" data-confirm="Supprimer le code ${esc(v.code)} ? Le client sera déconnecté.">
          <button class="danger">Supprimer</button></form>
      </td>
    </tr>`).join("");

  res.type("html").send(layout(`Vouchers : ${router.name}`, `
    <h1>Vouchers</h1>
    <p class="sub">${esc(router.name)}</p>
    ${bandeauMsg(req)}
    

    <div class="card" style="display:flex;gap:10px;flex-wrap:wrap">
      <a class="btn ghost" href="/admin/routers/${router.id}">Fiche routeur</a>
      <a class="btn ghost" href="/admin/routers/${router.id}/plans">Forfaits</a>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Générer un lot</h2>
      <form class="inline" method="post" action="/admin/routers/${router.id}/vouchers">
        <label>Forfait
          <select name="plan_code" required>
            ${activePlans.map((p) => `<option value="${esc(p.code)}">${esc(p.label)} · ${p.price_htg} HTG · ${p.shared_users} app.</option>`).join("")}
          </select></label>
        <label>Quantité <input name="count" type="number" min="1" max="200" value="10" required></label>
        <button type="submit" ${activePlans.length === 0 ? "disabled" : ""}>Générer + imprimer</button>
      </form>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <h2 style="margin:0">${shown.length} voucher(s)
          <span class="pill wait">${shown.filter((v) => !v.used_at).length} à vendre</span></h2>
        <form class="inline" method="get" style="margin:0">
          <input name="q" placeholder="Chercher un code" value="${esc(req.query.q || "")}">
          <button class="ghost" type="submit">Filtrer</button>
        </form>
      </div>
      <!-- Le formulaire vit hors du tableau ; les cases s'y rattachent par
           leur attribut form=. Deux boutons, deux destinations. -->
      <form id="lot" method="post"
            action="/admin/routers/${router.id}/vouchers/delete"
            data-confirm="Supprimer les codes sélectionnés ? Les clients connectés seront déconnectés."
            style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px">
        <span id="pickCount" style="font-size:13px;color:var(--ink-soft)">0 sélectionné</span>
        <button class="ghost" type="submit" formmethod="get" formaction="/admin/print"
                data-noconfirm formnovalidate>Imprimer la sélection</button>
        <button class="danger" type="submit">Supprimer la sélection</button>
      </form>

      <table style="margin-top:12px">
        <tr><th style="width:26px"><input type="checkbox" id="pickAll" aria-label="Tout sélectionner"></th>
            <th>Code</th><th>Forfait</th><th>Origine</th><th>État</th><th>Expire dans</th>
            <th>Créé</th><th></th></tr>
        ${rows || `<tr><td colspan="8" style="color:var(--ink-soft)">Aucun voucher.</td></tr>`}
      </table>
    </div>

    <script>
      (function () {
        var tout = document.getElementById("pickAll");
        var cases = [].slice.call(document.querySelectorAll(".pick"));
        var compteur = document.getElementById("pickCount");
        if (!cases.length) return;
        function majuscule() {
          var n = cases.filter(function (c) { return c.checked; }).length;
          compteur.textContent = n + " sélectionné" + (n > 1 ? "s" : "");
          if (tout) tout.checked = n === cases.length;
        }
        if (tout) tout.addEventListener("change", function () {
          cases.forEach(function (c) { c.checked = tout.checked; });
          majuscule();
        });
        cases.forEach(function (c) { c.addEventListener("change", majuscule); });
        majuscule();
      })();
    </script>`, { active: "routers", side: menuRouteur(router, "vouchers") }));
});

// Change le forfait d'un voucher : le compte est recréé sur le routeur avec
// la nouvelle durée / le nouveau nombre d'appareils.
adminRouter.post("/admin/routers/:id/vouchers/:vid/plan", requireAdmin, async (req, res) => {
  const routerId = Number(req.params.id);
  const vid = Number(req.params.vid);
  const plan = await getPlan(routerId, String((req.body || {}).plan_code || ""));
  if (plan) {
    const v = await setVoucherPlan(routerId, vid, plan.id);
    if (v) {
      await queueCommand(routerId, "remove", { code: v.code });
      await queueCommand(routerId, "add", {
        code: v.code, uptime: plan.uptime, profile: `mv-${plan.code}`,
        shared: plan.shared_users, comment: `plan ${plan.code}`,
      });
    }
  }
  res.redirect(`/admin/routers/${routerId}/vouchers`);
});

// Supprime un voucher : retiré de la liste ici, et une commande 'remove' est
// mise en file pour que le routeur supprime le compte hotspot (donc déconnecte
// le client s'il est en ligne).
adminRouter.post("/admin/routers/:id/vouchers/:vid/delete", requireAdmin, async (req, res) => {
  const routerId = Number(req.params.id);
  const removed = await deleteVoucher(routerId, Number(req.params.vid));
  if (removed) await queueCommand(routerId, "remove", { code: removed.code });
  res.redirect(`/admin/routers/${routerId}/vouchers`);
});

// Suppression en lot depuis la selection.
adminRouter.post("/admin/routers/:id/vouchers/delete", requireAdmin, async (req, res) => {
  const routerId = Number(req.params.id);
  const brut = (req.body || {}).ids;
  const ids = (Array.isArray(brut) ? brut : [brut])
    .map(Number).filter(Number.isInteger);
  const retour = (m) =>
    res.redirect(`/admin/routers/${routerId}/vouchers?msg=` + encodeURIComponent(m));
  if (ids.length === 0) return retour("Aucun code sélectionné.");

  let n = 0;
  for (const id of ids) {
    const removed = await deleteVoucher(routerId, id);
    if (removed) { await queueCommand(routerId, "remove", { code: removed.code }); n += 1; }
  }
  return retour(`${n} code(s) supprimé(s). Les clients connectés seront déconnectés.`);
});

// Recrée tous les vouchers actifs sur le routeur (réparation après reset).
adminRouter.post("/admin/routers/:id/resync", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const n = await resyncVouchers(id);
  console.log(`[resync] ${n} voucher(s) remis en file pour le routeur ${id}`);
  res.redirect(`/admin/routers/${id}`);
});

// Déconnecte un client : on supprime son compte hotspot sur le routeur.
adminRouter.post("/admin/routers/:id/kick", requireAdmin, async (req, res) => {
  const routerId = Number(req.params.id);
  const code = String((req.body || {}).code || "");
  if (code) await queueCommand(routerId, "remove", { code });
  res.redirect(`/admin/routers/${routerId}`);
});

// Téléchargement du script agent, prêt à glisser dans Files puis /import.
// Envoie (ou renvoie) un fichier du portail au routeur.
async function pousserFichier(routerId, portalDir, fichier) {
  const dossier = cheminPortailValide(portalDir || "hotspot");
  if (!dossier) return;
  await queueCommand(routerId, "fetch", {
    code: String(fichier.id), fileId: fichier.id,
    comment: `${dossier}/${fichier.path}`,
  });
}

adminRouter.post("/admin/routers/:id/trial", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const router = await getRouter(id);
  if (!router) return res.redirect("/admin/routers");
  const retour = (m) => res.redirect(`/admin/routers/${id}/plans?msg=` + encodeURIComponent(m));

  const limite = dureeRouterOsValide(req.body.limite);
  const reset = dureeRouterOsValide(req.body.reset);
  if (!limite || !reset) return retour("Durée invalide. Exemples : 30m, 2h, 1d.");

  await setTrial(id, limite, reset);
  // $code = duree offerte, $up = remise a zero, $profile = profil d'essai.
  await queueCommand(id, "trial", { code: limite, uptime: reset, profile: "essai" });
  return retour(`Essai réglé sur ${limite} par ${reset}. Envoyé au routeur.`);
});

// ------------------------------------------------------------ sponsors ----
adminRouter.post("/admin/routers/:id/sponsors", requireAdmin,
  upload.single("image"), async (req, res) => {
    const id = Number(req.params.id);
    const router = await getRouter(id);
    if (!router) return res.redirect("/admin/routers");
    const retour = (m) => res.redirect(`/admin/routers/${id}/sponsors?msg=` + encodeURIComponent(m));

    const nom = String(req.body.name || "").trim();
    if (!nom) return retour("Le nom du commerce est obligatoire.");
    const placement = ["login", "trial", "both"].includes(req.body.placement)
      ? req.body.placement : "login";

    const sponsor = await createSponsor(id, {
      name: nom.slice(0, 80),
      baseline: String(req.body.baseline || "").trim().slice(0, 120),
      contact: String(req.body.contact || "").trim().slice(0, 60),
      placement,
      startsOn: req.body.starts_on || null,
      endsOn: req.body.ends_on || null,
    });

    if (req.file) {
      // Extension imposee : un SVG s'execute dans la page du portail, et le
      // reste ne s'afficherait pas.
      const types = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
      const ext = types[req.file.mimetype];
      if (!ext) return retour(`${nom} ajouté, mais le logo a été refusé (PNG, JPEG ou WebP seulement).`);
      const chemin = `img/sponsors/${sponsor.id}.${ext}`;
      const f = await upsertPortalFile(id, chemin, req.file.buffer);
      await setSponsorImage(id, sponsor.id, chemin);
      await pousserFichier(id, router.portal_dir, f);
      return retour(`${nom} ajouté. Logo envoyé au routeur.`);
    }
    return retour(`${nom} ajouté.`);
  });

adminRouter.post("/admin/routers/:id/sponsors/:sid/toggle", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await toggleSponsor(id, Number(req.params.sid), req.body.actif === "1");
  res.redirect(`/admin/routers/${id}/sponsors`);
});

adminRouter.post("/admin/routers/:id/sponsors/:sid/delete", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const router = await getRouter(id);
  if (!router) return res.redirect("/admin/routers");
  const supprime = await deleteSponsor(id, Number(req.params.sid));
  // Le logo doit partir du routeur aussi : sinon il resterait un fichier
  // orphelin sur le flash, invisible depuis le dashboard.
  if (supprime && supprime.image_path) {
    const fichiers = await listPortalFiles(id);
    const f = fichiers.find((x) => x.path === supprime.image_path);
    const dossier = cheminPortailValide(router.portal_dir || "hotspot");
    if (f && dossier) {
      await queueCommand(id, "rmfile", { comment: `${dossier}/${f.path}` });
      await deletePortalFile(id, f.id);
    }
  }
  res.redirect(`/admin/routers/${id}/sponsors?msg=` + encodeURIComponent("Sponsor supprimé."));
});

// --------------------------------------------- fichiers du portail ----
adminRouter.post("/admin/routers/:id/files", requireAdmin,
  upload.array("fichiers", 20), async (req, res) => {
    const id = Number(req.params.id);
    const router = await getRouter(id);
    if (!router) return res.redirect("/admin/routers");

    const retour = (msg) =>
      res.redirect(`/admin/routers/${id}?msg=` + encodeURIComponent(msg));

    // Le sous-dossier vient d'un champ libre : il passe par la meme validation
    // que le nom de fichier, sinon "../../" y suffirait pour sortir du portail.
    const brut = String(req.body.prefixe || "").trim().replace(/^\/+|\/+$/g, "");
    let dossier = "";
    if (brut) {
      const ok = cheminPortailValide(brut);
      if (!ok) return retour(`Sous-dossier refusé : « ${brut} »`);
      dossier = ok + "/";
    }

    const recus = req.files || [];
    if (recus.length === 0) {
      return retour("Aucun fichier reçu. Choisissez au moins un fichier.");
    }

    const pris = [], refuses = [];
    for (const f of recus) {
      // Certains navigateurs envoient un chemin complet : on ne garde que le
      // nom, sinon un "/Users/…/login.html" serait refuse sans raison lisible.
      const nom = String(f.originalname || "").split(/[\\/]/).pop();
      const chemin = cheminPortailValide(dossier + nom);
      if (!chemin) { refuses.push(nom); continue; }
      await upsertPortalFile(id, chemin, f.buffer);
      pris.push(chemin);
    }

    if (pris.length === 0) {
      return retour(`Aucun fichier accepté (nom refusé) : ${refuses.join(", ")}`);
    }
    return retour(
      `${pris.length} fichier(s) déposé(s) : ${pris.join(", ")}` +
      (refuses.length ? ` — refusé(s) : ${refuses.join(", ")}` : ""));
  });

adminRouter.post("/admin/routers/:id/files/:fid/delete", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await deletePortalFile(id, Number(req.params.fid));
  res.redirect(`/admin/routers/${id}`);
});

// Efface le fichier SUR le routeur, puis le retire de la liste : il n'y est
// plus, le garder afficherait un etat faux.
adminRouter.post("/admin/routers/:id/files/:fid/unlink", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const router = await getRouter(id);
  if (!router) return res.redirect("/admin/routers");
  const fichiers = await listPortalFiles(id);
  const f = fichiers.find((x) => x.id === Number(req.params.fid));
  const dossier = cheminPortailValide(router.portal_dir || "hotspot");
  if (!f || !dossier) return res.redirect(`/admin/routers/${id}`);
  await queueCommand(id, "rmfile", { comment: `${dossier}/${f.path}` });
  await deletePortalFile(id, f.id);
  res.redirect(`/admin/routers/${id}?msg=` +
    encodeURIComponent(`Effacement de ${f.path} demandé au routeur.`));
});

adminRouter.post("/admin/routers/:id/files/push", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const router = await getRouter(id);
  if (!router) return res.redirect("/admin/routers");
  const dossier = cheminPortailValide(router.portal_dir || "hotspot");
  if (!dossier) return res.redirect(`/admin/routers/${id}`);
  for (const f of await listPortalFiles(id)) {
    // $code porte l'identifiant du fichier, $cmt le chemin de destination.
    await queueCommand(id, "fetch", {
      code: String(f.id), fileId: f.id,
      comment: `${dossier}/${f.path}`,
    });
  }
  res.redirect(`/admin/routers/${id}`);
});

adminRouter.post("/admin/routers/:id/portal-dir", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const dir = cheminPortailValide(String(req.body.dir || ""));
  if (dir) await setPortalDir(id, dir);
  res.redirect(`/admin/routers/${id}`);
});

adminRouter.get("/admin/routers/:id/agent.rsc", requireAdmin, async (req, res) => {
  const router = await getRouter(Number(req.params.id));
  if (!router) return res.redirect("/admin/routers");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="mikrovoucher-agent.rsc"');
  res.send(agentRsc(router, publicBase(req)));
});

adminRouter.post("/admin/routers/:id/plans", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { code, label, price_htg, uptime } = req.body || {};
  // Le code sert d'identifiant d'API et de nom de profil RouterOS : on le
  // normalise (pas d'espaces ni de caractères exotiques), sinon le forfait
  // serait rejeté par le portail et le profil impossible à créer.
  const cleanCode = String(code || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (cleanCode && label && price_htg && uptime) {
    await upsertPlan({
      routerId: id, code: cleanCode, label: String(label),
      priceHtg: Number(price_htg), uptime: String(uptime),
      sharedUsers: Number((req.body || {}).shared_users) || 1,
      // RouterOS attend "montant/descendant" (ex : 1M/5M). Vide = illimité.
      // La durée saisie sert aussi de validité calendaire : un forfait
      // "3 jours" expire 3 jours après la première connexion du client.
      validitySeconds: durationToSeconds(String(uptime)),
      rateLimit: (function () {
        const up = Number((req.body || {}).up_mbps) || 0;
        const down = Number((req.body || {}).down_mbps) || 0;
        if (up <= 0 && down <= 0) return "";
        return `${up > 0 ? up : down}M/${down > 0 ? down : up}M`;
      })(),
    });
  }
  res.redirect(`/admin/routers/${id}/plans`);
});

adminRouter.post("/admin/routers/:id/plans/delete", requireAdmin, async (req, res) => {
  await removePlan(Number(req.params.id), String((req.body || {}).code || ""));
  res.redirect(`/admin/routers/${req.params.id}/plans`);
});

adminRouter.post("/admin/routers/:id/plans/restore", requireAdmin, async (req, res) => {
  await activatePlan(Number(req.params.id), String((req.body || {}).code || ""));
  res.redirect(`/admin/routers/${req.params.id}/plans`);
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
          uptime: plan.uptime, source: "batch",
          profile: `mv-${plan.code}`, sharedUsers: plan.shared_users,
          rateLimit: plan.rate_limit,
          comment: `lot ${new Date().toISOString().slice(0, 10)}`,
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
  // La selection arrive soit en "1,2,3", soit en ids=1&ids=2 (cases cochees).
  const brut = req.query.ids;
  const ids = (Array.isArray(brut) ? brut : String(brut || "").split(","))
    .map(Number).filter(Number.isInteger);
  if (ids.length === 0) return res.redirect("/admin/routers");
  const vouchers = await getVouchersByIds(ids);
  // Le nom du réseau vient de l'identité que le routeur rapporte : sans lui, le
  // client tient un code sans savoir à quel WiFi se connecter.
  const reseau = (vouchers[0] && vouchers[0].router_info && vouchers[0].router_info.identity)
    || (vouchers[0] && vouchers[0].router_name) || "";

  const tickets = vouchers.map((v) => `
    <div class="tk">
      <div class="tk-brand">${esc(reseau)}</div>
      <div class="tk-code">${esc(v.code)}</div>
      <div class="tk-plan">${esc(v.plan_label || "")}${v.price_htg != null ? ` · ${v.price_htg} HTG` : ""}</div>
      ${v.shared_users > 1 ? `<div class="tk-note">${v.shared_users} appareils</div>` : ""}
      <div class="tk-how">Connectez-vous au WiFi, puis entrez ce code.</div>
    </div>`).join("");

  res.type("html").send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Impression vouchers</title>
<style>
  body{font-family:system-ui,-apple-system,'Segoe UI',Arial;margin:16px;background:#fff;color:#111}
  .bar{display:flex;gap:12px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
  .bar button{padding:10px 20px;border:0;border-radius:999px;background:#16a34a;color:#fff;
    font-weight:700;cursor:pointer}
  .bar a{color:#16a34a;font-weight:600}
  .bar label{font-size:13px;color:#555;display:flex;align-items:center;gap:6px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:8px}
  .grid.dense{grid-template-columns:repeat(auto-fill,minmax(125px,1fr))}
  /* Pointillés = ligne de découpe. Rien ne doit toucher le bord. */
  .tk{border:1px dashed #9aa;border-radius:8px;padding:10px 8px;text-align:center;
    page-break-inside:avoid;break-inside:avoid}
  .tk-brand{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#666;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tk-code{font-family:ui-monospace,Consolas,monospace;font-size:19px;font-weight:800;
    letter-spacing:.16em;margin:5px 0 3px}
  .tk-plan{font-size:11px;color:#333;font-weight:600}
  .tk-note{font-size:10px;color:#16a34a;font-weight:700;margin-top:2px}
  .tk-how{font-size:9px;color:#777;margin-top:5px;line-height:1.3}
  .grid.dense .tk-how{display:none}
  .grid.dense .tk-code{font-size:16px}
  @media print{
    .bar{display:none}
    body{margin:0}
    /* Marges d'imprimante : sinon la dernière colonne saute. */
    @page{margin:8mm}
  }
</style></head><body>
<div class="bar">
  <button onclick="window.print()">Imprimer</button>
  <label><input type="checkbox" id="dense"> Format compact (plus par page)</label>
  <span style="color:#666;font-size:13px">${vouchers.length} voucher(s)</span>
  <a href="javascript:history.back()">Retour</a>
</div>
<div class="grid" id="grid">${tickets}</div>
<script>
  document.getElementById("dense").addEventListener("change", function () {
    document.getElementById("grid").classList.toggle("dense", this.checked);
  });
</script>
</body></html>`);
});

// --------------------------------------------------------------- ventes ----
const HTG = (n) => Number(n || 0).toLocaleString("fr-FR");

// Sauvegarde intégrale (JSON) : à télécharger régulièrement et garder ailleurs
// que chez l'hébergeur.
adminRouter.get("/admin/backup.json", requireAdmin, async (req, res) => {
  const data = await dumpAll();
  const jour = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="mikrovoucher-${jour}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

// Export comptable. Séparateur ';' et BOM : Excel en français ouvre le fichier
// directement, sans passer par l'assistant d'importation.
adminRouter.get("/admin/export.csv", requireAdmin, async (req, res) => {
  const ventes = await allSales();
  const champ = (v) => {
    const t = v == null ? "" : String(v);
    return /[";\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const lignes = [
    ["Date", "Routeur", "Forfait", "Montant HTG", "Canal", "Moyen", "Référence", "État", "Code"],
    ...ventes.map((v) => [
      v.date ? new Date(v.date).toLocaleString("fr-FR") : "",
      v.routeur, v.forfait, v.montant, v.canal, v.moyen, v.reference, v.etat, v.code,
    ]),
  ].map((l) => l.map(champ).join(";")).join("\r\n");

  const jour = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ventes-${jour}.csv"`);
  res.send("\uFEFF" + lignes);
});

// Graphique en barres, une seule série (recette du jour) : une seule teinte,
// pas de légende, libellé direct uniquement sur le meilleur jour.
function dailyChart(days) {
  const max = Math.max(...days.map((d) => d.htg), 1);
  const best = days.reduce((a, b) => (b.htg > a.htg ? b : a), days[0] || { htg: 0 });
  const jour = (iso) => new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });

  const bars = days.map((d) => {
    const h = Math.round((d.htg / max) * 100);
    const isBest = d.htg > 0 && d.htg === best.htg;
    return `<div class="bar-slot" tabindex="0"
      aria-label="${jour(d.jour)} : ${HTG(d.htg)} HTG, ${d.ventes} vente(s)">
      <div class="bar-tip">${jour(d.jour)}<br><strong>${HTG(d.htg)} HTG</strong><br>${d.ventes} vente(s)</div>
      <div class="bar" style="height:${h}%${isBest ? ";background:var(--accent-dark)" : ""}"></div>
    </div>`;
  }).join("");

  // Repères horizontaux : traits pleins, une nuance au-dessus de la surface.
  const ticks = [1, 0.5, 0].map((f) => `
    <div class="gridline" style="bottom:${f * 100}%">
      <span>${HTG(Math.round(max * f))}</span>
    </div>`).join("");

  return `
    <div class="chart">
      <div class="plot">${ticks}<div class="bars">${bars}</div></div>
      <div class="xaxis"><span>${days.length ? jour(days[0].jour) : ""}</span>
        <span>${best.htg > 0 ? "meilleur jour : " + jour(best.jour) + " (" + HTG(best.htg) + " HTG)" : ""}</span>
        <span>${days.length ? jour(days[days.length - 1].jour) : ""}</span></div>
    </div>`;
}

adminRouter.get("/admin/orders", requireAdmin, async (req, res) => {
  const jours = Math.min(Math.max(Number(req.query.j) || 30, 7), 90);
  const [orders, parRouteur, fin, cash, stock, parJour, parPlan, parMethode] =
    await Promise.all([
      listOrders(200), salesSummary(), financeSummary(), cashSummary(),
      stockByPlan(), salesByDay(jours), salesByPlan(), salesByMethod(),
    ]);

  // Recette globale = paiements en ligne + vouchers de lot effectivement utilisés.
  const totalHtg = fin.total_htg + cash.total_htg;
  const totalCount = fin.total_count + cash.total_count;
  const moyenne = totalCount > 0 ? Math.round(totalHtg / totalCount) : 0;
  const stockTotal = stock.reduce((a, s) => a + s.restants, 0);
  const stockValeur = stock.reduce((a, s) => a + s.restants * s.price_htg, 0);
  // Combien de paiements engagés aboutissent : un taux qui chute signale un
  // problème dans le tunnel, pas une baisse de la demande.
  const engages = fin.total_count + fin.expired_count;
  const conversion = engages > 0 ? Math.round((fin.total_count / engages) * 100) : null;

  // L'unité est un élément à part : sur un gros montant elle passe à la ligne
  // au lieu de pousser le chiffre hors de la tuile.
  const tuile = (label, valeur, detail, unite) => `
    <div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${valeur}${unite ? `<span class="kpi-unit">${unite}</span>` : ""}</div>
      <div class="kpi-detail">${detail || "&nbsp;"}</div>
    </div>`;

  const planRows = parPlan.map((p) => `
    <tr><td>${esc(p.label)}</td><td style="color:var(--ink-soft)">${esc(p.router_name)}</td>
      <td class="num">${p.ventes}</td>
      <td class="num" style="color:var(--ink-soft);font-size:12px">${p.en_ligne} / ${p.especes}</td>
      <td class="num"><strong>${HTG(p.htg)}</strong></td></tr>`).join("");
  const methodeRows = parMethode.map((m) => `
    <tr><td>${esc(m.method)}</td><td class="num">${m.ventes}</td>
      <td class="num"><strong>${HTG(m.htg)}</strong></td></tr>`).join("");
  const routeurRows = parRouteur.map((r) => `
    <tr><td>${esc(r.router_name)}</td><td class="num">${r.paid_count}</td>
      <td class="num"><strong>${HTG(r.total_htg)}</strong></td></tr>`).join("");
  // Vue tableau du graphique : tout ce qu'il montre reste lisible sans couleur.
  const jourRows = parJour.filter((d) => d.ventes > 0).reverse().map((d) => `
    <tr><td>${new Date(d.jour).toLocaleDateString("fr-FR")}</td>
      <td class="num">${d.ventes}</td><td class="num"><strong>${HTG(d.htg)}</strong></td></tr>`).join("");

  const rows = orders.map((o) => `
    <tr>
      <td class="mono" style="font-size:12px">${esc(o.reference)}</td>
      <td>${esc(o.router_name)}</td>
      <td>${esc(o.plan_label)}</td>
      <td class="num">${HTG(o.amount_htg)}</td>
      <td>${esc(o.method)}</td>
      <td>${o.status === "DELIVERED" ? `<span class="pill ok">livré</span>`
          : o.status === "PAID" ? `<span class="pill wait">payé</span>`
          : o.status === "EXPIRED" ? `<span class="pill off">expiré</span>`
          : `<span class="pill wait">en attente</span>`}</td>
      <td class="mono">${esc(o.voucher_code || "–")}</td>
      <td style="color:var(--ink-soft);font-size:12px">${new Date(o.created_at).toLocaleString("fr-FR")}</td>
    </tr>`).join("");

  res.type("html").send(layout("Ventes", `
    <h1>Finances</h1>
    <p class="sub">Ventes en ligne et vouchers vendus en espèces.
      <a class="btn ghost" style="padding:5px 12px;margin-left:8px"
         href="/admin/export.csv">Exporter en CSV</a>
      <a class="btn ghost" style="padding:5px 12px;margin-left:6px"
         href="/admin/backup.json">Sauvegarde complète</a></p>

    <div class="kpis">
      ${tuile("Aujourd'hui", HTG(fin.today_htg + cash.today_htg),
              (fin.today_count + cash.today_count) + " vente(s)", "HTG")}
      ${tuile("7 derniers jours", HTG(fin.week_htg + cash.week_htg), "", "HTG")}
      ${tuile("Ce mois", HTG(fin.month_htg + cash.month_htg), "", "HTG")}
      ${tuile("Total encaissé", HTG(totalHtg), totalCount + " vente(s)", "HTG")}
      ${tuile("Panier moyen", HTG(moyenne), "", "HTG")}
      ${tuile("Paiements aboutis", conversion === null ? "–" : conversion + " %",
              conversion === null ? "en ligne" : fin.expired_count + " abandonné(s) en ligne")}
    </div>

    <div class="card">
      <h2 style="margin-top:0">Répartition des recettes</h2>
      <table>
        <tr><th>Canal</th><th class="num">Ventes</th><th class="num">Recette</th></tr>
        <tr><td>En ligne <span style="color:var(--ink-soft)">(Moncash / Natcash / Kashpaw)</span></td>
          <td class="num">${fin.total_count}</td><td class="num"><strong>${HTG(fin.total_htg)} HTG</strong></td></tr>
        <tr><td>Espèces <span style="color:var(--ink-soft)">(vouchers de lot utilisés)</span></td>
          <td class="num">${cash.total_count}</td><td class="num"><strong>${HTG(cash.total_htg)} HTG</strong></td></tr>
      </table>
      <p class="sub" style="margin:12px 0 0">Un voucher imprimé compte comme vendu
      dès qu'il a servi sur le routeur : imprimé mais jamais utilisé, il reste du stock.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Stock de vouchers
        <span class="pill wait">${stockTotal} restant(s) · ${HTG(stockValeur)} HTG</span></h2>
      <table>
        <tr><th>Forfait</th><th>Routeur</th><th class="num">Restants</th><th class="num">Valeur</th></tr>
        ${stock.map((s) => `<tr><td>${esc(s.label)}</td>
          <td style="color:var(--ink-soft)">${esc(s.router_name)}</td>
          <td class="num">${s.restants}</td>
          <td class="num"><strong>${HTG(s.restants * s.price_htg)}</strong></td></tr>`).join("")
          || `<tr><td colspan="4" style="color:var(--ink-soft)">Aucun voucher en stock.</td></tr>`}
      </table>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
        <h2 style="margin:0">Recette par jour</h2>
        <div style="display:flex;gap:6px">
          ${[7, 30, 90].map((n) => `<a class="btn ghost" style="padding:6px 12px"
            href="/admin/orders?j=${n}">${n} j</a>`).join("")}
        </div>
      </div>
      ${dailyChart(parJour)}
      <details style="margin-top:12px">
        <summary style="cursor:pointer;color:var(--ink-soft);font-size:13px">Voir en tableau</summary>
        <table style="margin-top:10px">
          <tr><th>Jour</th><th class="num">Ventes</th><th class="num">Recette</th></tr>
          ${jourRows || `<tr><td colspan="3" style="color:var(--ink-soft)">Aucune vente sur la période.</td></tr>`}
        </table>
      </details>
    </div>

    <div class="grid2">
      <div class="card">
        <h2 style="margin-top:0">Par forfait</h2>
        <table><tr><th>Forfait</th><th>Routeur</th><th class="num">Ventes</th>
          <th class="num">ligne / esp.</th><th class="num">Recette</th></tr>
        ${planRows || `<tr><td colspan="5" style="color:var(--ink-soft)">Aucune vente.</td></tr>`}</table>
      </div>
      <div class="card">
        <h2 style="margin-top:0">Par moyen de paiement</h2>
        <table><tr><th>Moyen</th><th class="num">Ventes</th><th class="num">Recette</th></tr>
        ${methodeRows || `<tr><td colspan="3" style="color:var(--ink-soft)">Aucune vente.</td></tr>`}</table>
        <h2>Par routeur</h2>
        <table><tr><th>Routeur</th><th class="num">Ventes</th><th class="num">Recette</th></tr>
        ${routeurRows || `<tr><td colspan="3" style="color:var(--ink-soft)">Aucune vente.</td></tr>`}</table>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Dernières commandes</h2>
      <table>
        <tr><th>Référence</th><th>Routeur</th><th>Forfait</th><th class="num">Montant</th>
            <th>Méthode</th><th>État</th><th>Code</th><th>Date</th></tr>
        ${rows || `<tr><td colspan="8" style="color:var(--ink-soft)">Aucune commande.</td></tr>`}
      </table>
    </div>`, { active: "orders", side: menuGeneral("g-ventes") }));
});
