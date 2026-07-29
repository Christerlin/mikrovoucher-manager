// Configuration centrale — tout vient de l'environnement, rien en dur.

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: required("DATABASE_URL"),

  // Mot de passe du dashboard (un seul admin : c'est VOTRE instance).
  adminPassword: required("ADMIN_PASSWORD"),

  // URL publique de cette application (scripts routeur + Return URL Pay'm).
  // Accepte aussi un simple hôte : Render fournit "app.onrender.com" via
  // fromService/host, on complète alors le schéma.
  publicUrl: (function () {
    var u = (process.env.PUBLIC_URL || "").trim().replace(/\/$/, "");
    if (!u) return "";
    return /^https?:\/\//.test(u) ? u : "https://" + u;
  })(),

  // Pay'm (agrégateur Moncash / Natcash / Kashpaw). Optionnel : sans
  // PAYM_CLIENT_ID, le paiement en ligne est désactivé mais le reste
  // (vouchers en lot, dashboard, agent) fonctionne.
  paym: {
    baseUrl: process.env.PAYM_BASE_URL || "https://plopplop.solutionip.app",
    clientId: process.env.PAYM_CLIENT_ID || null,
  },

  // CORS : origines des portails captifs (une par routeur, séparées par des
  // virgules). Ex : http://lambda.connect,http://tm.connect,http://172.17.10.1
  corsOrigins: (process.env.CORS_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean),

  trustProxy: Number(process.env.TRUST_PROXY || 1),

  // Comportement paiement (voir doc Pay'm : pas de webhook -> polling).
  orderExpiryMinutes: Number(process.env.ORDER_EXPIRY_MINUTES || 15),
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS || 120000),
  verifyThrottleMs: Number(process.env.VERIFY_THROTTLE_MS || 4000),
  handoffTtlMs: Number(process.env.HANDOFF_TTL_MS || 15 * 60 * 1000),
  returnDbTimeoutMs: Number(process.env.RETURN_DB_TIMEOUT_MS || 2500),
};
