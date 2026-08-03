# Sauvegarde et alertes

Deux filets de sécurité, tous deux gratuits et sans compte supplémentaire.

## 1. Alerte « routeur hors ligne »

L'agent MikroTik rapporte au manager toutes les 15 s. S'il se tait, c'est que
le routeur est éteint, sans Internet, ou que le script a été effacé — et vos
clients ne peuvent plus acheter.

La sonde `GET /health/routers` répond :

- **200** `{"ok":true}` — tous les routeurs rapportent ;
- **503** avec le détail dès qu'un routeur est muet depuis plus de 5 minutes.

Comme un service de surveillance alerte quand une URL renvoie une erreur, il
suffit d'ajouter **un second moniteur** à côté de celui qui garde déjà le
service éveillé :

| Champ | Valeur |
|---|---|
| Type | HTTP(s) |
| URL | `https://VOTRE-APP.onrender.com/health/routers` |
| Intervalle | 5 min |

Vous recevrez le mail d'alerte du service de surveillance, sans configurer
d'expéditeur ni de mot de passe SMTP ici.

Le seuil se règle avec `ROUTER_SILENCE_SECONDS` (300 par défaut). Trop bas, un
simple redémarrage du routeur déclencherait une fausse alerte.

## 2. Sauvegarde de la base

L'offre gratuite d'un hébergeur de base de données **n'est pas une
sauvegarde** : un projet supprimé, une région en panne, une erreur de
manipulation, et vouchers comme historique de ventes disparaissent.

Dans **Finances → Sauvegarde complète**, téléchargez
`mikrovoucher-AAAA-MM-JJ.json`. Il contient les routeurs, les forfaits, tous
les vouchers et toutes les commandes.

Les **jetons des routeurs (`pull_token`) en sont volontairement exclus** : un
fichier de sauvegarde circule (mail, clé USB, téléphone) et ne doit pas donner
la main sur un routeur. Après une restauration, recréez le routeur dans le
dashboard et réimportez son script d'agent — c'est une minute de travail.

**Rythme conseillé :** une sauvegarde par semaine, plus une avant toute
opération risquée (changement de forfaits, migration, mise à jour). Gardez-la
ailleurs que chez l'hébergeur (Drive, disque local).

**Restauration :** dans **Finances → Restaurer une sauvegarde**, déposez le
fichier. L'opération est **additive** : elle remet ce qui manque et n'efface
jamais rien — une restauration qui supprime serait une deuxième façon de
perdre ses données. On peut donc la relancer sans risque : ce qui existe déjà
est laissé tel quel.

Les identifiants du fichier ne veulent rien dire dans une base neuve ; le
rapprochement se fait par slug (routeurs), par code (forfaits, vouchers) et
par référence (ventes). Les liens entre une vente et son voucher sont
rétablis au passage.

Deux gestes restent manuels après une restauration, et c'est voulu :

1. **Réimporter le script agent** du routeur. La sauvegarde ne contient pas
   son jeton, donc un routeur recréé en reçoit un neuf — l'ancien script ne
   serait plus reconnu.
2. **« Resynchroniser les vouchers »** depuis la fiche du routeur, pour
   remettre les codes sur l'appareil. L'agent ignore ceux qui s'y trouvent
   déjà, l'opération est sans danger.
