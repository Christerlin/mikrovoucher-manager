// Règlement d'une commande payée (modèle "pull") :
// le backend vérifie Pay'm, réclame la commande atomiquement, crée le voucher
// et met une commande 'add' en file — c'est le routeur qui la tirera et créera
// l'utilisateur hotspot. DELIVERED seulement après confirmation du routeur.

import { verifyPayment } from "./paym.js";
import {
  claimPaid, getOrder, getPlanById, createVoucher, attachVoucherToOrder,
  getVoucherById, prolongerVoucher, getVoucherByCode, paymDuRouteur,
} from "./db.js";
import { generateVoucherCode, durationToSeconds } from "./codes.js";

// Crée le voucher lié à une commande PAID (avec reprise si un précédent
// essai a échoué à mi-chemin). Collision de code -> nouveau tirage.
async function ensureVoucher(order) {
  if (order.voucher_id) return order.voucher_id;
  const plan = await getPlanById(order.plan_id);
  if (!plan) throw new Error(`Plan introuvable : ${order.plan_id}`);

  // Recharge : on prolonge le code en service au lieu d'en creer un neuf.
  if (order.recharge_code) {
    const r = await prolongerVoucher(order.router_id, order.recharge_code,
      durationToSeconds(plan.uptime), plan);
    if (r) {
      await attachVoucherToOrder(order.reference, r.voucherId);
      return r.voucherId;
    }
    // Le code a disparu ou expire entre le paiement et la livraison : plutot
    // qu'une vente sans contrepartie, on delivre un code neuf.
    console.warn(`[deliver] recharge impossible pour ${order.recharge_code}, code neuf`);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateVoucherCode(8);
    try {
      const v = await createVoucher({
        routerId: order.router_id,
        code,
        planId: plan.id,
        uptime: plan.uptime,
        source: "order",
        profile: `mv-${plan.code}`,
        sharedUsers: plan.shared_users,
        rateLimit: plan.rate_limit,
        comment: `paym ${order.reference}`,
      });
      await attachVoucherToOrder(order.reference, v.id);
      return v.id;
    } catch (err) {
      if (String(err.code) === "23505") continue; // code déjà pris -> retirage
      throw err;
    }
  }
  throw new Error(`Impossible de générer un code unique pour ${order.reference}`);
}

// Traite une commande côté paiement. Renvoie l'état courant pour le portail.
// Le code n'est renvoyé QUE lorsque le routeur a confirmé (DELIVERED).
export async function processOrder(order) {
  if (order.status === "DELIVERED") {
    const v = order.voucher_id ? await getVoucherById(order.voucher_id) : null;
    // Pour une recharge, le portail doit savoir s'il faut laisser le client
    // tranquille (session en cours) ou le reconnecter (code reactive apres
    // coupure). used_at le dit : il est vide tant que le code n'a pas resservi.
    const prolonge = Boolean(order.recharge_code && v && v.used_at);
    return { status: "DELIVERED", voucherCode: v ? v.code : undefined, prolonge };
  }
  if (order.status === "EXPIRED" || order.status === "FAILED") {
    return { status: order.status };
  }
  if (order.status === "PAID") {
    await ensureVoucher(order); // reprise éventuelle ; sinon no-op
    return { status: "PAID" };  // en attente de création par le routeur
  }

  // PENDING -> on interroge Pay'm, avec les identifiants de l'operateur qui
  // possede le routeur : c'est son encaissement qu'on verifie.
  const compte = await paymDuRouteur(order.router_id);
  const result = await verifyPayment(order.reference, compte ? compte.paym_client_id : null);
  if (!result.paid) return { status: "PENDING" };
  if (!(result.amountHtg >= order.amount_htg)) {
    console.warn(`[deliver] Sous-paiement ${order.reference} : payé ${result.amountHtg}, attendu ${order.amount_htg}`);
    return { status: "PENDING", underpaid: true };
  }
  const won = await claimPaid(order.reference, result.transactionId);
  if (!won) {
    const fresh = await getOrder(order.reference);
    return processOrder(fresh); // un autre process a gagné -> relire l'état
  }
  const fresh = await getOrder(order.reference);
  await ensureVoucher(fresh);
  return { status: "PAID" };
}
