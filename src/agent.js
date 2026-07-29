// API réservée aux ROUTEURS (modèle pull, compatible CGNAT/Starlink).
// Chaque routeur s'identifie par son jeton (en-tête x-router-token, jamais en
// query string) et vient tirer sa file de commandes toutes les ~15 s.
//
// Réponses en texte brut, triviales à parser en script RouterOS :
//   GET /agent/next -> "cmdId|action|code|uptime|comment"   (vide si rien)
//   GET /agent/ack?id=N -> "ok"
// Chaque appel met à jour last_seen (état "en ligne" du dashboard).

import express, { Router } from "express";
import { getRouterByToken, touchRouter, nextCommand, ackCommand, updateRouterInfo } from "./db.js";

export const agentRouter = Router();

async function authRouterDevice(req, res) {
  const token = String(req.headers["x-router-token"] || "");
  // Le jeton (192 bits aléatoires) est la clé de recherche : pas d'énumération
  // possible. Réponse identique qu'il soit absent ou inconnu.
  const router = token ? await getRouterByToken(token) : null;
  if (!router) {
    res.status(403).type("text/plain").send("forbidden");
    return null;
  }
  await touchRouter(router.id);
  return router;
}

agentRouter.get("/agent/next", async (req, res) => {
  try {
    const router = await authRouterDevice(req, res);
    if (!router) return;
    const cmd = await nextCommand(router.id);
    res.type("text/plain");
    if (!cmd) return res.send("");
    const p = cmd.payload || {};
    // Le séparateur | n'apparaît jamais dans nos codes (alphabet contrôlé).
    res.send([cmd.id, cmd.action, p.code || "", p.uptime || "", p.comment || ""].join("|"));
  } catch (err) {
    console.error("[agent/next]", err.message);
    res.status(502).type("text/plain").send("");
  }
});

agentRouter.get("/agent/ack", async (req, res) => {
  try {
    const router = await authRouterDevice(req, res);
    if (!router) return;
    const id = Number(req.query.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).type("text/plain").send("bad id");
    await ackCommand(router.id, id);
    res.type("text/plain").send("ok");
  } catch (err) {
    console.error("[agent/ack]", err.message);
    res.status(502).type("text/plain").send("");
  }
});

// Rapport d'état du routeur, envoyé à chaque cycle de l'agent.
// Corps texte : identite|version|board|uptime|cpu|freeMem|totalMem|actifs|users
agentRouter.post("/agent/report",
  express.text({ type: "*/*", limit: "4kb" }),
  async (req, res) => {
    try {
      const router = await authRouterDevice(req, res);
      if (!router) return;
      const parts = String(req.body || "").split("|");
      const [identity, version, board, uptime, cpuLoad, freeMem, totalMem, activeUsers, totalUsers] = parts;
      await updateRouterInfo(router.id, {
        identity: identity || null,
        version: version || null,
        board: board || null,
        uptime: uptime || null,
        cpuLoad: Number(cpuLoad) || 0,
        freeMem: Number(freeMem) || 0,
        totalMem: Number(totalMem) || 0,
        activeUsers: Number(activeUsers) || 0,
        totalUsers: Number(totalUsers) || 0,
        reportedAt: new Date().toISOString(),
      });
      res.type("text/plain").send("ok");
    } catch (err) {
      console.error("[agent/report]", err.message);
      res.status(502).type("text/plain").send("");
    }
  });
