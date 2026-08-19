// Client Pay'm — cash-in (collecte) uniquement.
// Points clés vérifiés en production (voir doc du projet portail) :
//   - montant en gourdes ENTIÈRES (Natcash rejette les décimales) -> Math.ceil
//   - champ de référence mal orthographié : refference_id (double f) — volontaire
//   - pas de webhook -> on POLL /api/paiement-verify
//   - la Return URL se configure dans le dashboard Pay'm (niveau compte) et
//     reçoit ?statut=ok&id_transaction=...&refference_id=... (non documenté)

import { config } from "./config.js";

// Chaque operateur encaisse chez lui : le client_id vient de son compte, et
// les variables d'environnement ne servent plus que de repli pour
// l'installation d'origine, qui n'a rien a ressaisir.
export const paymentsEnabled = (clientId) => Boolean(clientId);

async function post(path, body) {
  const res = await fetch(`${config.paym.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Pay'm ${path} ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

export async function createPayment({ reference, montantHtg, method, clientId }) {
  const montant = Math.ceil(montantHtg);
  if (montant < 20) throw new Error("Montant minimum : 20 HTG");
  const j = await post("/api/paiement-marchand", {
    client_id: clientId,
    refference_id: reference,
    montant,
    payment_method: method, // moncash | natcash | kashpaw | all
  });
  if (!j.url) throw new Error(`Pay'm : pas d'URL de redirection (${JSON.stringify(j).slice(0, 200)})`);
  return { redirectUrl: j.url, transactionId: j.transaction_id || null };
}

export async function verifyPayment(reference, clientId) {
  const j = await post("/api/paiement-verify", {
    client_id: clientId,
    refference_id: reference,
  });
  return {
    paid: j.trans_status === "ok",
    amountHtg: Number(j.montant),
    transactionId: j.id_transaction || null,
  };
}
