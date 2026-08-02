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

**Restauration :** le fichier est du JSON lisible. Recréez le routeur et les
forfaits dans le dashboard, puis réinjectez les vouchers encore actifs. Comme
l'agent ignore les codes déjà présents, une resynchronisation depuis la fiche
du routeur suffit ensuite à remettre le MikroTik d'aplomb.
