# Ajouter un routeur au manager

Marche à suivre complète pour brancher un nouveau MikroTik sur le manager :
du routeur sorti du carton jusqu'à la première vente en ligne.

Compter **30 à 45 min** la première fois. Les pièges connus (device-mode, DNS,
walled-garden) sont signalés à chaque étape : ce sont eux qui font perdre des
heures, pas la configuration elle-même.

---

## 0. Avant de commencer

À avoir sous la main :

| | |
|---|---|
| Accès WinBox au routeur | par MAC suffit (pas besoin d'IP) |
| Accès au dashboard | `https://<votre-manager>/admin` |
| Sous-réseau libre | un par routeur, ex. `172.17.10.0/24`, `172.20.10.0/24` |
| Nom DNS du portail | ex. `lambda.connect`, `tm.connect` |

> **Une règle simple :** deux routeurs ne doivent jamais partager le même
> sous-réseau ni le même `dns-name`, sinon les portails se marchent dessus.

---

## 1. Débloquer device-mode (le piège n°1)

RouterOS v7 bloque par défaut les fonctions dont le manager a besoin. **Sans
cette étape, rien ne fonctionne et les erreurs sont silencieuses.**

```
/system device-mode print
```

Il faut `hotspot: yes`, `fetch: yes`, `scheduler: yes`. Sinon :

```
/system device-mode update hotspot=yes fetch=yes scheduler=yes
```

RouterOS demande alors une **confirmation physique** :
**coupez l'alimentation** (débranchez, attendez 5 s, rebranchez) — ou appuyez
sur le bouton reset pendant le démarrage.

> ⚠️ Un `/system reboot` ne suffit **pas**. Il faut une vraie coupure.

Après redémarrage, re-vérifiez que les trois sont à `yes`.

---

## 2. Configuration de base du routeur

Repartez d'une base propre :

```
/system reset-configuration no-defaults=yes skip-backup=yes
```

Puis adaptez et importez un modèle du dossier `routers/` du dépôt portail
(`lambda-network-L009-RM.rsc` pour un L009, `hap-lite-captive.example.rsc`
pour un hAP lite autonome). Les points qui **doivent** y figurer :

```
# Réseau hotspot + DHCP
/ip pool add name=hs-pool ranges=172.20.10.2-172.20.10.254
/ip dhcp-server network
add address=172.20.10.0/24 gateway=172.20.10.1 dns-server=172.20.10.1

# DNS : sans ceci les clients ne résolvent aucun nom -> le portail et le
# paiement échouent, même avec un walled-garden correct.
/ip dns set allow-remote-requests=yes

# NAT vers Internet
/ip firewall nat add action=masquerade chain=srcnat out-interface=WAN

# Hotspot
/ip hotspot profile
add name=hsprof dns-name=monsite.connect hotspot-address=172.20.10.1 \
    login-by=cookie,http-chap,http-pap,mac-cookie
/ip hotspot
add name=hs interface=hs-bridge address-pool=hs-pool \
    addresses-per-mac=1 profile=hsprof disabled=no

# Horloge : pas de RTC sur ces modèles. Sans NTP, après une coupure de
# courant l'heure repart à zéro et le scheduler/HTTPS se comportent mal.
/system ntp client set enabled=yes
/system ntp client servers add address=pool.ntp.org
```

Mettez aussi un mot de passe admin **avant** de mettre le routeur en service :

```
/user set admin password=UN_MOT_DE_PASSE_FORT
```

---

## 3. Déclarer le routeur dans le dashboard

**Routeurs → Ajouter** :

| Champ | Exemple | Remarque |
|---|---|---|
| Nom | `Boutique centre-ville` | libre |
| Slug | `centre` | minuscules/chiffres/tirets, **sans espace** |
| URL du portail | `http://monsite.connect/prix.html` | sert au retour de paiement |

Le slug identifie ce routeur dans l'API du portail : il ira dans le
`config.js` du portail (étape 6).

---

## 4. Importer l'agent sur le routeur

Sur la fiche du routeur : **Copier le script** (ou **Télécharger .rsc**).

Le script contient déjà l'URL du manager et le jeton propre à ce routeur —
rien à modifier.

- **Copier-coller** : WinBox → New Terminal → coller → Entrée
- **ou fichier** : Files → glisser `mikrovoucher-agent.rsc` → puis
  `/import mikrovoucher-agent.rsc`

Vérifier :

```
/system script print        # doit lister mikrovoucher-agent
/system scheduler print     # mikrovoucher-sched, interval=15s
```

Dans les **15 secondes**, le dashboard doit passer à **En ligne** et afficher
le modèle, la version RouterOS, le CPU et la RAM.

> Si le routeur reste « Jamais vu », voir le **dépannage** en fin de document.

---

## 5. Créer les forfaits

**Forfaits → Ajouter** :

| Champ | Exemple | Attention |
|---|---|---|
| Code | `3j` | **sans espace** : sert d'identifiant API *et* de nom de profil RouterOS |
| Nom | `3 jours` | ce que voit le client |
| Prix HTG | `100` | minimum **20 HTG** (limite Pay'm) |
| Durée RouterOS | `3d` | `30m`, `12h`, `3d`, `1w` |
| Appareils | `1` | appareils simultanés avec le même code |

Le prix saisi ici est **celui qui sera débité** : le portail l'affiche en le
lisant depuis le manager, il ne peut donc pas y avoir d'écart.

> **Appareils :** le changement s'applique sur le routeur à la création du
> voucher suivant de ce forfait (l'agent met alors à jour le profil
> `mv-<code>`, ce qui vaut pour tous les codes de ce forfait).

---

## 6. Installer le portail sur le routeur

Depuis le dépôt portail
[mikrotik-hotspot-voucher](https://github.com/Christerlin/mikrotik-hotspot-voucher) :

1. Copiez `hotspot/config.example.js` vers `hotspot/config.js` et renseignez :

```js
window.BACKEND_URL   = "https://<votre-manager>.onrender.com";
window.WHATSAPP_NUMBER = "509XXXXXXXX";
window.ROUTER_SLUG   = "centre";   // le slug de l'étape 3
```

2. Copiez **tout** le dossier `hotspot/` dans `/flash/hotspot/` du routeur
   (WinBox → Files → glisser-déposer), en gardant les sous-dossiers
   `css/`, `img/`, `xml/`.

3. Autorisez l'origine du portail côté manager : variable `CORS_ORIGINS` de
   votre hébergeur, séparées par des virgules :

```
http://monsite.connect,http://172.20.10.1
```

> ⚠️ Oublier cette étape donne un « paiement indisponible » côté client :
> le navigateur bloque l'appel, alors que le manager va très bien.

---

## 7. Ouvrir le walled-garden

Un client **pas encore connecté** doit pouvoir joindre le manager et les
pages de paiement :

```
/ip hotspot walled-garden
add dst-host=*.onrender.com comment="manager"
add dst-host=*.solutionip.app comment="Pay'm"
add dst-host=paymplopplop.com comment="Pay'm retour"
add dst-host=*.paymplopplop.com comment="Pay'm retour"
add dst-host=*.moncashbutton.digicelgroup.com comment="Moncash"
add dst-host=*.digicelgroup.com comment="Moncash"
add dst-host=*.natcash.ht comment="Natcash"
add dst-host=*.natcom.com.ht comment="Natcash"
add dst-host=merchantpay.natcom.com.ht comment="Natcash paiement"
```

> ⚠️ **Le filtrage par nom d'hôte n'est pas fiable en HTTPS.** Si une page
> reste bloquée alors que son domaine est autorisé, ajoutez son **IP** :
>
> ```
> :put [:resolve mikrovoucher-manager.onrender.com]
> /ip hotspot walled-garden ip add action=accept dst-address=216.24.57.0/24
> ```
>
> Pour trouver l'IP fautive, reproduisez le blocage puis regardez les
> connexions marquées d'un `d` (DST-NAT) qui rejouent sans cesse :
> `/ip firewall connection print where dst-port=443`

---

## 8. Vérifier avant d'ouvrir aux clients

Générez d'abord un **voucher de test** (Vouchers → Générer un lot, quantité 1),
puis :

- [ ] Le code apparaît dans **Vouchers** avec l'état « sur le routeur » (≤ 15 s)
- [ ] `/ip hotspot user print` sur le routeur montre bien le code
- [ ] Un téléphone connecté au WiFi voit le portail
- [ ] La page **Tarifs** affiche les forfaits **du dashboard** (pas les cartes
      de secours : modifiez un prix, il doit changer sans toucher au routeur)
- [ ] Le code de test connecte l'appareil
- [ ] Le client apparaît dans **Clients connectés** avec forfait et temps restant

Puis un **vrai paiement** avec le forfait le moins cher (20 HTG suffit) :

- [ ] Redirection vers Moncash/Natcash
- [ ] Retour automatique au portail
- [ ] Le code s'affiche et connecte tout seul
- [ ] La vente apparaît dans **Ventes**

---

## 9. Paiement en ligne : réglages côté Pay'm

À faire **une seule fois par compte Pay'm**, pas par routeur :

- **Return URL** : `https://<votre-manager>/return`
  Le manager renvoie chaque client vers le portail du routeur où il a payé.
- Un `client_id` Pay'm **par projet**. Le Return URL est réglé au niveau du
  compte : deux projets partageant un `client_id` se renverraient mutuellement
  leurs clients.

---

## Dépannage

### Le routeur reste « Jamais vu »

Testez l'appel à la main (le script, lui, avale les erreurs) :

```
:put ([/tool fetch url="https://<votre-manager>/agent/next" \
  http-header-field="x-router-token: <JETON>" \
  http-method=get output=user as-value]->"data")
```

| Résultat | Cause |
|---|---|
| Ligne vide, pas d'erreur | ✅ la liaison marche — vérifiez le scheduler |
| `forbidden` | jeton différent de celui du dashboard : réimportez le script |
| Erreur DNS / timeout | le routeur n'a pas Internet, ou l'hébergeur dormait |
| Rien ne se passe du tout | `fetch`/`scheduler` bloqués par device-mode (étape 1) |

Vérifiez aussi que le script contient bien l'URL **complète** du manager
(`https://…onrender.com`, pas juste un nom de service).

### Les clients n'ont pas Internet après connexion

`/ip dns print` → `allow-remote-requests` doit être à `yes`, et le DHCP doit
distribuer le routeur comme DNS (étape 2). Faites « oublier le réseau » sur
le téléphone avant de retester : il garde l'ancienne configuration.

### « Paiement indisponible » sur le portail

Le manager répond mais le navigateur bloque : ajoutez l'origine du portail
dans `CORS_ORIGINS` (étape 6), puis rechargez la page.

### La page de paiement met très longtemps / se coupe

Le domaine passe le walled-garden par nom mais pas en pratique : autorisez
son IP (étape 7). C'est le cas le plus fréquent avec Natcash.

### Le client a payé mais n'a pas reçu son code

Rien n'est perdu : le voucher est créé de toute façon.
- **Ventes** dans le dashboard montre l'état de la commande.
- Le client peut cliquer **« Déjà payé ? »** et saisir son code de récupération.
- En dernier recours : `/ip hotspot user print detail where comment~"paym"`
  sur le routeur donne le code.

Si l'hébergeur est sur une offre gratuite, il s'endort : un client de retour
attend le réveil. Un ping type UptimeRobot sur `/health` toutes les 5 min
règle le problème.

---

## Récapitulatif express

```
1. device-mode : hotspot/fetch/scheduler = yes  (+ coupure de courant)
2. Config routeur : hotspot, DHCP, DNS allow-remote-requests, NAT, NTP
3. Dashboard : Routeurs → Ajouter (nom, slug, URL du portail)
4. Copier le script agent → l'importer → "En ligne" en 15 s
5. Dashboard : créer les forfaits (codes sans espace, prix ≥ 20 HTG)
6. config.js (BACKEND_URL + ROUTER_SLUG) + dossier hotspot/ → /flash/hotspot/
   et ajouter l'origine du portail à CORS_ORIGINS
7. Walled-garden : manager + Pay'm + Moncash + Natcash (par IP si besoin)
8. Voucher de test, puis vrai paiement au tarif le plus bas
```


## Comptes et rôles

Le dashboard n'a plus de mot de passe partagé : chacun entre avec son adresse
e-mail. Deux rôles :

- **Propriétaire** — tout : finances, forfaits, sponsors, fichiers du portail,
  script agent, remise à zéro, sauvegardes, comptes.
- **Vendeur** — voir les clients connectés, générer et imprimer des codes.
  Ni caisse, ni réglages, ni suppression. Les pages qui ne le concernent pas
  ne lui sont même pas proposées dans le menu.

**Première mise en route.** Tant qu'aucun compte n'existe, `ADMIN_PASSWORD`
ouvre le dashboard et mène directement à la page Comptes, pour créer le
premier propriétaire. **Dès qu'un compte actif existe, ce mot de passe cesse
de fonctionner** — le laisser vivre en ferait une porte dérobée permanente.

**Si vous perdez le mot de passe du dernier propriétaire**, la seule reprise
passe par la base : supprimez la ligne dans `users` (console Neon), et
`ADMIN_PASSWORD` redevient utilisable le temps de recréer un compte.

Le dashboard refuse de rétrograder, désactiver ou supprimer le **dernier
propriétaire actif** : sans cela, un clic suffirait à fermer la porte à tout
le monde.

Les mots de passe ne sont pas stockés : seule une empreinte scrypt l'est, avec
un sel propre à chaque compte. Changer son mot de passe ferme ses autres
sessions.
