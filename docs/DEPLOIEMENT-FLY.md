# Déploiement sur Fly.io

## Pourquoi un processus permanent

Le service n'est pas une suite de fonctions sans mémoire. Deux choses s'y
appuient :

- la **réconciliation**, toutes les deux minutes : elle livre les codes aux
  clients qui ont payé puis fermé la page, et retire des routeurs les vouchers
  arrivés à échéance ;
- les **compteurs anti-abus** — limitation de débit, blocage après huit mots
  de passe ratés, anti-martèlement de Pay'm — qui vivent en mémoire.

D'où `auto_stop_machines = false` et `min_machines_running = 1` dans
`fly.toml`. Une machine qui s'endort ne livre plus rien et laisse vivre des
accès déjà expirés. **Ne pas y toucher** pour économiser quelques centimes.

## Première mise en place

```bash
fly launch --no-deploy          # reprend fly.toml, ne crée rien d'autre
fly secrets set \
  DATABASE_URL="postgres://…neon…" \
  ADMIN_PASSWORD="…" \
  PAYM_CLIENT_ID="…" \
  PAYM_BASE_URL="https://plopplop.solutionip.app" \
  PUBLIC_URL="https://api.peycash.tech"
fly deploy --remote-only        # Docker n'a pas besoin de tourner en local
```

`DATABASE_CA`, si vous l'utilisez, doit porter **le contenu** du certificat et
non un chemin : le fichier n'existe pas dans le conteneur.

## Le domaine

C'est lui qui rend cette migration unique. Tant que l'adresse du gestionnaire
appartient à l'hébergeur, en changer oblige à repasser sur chaque routeur.
Posée sur un domaine à vous, elle ne bouge plus jamais.

```bash
fly certs add api.peycash.tech
fly certs show api.peycash.tech   # donne les enregistrements DNS à créer
```

## La bascule, sans rien couper

Les routeurs portent l'adresse du gestionnaire **dans leur script d'agent**,
les portails dans leur `config.js`, et le walled-garden dans ses règles.
Changer l'adresse d'un coup les couperait tous. On s'en sert donc du mécanisme
de mise à jour de l'agent, pendant que l'ancien hébergeur tourne encore.

1. **Déployer sur Fly** et vérifier `https://api.peycash.tech/health`.
2. Sur **Render**, mettre `PUBLIC_URL=https://api.peycash.tech`. Le script que
   Render sert aux agents porte désormais la nouvelle adresse.
3. Sur **un seul routeur** — le moins exposé — cliquer **Script agent → Mettre
   à jour le routeur**. L'agent réimporte et bascule ; le walled-garden suit
   dans le même import.
4. Attendre une minute. Le routeur doit repasser **En ligne** et **Agent à
   jour** sur le tableau de bord servi par Fly.
5. Si c'est bon, faire les autres routeurs.
6. Déposer le `config.js` mis à jour sur chaque portail (BACKEND_URL =
   nouvelle adresse), puis **Pousser**.
7. Changer l'URL de retour dans le compte Pay'm : `…/return`.
8. Quand tous les routeurs sont en ligne sur Fly, éteindre Render.

Les deux instances peuvent viser la même base en même temps sans danger : la
prise d'une commande payée est atomique, et l'expiration des vouchers passe
par `FOR UPDATE SKIP LOCKED`. Deux réconciliations concurrentes ne font pas le
travail deux fois.

**Les clients ne sentent rien.** Le hotspot est local : les codes déjà vendus
continuent de fonctionner pendant toute la bascule. Seules la vente en ligne
et la livraison de nouveaux codes dépendent du gestionnaire, et elles ne sont
coupées que le temps d'un import d'agent — une quinzaine de secondes.

## Revenir en arrière

Tant que Render tourne, il suffit d'y remettre l'ancien `PUBLIC_URL` et de
relancer « Mettre à jour le routeur » depuis Fly : l'agent repart vers Render.
C'est pour cela qu'on n'éteint Render qu'à la toute fin.

## Surveillance

```bash
fly logs            # journal en direct
fly status          # état des machines
```

La sonde `/health/routers` reste la bonne alerte : elle échoue quand un
routeur cesse de rapporter, ce qui couvre aussi bien une panne du service
qu'une panne de routeur.
