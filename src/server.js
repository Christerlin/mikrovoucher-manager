import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { initDb, backfillPlanValidity, vouchersDejaEchus, routersSilencieux } from "./db.js";
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
// Sans CORS_ORIGINS on autorise tout (démarrage facile) avec un avertissement ;
// en production, listez vos portails : http://lambda.connect,http://tm.connect
if (config.corsOrigins.length === 0) {
  console.warn("[cors] CORS_ORIGINS non défini : /api/* accepte toutes les origines. " +
    "Restreignez-le en production.");
}
const corsMw = cors({
  origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
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
