# Mikrovoucher Manager

Gestionnaire de hotspots **MikroTik** auto-hébergé, pensé pour Haïti :
multi-routeurs, vouchers, **paiement mobile** (Moncash / Natcash / Kashpaw via
l'agrégateur Pay'm) et livraison automatique des codes — le tout **compatible
CGNAT** (Starlink, 4G) : les routeurs se connectent en **sortant**, aucun port
à ouvrir, aucune IP publique nécessaire.

> Une alternative cloud à Mikhmon : votre instance, votre base, vos clés de
> paiement. Chacun déploie la sienne.

## Fonctionnalités
- **Multi-routeurs** : chaque MikroTik tire sa file de commandes (agent pull
  15 s) ; état en ligne/hors ligne dans le dashboard
- **Forfaits par routeur** (nom, prix HTG, durée RouterOS)
- **Vouchers en lot** + page d'impression (tickets à découper)
- **Vente en ligne** : le portail captif encaisse par Moncash/Natcash/Kashpaw,
  le code est créé sur le bon routeur et le client est connecté automatiquement
- Sécurité éprouvée : réclamation atomique des paiements, claim token, PIN de
  récupération verrouillé anti-brute-force, jeton de passation à durée courte
- **Script agent généré par le dashboard** pour chaque routeur (copier-coller)

## Déploiement (Render, ~10 min)

1. **Base de données** : créez un projet sur [Neon](https://neon.tech)
   (offre gratuite qui n'expire pas) et copiez la chaîne de connexion
   *direct* (sans `-pooler`, en gardant `?sslmode=require`).
2. Forkez ce dépôt, puis sur [Render](https://render.com) :
   **New → Blueprint** → sélectionnez votre fork. Renseignez :
   - `DATABASE_URL` : la chaîne Neon
   - `PAYM_CLIENT_ID` : votre `pp_...` (laissez vide pour démarrer sans
     paiement en ligne)
   - `CORS_ORIGINS` : les origines de vos portails captifs
3. Ouvrez `https://votre-app.onrender.com/admin` — le mot de passe admin est
   généré par Render, visible dans l'onglet *Environment* (`ADMIN_PASSWORD`).
4. Plan gratuit Render : le service s'endort après ~15 min. Ajoutez un ping
   [UptimeRobot](https://uptimerobot.com) sur `/health` toutes les 5 min, sinon
   un client qui revient de paiement attend le réveil du service.

> Toute base PostgreSQL fait l'affaire (Neon, Supabase, Render, la vôtre).
> Évitez simplement les offres gratuites qui **expirent** : vous y perdriez
> les vouchers et l'historique des ventes.

## Brancher un routeur MikroTik

1. Dashboard → **Routeurs → Ajouter** (nom, slug, URL du portail).
2. Ouvrez la fiche du routeur : copiez le **script agent** généré, importez-le
   sur le MikroTik (`/import mikrovoucher-agent.rsc`).
   - Prérequis RouterOS v7 : `/system device-mode print` doit montrer
     `hotspot=yes fetch=yes scheduler=yes` (sinon `/system device-mode update …`
     puis **couper l'alimentation** pour confirmer).
3. Le routeur passe « En ligne » dans le dashboard dès le premier appel (≤ 15 s).
4. Créez les forfaits du routeur, puis générez un lot de vouchers pour tester.

## Portail captif (pages du hotspot)

Les pages du portail (login, tarifs, paiement) vivent sur le routeur et parlent
à ce manager. Utilisez le portail du dépôt
[mikrotik-hotspot-voucher](https://github.com/Christerlin/mikrotik-hotspot-voucher) :
dans `hotspot/config.js`, pointez `BACKEND_URL` vers ce manager et renseignez
`ROUTER_SLUG` avec le slug du routeur.

Chez Pay'm, configurez la **Return URL** du compte vers
`https://votre-app.onrender.com/return` — le manager renvoie chaque client vers
le portail du routeur où il a payé.

## API (résumé)

| Route | Rôle |
|---|---|
| `POST /api/checkout` | `{routerSlug, planId, method}` → URL de paiement Pay'm |
| `GET /api/order/:ref` | suivi (en-tête `x-claim-token`) |
| `GET /api/retrieve/:pin` | récupération par PIN (secours) |
| `GET /api/handoff/:token` | échange du jeton de retour de paiement |
| `GET /return` | Return URL Pay'm → redirige vers le portail du routeur |
| `GET /agent/next` · `GET /agent/ack` | file de commandes du routeur (en-tête `x-router-token`) |
| `GET /api/portal/:slug/plans` | forfaits actifs d'un routeur |

## Notes de sécurité
- Un seul admin (`ADMIN_PASSWORD`) — c'est **votre** instance.
- Les jetons routeur identifient chaque MikroTik (192 bits aléatoires) ; ils
  s'affichent dans le dashboard pour générer le script : ne partagez pas
  l'accès au dashboard.
- Restreignez `CORS_ORIGINS` en production.
- Aucun secret dans ce dépôt : tout vit dans vos variables d'environnement.

## Licence
MIT — développé par Christerlin Joseph.
