import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { initDb, backfillTenants, backfillPaymEnv, backfillPlatformAdmin,
         backfillPlanValidity, semerGardenService, purgerSecretsPaym,
         vouchersDejaEchus,
         routersSilencieux } from "./db.js";
import { portalRouter, reconcile } from "./portal.js";
import { agentRouter } from "./agent.js";
import { adminRouter } from "./admin/pages.js";

const app = express();
app.set("trust proxy", config.trustProxy);

// Les rapports de l'agent arrivent en texte brut, quel que soit le Content-Type
// envoyé par /tool fetch. Ce parseur DOIT passer avant json/urlencoded, sinon
// ceux-ci consomment le corps et l'agent reçoit un objet au lieu du texte.
app.use(["/agent/report", "/agent/sessions", "/agent/users"],
  express.text({ type: "*/*", limit: "256kb" }));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// CORS uniquement pour l'API du portail (le dashboard est same-origin).
// CORS ouvert sur /api, volontairement.
// en production, listez vos portails : http://lambda.connect,http://tm.connect
// Restreindre par origine ne protégerait rien ici et casse le service :
//
//   - /api ne porte aucun cookie. L'authentification passe par un jeton dans
//     un en-tête, ou par un identifiant dans l'URL. Sans autorité ambiante,
//     il n'y a pas de CSRF à empêcher, et qui veut appeler l'API le fait avec
//     curl sans jamais rencontrer CORS.
//   - Chaque opérateur sert son portail depuis sa propre origine
//     (http://easytech.connect, http://lambda.connect…). Une liste fixe
//     obligerait à l'y ajouter à chaque nouveau client — et jusque-là son
//     portail afficherait zéro forfait, sans rien dire de la raison.
//
// Ce qui protège réellement ces routes, c'est la limitation de débit et le
// jeton de réclamation, tous deux en place.
if (config.corsOrigins.length > 0) {
  console.warn("[cors] CORS_ORIGINS est défini mais ignoré : une liste fixe " +
    "d'origines empêcherait les portails des autres opérateurs de fonctionner.");
}
const corsMw = cors({
  origin: true,             // sans credentials : les cookies ne partent pas
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-claim-token"],
});
app.use("/api", corsMw);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Sonde à surveiller (UptimeRobot, cron-job.org...) : elle échoue quand un
// routeur ne rapporte plus, ce qui déclenche l'alerte du service de
// surveillance déjà en place — pas de compte ni de secret supplémentaire.
app.get("/health/routers", async (_req, res) => {
  try {
    const muets = await routersSilencieux(config.routerSilenceSeconds);
    if (muets.length === 0) return res.json({ ok: true });
    res.status(503).json({
      ok: false,
      message: muets
        .map((r) => `${r.name} hors ligne` +
          (r.depuis ? ` depuis ${Math.round(r.depuis / 60)} min` : " (jamais vu)"))
        .join(" ; "),
      routeurs: muets,
    });
  } catch (err) {
    console.error("[health/routers]", err.message);
    res.status(500).json({ ok: false, message: "vérification impossible" });
  }
});

app.use(portalRouter);
app.use(agentRouter);
app.use(adminRouter);

app.get("/", (_req, res) => res.redirect("/admin"));

// Dernier rempart : on journalise et on répond, sans jamais tomber.
app.use((err, req, res, _next) => {
  console.error("[erreur]", req.method, req.originalUrl, err && err.message);
  if (res.headersSent) return;
  if (req.originalUrl.startsWith("/api") || req.originalUrl.startsWith("/agent")) {
    return res.status(500).json({ error: "Erreur interne." });
  }
  res.status(500).type("html").send(
    '<meta charset="utf-8"><p style="font-family:system-ui;padding:30px">' +
    "Une erreur est survenue. Réessayez, ou revenez au " +
    '<a href="/admin">tableau de bord</a>.</p>');
});

// Un incident isolé ne doit pas emporter le service (les clients paient).
process.on("unhandledRejection", (reason) =>
  console.error("[unhandledRejection]", reason && reason.message ? reason.message : reason));
process.on("uncaughtException", (err) =>
  console.error("[uncaughtException]", err && err.message ? err.message : err));

async function main() {
  await initDb();
  const rattaches = await backfillTenants();
  if (rattaches) {
    console.log(`[tenants] « ${rattaches.nom} » créé : ${rattaches.routeurs} routeur(s), ${rattaches.comptes} compte(s) rattachés`);
  }
  const encaisse = await backfillPaymEnv();
  if (encaisse) console.log(`[paym] « ${encaisse} » conserve les identifiants de l'environnement`);
  const promu = await backfillPlatformAdmin();
  if (promu) console.log(`[plateforme] ${promu} devient administrateur du service`);
  const purges = await purgerSecretsPaym();
  if (purges) console.log(`[paym] ${purges} clé(s) secrète(s) effacée(s) : inutilisées par l'encaissement`);
  const semees = await semerGardenService();
  if (semees) console.log(`[walled-garden] ${semees} entrée(s) de paiement posées`);
  const majores = await backfillPlanValidity();
  if (majores > 0) {
    const echus = await vouchersDejaEchus();
    console.log(`[migration] validité calendaire déduite pour ${majores} forfait(s)`);
    if (echus > 0) {
      console.log(`[migration] ${echus} voucher(s) déjà au-delà de leur validité ` +
        `seront retirés au prochain cycle`);
    }
  }
  setInterval(reconcile, config.reconcileIntervalMs);
  app.listen(config.port, () =>
    console.log(`Mikrovoucher Manager sur le port ${config.port}`));
}

main().catch((err) => {
  console.error("Échec du démarrage :", err);
  process.exit(1);
});
