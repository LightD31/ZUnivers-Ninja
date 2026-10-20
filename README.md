<div align="center">
<img alt="logo" src="https://repository-images.githubusercontent.com/420819440/51db7016-b325-4d1b-a1d3-ce82d771f58b" height="240px">

# ZUnivers Ninja

**Ton prochain coup ZUnivers, calculé pour toi.**

Entre un pseudo Discord : ZUnivers Ninja analyse la collection et donne la meilleure suite de
commandes à taper aujourd'hui. L'outil existe en interface web et en conseils automatiques sur Discord.

</div>

> Projet communautaire, non affilié à ZUnivers. Basé sur le ZUnivers Ninja original d'[AlexPresso](https://github.com/AlexPresso/ZUnivers-Ninja).

## Ce que fait la v2

La v2 est une réécriture complète : TypeScript, aucune base de données, une seule image Docker.

- **Planificateur par recherche en faisceau.** Il simule des milliers d'enchaînements d'actions et
  garde celui qui maximise les points de collection. La v1 appliquait une liste de règles fixes.
- **Toutes les mécaniques du jeu**, d'après le [guide officiel](https://zunivers.zerator.com/guide) :
  - `/journa` et `/bonus`, avec les bonus de corporation et d'abonnement ;
  - recyclage du surplus réel, sans jamais toucher à une carte encore utile ;
  - création et enchantement, en tenant compte du groupe d'Ascension en cours ;
  - fusions, y compris quand il faut d'abord créer un composant manquant ;
  - constellations et carte Évolution ;
  - invocations et ascensions, estimées en espérance à partir des vrais taux de drop ;
  - défis de la semaine ;
  - mode Hardcore : aucun conseil quand aucune saison n'est en cours ;
  - succès : collections (toutes les cartes d'une rareté, d'un pack, toutes les constellations…)
    et compteurs (recyclages, fusions, défis terminés, ascension du Vortex en cours).
- **Interface web** :
  - le plan pas à pas, avec la commande prête à copier et les visuels des cartes ;
  - l'évolution des monnaies et de la collection, les défis, les succès et l'état du Vortex ;
  - les fusions à compléter et les cartes manquantes les plus rentables ;
  - le choix de la stratégie sous la recherche, et des réglages avancés du planificateur.
- **Stratégies** selon ta façon de jouer : Équilibré, Prudent, Épargne, Vortex ou Collectionneur
  (voir [Stratégies](#stratégies)). Sous la recherche, choisis aussi le nombre de doublons gardés
  pour l'échange, si les cartes à enchanter pour les constellations et fusions dorées sont gardées,
  et les actions que tu ne veux pas faire (le recyclage, par exemple) : le plan est alors calculé
  sans elles, avec les monnaies que tu as déjà.
- **Anticipation** (option expérimentale, désactivée par défaut) : le plan tient compte du prochain
  Vortex (son groupe est prévu d'après ton historique), des essais d'ascension encore à venir et des
  évènements déjà annoncés. Une monnaie qui rapportera plus plus tard est gardée, et les conseils
  disent pour quoi (voir [Anticipation](#anticipation-option-horizon)).
- **Notifications Discord** : le plan n'est envoyé que s'il a changé depuis le dernier envoi. Un
  webhook JSON générique est aussi disponible pour tes propres intégrations.
- **Robustesse** :
  - chaque réponse de l'API est validée, et un changement de format donne une erreur claire ;
  - chaque plan est rejoué et vérifié avant d'être proposé ;
  - plus de 60 tests tournent sur un instantané réel de l'API.

## Démarrage rapide (Docker)

```bash
curl -O https://raw.githubusercontent.com/LightD31/ZUnivers-Ninja/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/LightD31/ZUnivers-Ninja/main/.env.example
# Édite .env : au minimum ZU_USERS (et WEBHOOK_URL pour Discord)
docker compose up -d
```

L'interface est ensuite disponible sur <http://localhost:8080>. Un seul conteneur sert l'interface
et l'API, et tourne le planificateur automatique. L'état (dernier plan notifié) est stocké dans
`./data`.

Pour construire l'image toi-même : `docker compose up -d --build`. Si Docker Hub te limite,
utilise un miroir :
`docker build --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-alpine .`

### Configuration

Toutes les variables sont facultatives, et documentées dans [`.env.example`](.env.example).

| Variable                     | Défaut         | Rôle                                                                                                                                                                               |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZU_USERS`                   | —              | Pseudos Discord à conseiller automatiquement, séparés par des virgules. Vide = interface web seule. Ajoute `:stratégie` pour choisir celle d'un joueur (ex : `alice:prudent,bob`). |
| `RULESET`                    | `NORMAL`       | Mode de jeu : `NORMAL` ou `HARDCORE`.                                                                                                                                              |
| `STRATEGY`                   | `equilibre`    | Stratégie par défaut (voir [Stratégies](#stratégies)).                                                                                                                             |
| `CRON`                       | `*/30 * * * *` | Fréquence des conseils automatiques.                                                                                                                                               |
| `TZ`                         | `Europe/Paris` | Fuseau du cron.                                                                                                                                                                    |
| `WEBHOOK_URL`                | —              | Webhook Discord où envoyer les conseils.                                                                                                                                           |
| `DISCORD_MENTION`            | `false`        | Mentionne le joueur dans le message.                                                                                                                                               |
| `JSON_WEBHOOK_URL`           | —              | Reçoit le plan complet en JSON (remplace l'ancien système de plugins).                                                                                                             |
| `WEB_URL`                    | —              | URL publique de l'interface, utilisée pour les liens dans Discord.                                                                                                                 |
| `BEAM_WIDTH` / `BRANCHING`   | `8` / `4`      | Effort de recherche du planificateur.                                                                                                                                              |
| `PLANNER_THREADS`            | `2`            | Threads de calcul : nombre de plans calculés en parallèle.                                                                                                                         |
| `PLANNER_QUEUE_LIMIT`        | `4`            | Calculs en attente au-delà desquels l'API répond `503`.                                                                                                                            |
| `PLANNER_TIME_LIMIT_SECONDS` | `20`           | Temps de recherche maximal par plan, ensuite la fin du plan est calculée en glouton (`0` = illimité).                                                                              |
| `KEEP_EXTRA`                 | `0`            | Exemplaires gardés en plus pour les échanges.                                                                                                                                      |
| `KEEP_FOR_GOLDEN`            | `true`         | Garde les exemplaires normaux à enchanter pour la constellation dorée, même si elle n'est pas rentable aujourd'hui. `false` : seuls ceux que le plan du jour enchante sont gardés. |
| `KEEP_FOR_GOLDEN_FUSIONS`    | `true`         | Garde aussi les exemplaires normaux à enchanter pour les fusions dorées encore à faire (les 100 pièces du puzzle doré, par exemple).                                               |
| `HORIZON`                    | `false`        | Anticipe les prochains Vortex et les essais d'ascension à venir (voir [Anticipation](#anticipation-option-horizon)).                                                               |
| `HORIZON_DISCOUNT`           | `0.9`          | Anticipation : ce que vaut un gain une saison de Vortex plus tard, face au même gain aujourd'hui (de `0` à `1`).                                                                   |
| `HORIZON_SEASONS`            | `4`            | Anticipation : saisons de Vortex à venir examinées (de `1` à `8`, `4` = une rotation complète des groupes).                                                                        |
| `SKIP_ACTIONS`               | —              | Actions que le plan ne propose jamais, séparées par des virgules (ex : `recycle,invoke` ; liste dans [API](#api)).                                                                 |
| `DRY_RUN`                    | `false`        | Calcule sans rien envoyer.                                                                                                                                                         |
| `PORT`                       | `8080`         | Port HTTP.                                                                                                                                                                         |
| `METRICS`                    | `true`         | Expose les métriques Prometheus sur `/metrics` (voir [Statistiques d'usage](#statistiques-dusage-prometheus--grafana)).                                                            |
| `METRICS_TOKEN`              | —              | Jeton exigé sur `/metrics` (`Authorization: Bearer …`).                                                                                                                            |

### API

- `GET /api/plan/:pseudo` renvoie le plan complet en JSON. Paramètres facultatifs :
  - `ruleset` ;
  - `strategy` (`equilibre`, `prudent`, `epargne`, `vortex` ou `collectionneur`) ;
  - `beamWidth`, `branching` et `keepExtra` ;
  - `keepForGolden` et `keepForGoldenFusions` (`1` ou `0`) ;
  - `horizon` (`1` ou `0`) pour l'anticipation, et ses réglages `horizonDiscount` et
    `horizonSeasons` ;
  - `skip`, les actions refusées séparées par des virgules (`recycle`, `craft`, `enchant`,
    `fusion`, `constellation`, `invoke`, `ascension`, `evolution`). Présent même vide, il remplace
    `SKIP_ACTIONS` : `skip=` les autorise toutes ;
  - `wBalance`, `wLoreDust`, `wLoreFragment` et `wUpgradeDust` ;
  - `fresh=1` pour ignorer le cache.
- `GET /api/strategies` liste les stratégies disponibles (`strategies` : `id`, `label`,
  `description`) et celle par défaut du serveur (`strategy`). Un bot peut s'en servir pour proposer
  les mêmes choix que l'interface. `GET /api/config` les renvoie aussi.
- `GET /health` sert de healthcheck pour Docker et Kubernetes.
- `GET /api/plan/:pseudo/discord` renvoie une version compacte pour les bots Discord :
  - le message prêt à poster (`content` et `embeds`) ;
  - le plan en pièce jointe (`attachment`) quand il est trop long ;
  - `hash`, `empty` et `player.discordId`.

  Ajoute `?mention=1` pour mentionner le joueur.

Les deux routes renvoient un `ETag` (empreinte des commandes). Une requête avec `If-None-Match`
reçoit `304 Not Modified` tant que le plan n'a pas changé : un bot peut donc interroger souvent
sans rien recalculer de son côté.

Les calculs tournent dans des threads séparés : le serveur reste réactif pendant un calcul lourd.
Les requêtes identiques simultanées partagent le même calcul, et un client qui se déconnecte
l'annule. Quand tous les threads sont occupés et la file d'attente pleine, les deux routes
répondent `503` avec un en-tête `Retry-After`.

### Statistiques d'usage (Prometheus + Grafana)

`GET /metrics` expose des métriques au format Prometheus, sans cookie ni service tiers :

| Métrique                                          | Contenu                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `zuninja_plan_requests_total{source, outcome}`    | Demandes de plan : `source` = `web`, `bot` (route `/discord`) ou `cron` ; `outcome` = `ok`, `not_found`, `busy`, `timeout`… |
| `zuninja_players{window}`                         | Joueurs distincts (web et bots) sur `1d`, `7d` et `30d`.                                                                    |
| `zuninja_page_views_total`                        | Pages de l'interface ouvertes dans un navigateur (hors sondes, aperçus de liens et préchargements).                         |
| `zuninja_plans_computed_total{strategy, ruleset}` | Plans réellement calculés (hors cache).                                                                                     |
| `zuninja_plan_duration_seconds`                   | Durée d'un calcul, appels à l'API ZUnivers compris.                                                                         |
| `zuninja_planner_threads{state}`, `…queue_length` | Occupation des threads de calcul.                                                                                           |
| `zuninja_process_*`, `zuninja_nodejs_*`           | Métriques standard du processus (mémoire, CPU, boucle d'évènements).                                                        |

Les pseudos ne sont jamais exposés : pour compter les joueurs distincts, le serveur garde
seulement une empreinte salée de chaque pseudo et la date de sa dernière demande, pendant 30
jours, dans `data/metrics.json`. La version autonome (GitHub Pages) calcule dans le navigateur et
n'est pas comptée.

Exemple de configuration Prometheus :

```yaml
scrape_configs:
  - job_name: zunivers-ninja
    scrape_interval: 1m
    static_configs:
      - targets: ['zunivers-ninja:8080']
    # Si METRICS_TOKEN est défini :
    # authorization:
    #   credentials: ton-jeton
```

Un tableau de bord Grafana prêt à importer est fourni dans
[`deploy/grafana-dashboard.json`](deploy/grafana-dashboard.json) (Dashboards → New → Import) :
joueurs distincts, demandes par origine, pages vues, erreurs, durée des calculs, stratégies et
occupation du serveur.

### Brancher un bot Discord (ex : michel-discord-bot)

Le bot interroge Ninja et poste lui-même dans son salon. Dans ce cas, laisse `ZU_USERS` et
`WEBHOOK_URL` vides côté Ninja, pour éviter les doublons.

1. Mets les deux conteneurs sur le même réseau Docker. Le bot joint alors Ninja via
   `http://zunivers-ninja:8080`. Si ce sont deux projets compose distincts, crée un réseau
   externe :
   ```yaml
   # docker-compose.yml de Ninja et du bot
   networks:
     default:
       name: zunivers
       external: true # créé une fois avec : docker network create zunivers
   ```
2. Dans le bot, sur une tâche périodique et pour chaque pseudo suivi, renvoie le dernier `ETag`
   connu, puis poste le message s'il a changé :
   ```python
   headers = {"If-None-Match": last_etag} if last_etag else {}
   async with session.get(f"{NINJA_URL}/api/plan/{pseudo}/discord", headers=headers) as r:
       if r.status == 304:
           return  # plan inchangé
       r.raise_for_status()
       data, etag = await r.json(), r.headers["ETag"]
   if not data["empty"]:
       files = None
       if data["attachment"]:
           a = data["attachment"]
           files = [File(io.BytesIO(a["content"].encode()), file_name=a["name"])]
       await channel.send(
           content=data["content"],
           embeds=[Embed.from_dict(e) for e in data["embeds"]],
           files=files,
       )
   save_etag(pseudo, etag)  # à persister pour survivre aux redémarrages
   ```
   Une commande `/ninja pseudo:` peut appeler la même route sans `If-None-Match` pour afficher
   le plan à la demande.
3. Pour la stratégie, ajoute `?strategy=<id>` à la route. La liste à proposer au joueur vient de
   `GET /api/strategies`, ce qui évite de la recopier dans le bot.

## Stratégies

Une stratégie est un préréglage du planificateur. Choisis-la sous la recherche de l'interface, avec
`?strategy=` dans l'API ou dans le lien de l'interface (`/?u=pseudo&strategy=prudent`), ou par
joueur dans `ZU_USERS`.

| Stratégie      | `strategy`       | Pour qui                                        | Ce qui change                                                                         |
| -------------- | ---------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Équilibré      | `equilibre`      | Le plus de points, tirages compris (par défaut) | —                                                                                     |
| Prudent        | `prudent`        | Ne veut que des points garantis                 | Aucune invocation ni ascension, la ZUMonnaie est gardée                               |
| Épargne        | `epargne`        | Garde des monnaies pour un évènement ou un pack | Poudres × 15, ZUMonnaie × 50 : seules les grosses dépenses passent                    |
| Vortex         | `vortex`         | Veut monter dans la tour d'Ascension            | Réputation × 50, poudre × 5 : la poudre va aux `/as` avant les petites créations      |
| Collectionneur | `collectionneur` | Veut le plus de cartes différentes possible     | +1 000 points par carte de la collection : aucune carte perdue, les nouvelles d'abord |

Les réglages explicites l'emportent toujours sur la stratégie : avec
`?strategy=epargne&wBalance=0.002`, la ZUMonnaie garde sa valeur par défaut. Côté serveur,
`KEEP_EXTRA`, `KEEP_FOR_GOLDEN`, `KEEP_FOR_GOLDEN_FUSIONS`, `HORIZON` (et ses réglages), `SKIP_ACTIONS`, `BEAM_WIDTH`
et `BRANCHING` s'appliquent aussi par-dessus la stratégie.

## Comment fonctionne le planificateur

1. **Normalisation.** Les données de l'API (cartes, fusions, config de recyclage, évènements,
   Vortex, inventaire, défis…) sont converties en un modèle simple. Une carte Constellation est
   une ligne distincte de l'inventaire : elle ne compte jamais comme un exemplaire utilisable.
   L'API ne décrit un succès que par son texte : le planificateur en déduit les cartes visées, et
   ne garde le succès que si ces cartes redonnent exactement la progression affichée par l'API.
   Seuls les exemplaires comptent (une carte Constellation seule ne vaut pas possession). Les
   collections classiques comptent aussi des cartes absentes du catalogue public (les cartes de
   boss) : le succès n'est visé que si le joueur les possède déjà.
2. **Réserve.** Pour chaque carte, le planificateur calcule les exemplaires à protéger :
   - 1 exemplaire gardé ;
   - ceux nécessaires aux fusions encore à faire ;
   - les doublons qui serviront aux niveaux de constellation restants ;
   - un exemplaire à enchanter si la version dorée manque, puis ceux à enchanter pour la
     constellation dorée (case « Garder les normales à enchanter ») et pour les fusions dorées
     encore à faire (case « Garder les composants des fusions dorées »). Les deux cases sont
     cochées par défaut.

   Seul le surplus est recyclé.

3. **Actions sans regret**, appliquées automatiquement : récompenses quotidiennes, fusions possibles,
   constellations avec les doublons, recyclage du surplus.
4. **Recherche en faisceau** sur les dépenses (création, enchantement, fusion à compléter,
   invocation, ascension, évolution). À chaque étape, les meilleurs états sont étendus avec leurs
   actions les plus prometteuses. Un état vaut :
   `points de collection + points de succès + points espérés des tirages + Σ monnaies × poids`.
   Selon la stratégie, les points espérés ne comptent pas (Prudent) ou chaque carte de la collection
   rapporte un bonus (Collectionneur) : en perdre une le retire, et une carte espérée d'un tirage ne
   le rapporte que si elle manquait au début du plan.
   Une dépense peut être une chaîne d'actions jugée d'un bloc : créer une carte pour l'enchanter et
   monter sa constellation dorée, ou enchanter deux fois une carte pour sa première dorée et son
   premier niveau. Étape par étape, la première action rapporte trop peu pour être explorée, alors
   que la chaîne compte parmi les dépenses les plus rentables du jeu. De même, les quelques
   constellations qui manquent pour une évolution sont proposées avec elle, et la carte qui termine
   un succès compte ses points.
   Pour comparer les plans en cours, le faisceau compte aussi les monnaies restantes à leur valeur
   d'opportunité : ce que rapporte la dernière dépense qu'elles permettent quand on dépense en
   prenant toujours la plus rentable. Sans ça, une grosse dépense peu rentable (une fusion qui vide
   la poudre) éliminerait des plans qui utilisent mieux le même budget. Cette valeur est recalculée
   en chemin : les dépenses déjà faites changent ce que vaut la suite. Le plan final reste choisi
   sur la valeur ci-dessus, puis complété par les dépenses qui rapportent encore. Le plan glouton
   qui sert au calcul de la valeur d'opportunité est gardé s'il fait mieux.
   Un succès rapporte beaucoup de points d'un coup, ce qui peut aussi attirer tout le faisceau vers
   un mauvais plan : la recherche est donc faite avec et sans les succès, et le meilleur des deux
   plans est gardé. Tenir compte des succès ne donne ainsi jamais un plan moins bon.
   Passé `PLANNER_TIME_LIMIT_SECONDS`, la recherche continue en glouton depuis le meilleur état :
   le plan reste complet, et l'interface signale qu'il a été écourté.
5. **Validation.** Le plan retenu est rejoué depuis l'état de départ. Une action impossible ou une
   monnaie négative fait échouer le plan.

Les points suivent les règles du jeu :

- une carte vaut ses points selon sa brillance ;
- une constellation vaut les points de la carte × niveau × 2 ;
- chaque niveau d'Évolution vaut sa rareté.

Les invocations et les ascensions sont aléatoires. Leur valeur est donc une espérance, calculée à
partir des taux de drop officiels et des cartes qu'il te manque. Pour les ascensions, la réputation
gagnée compte aussi.

Pour les invocations, deux règles du jeu s'ajoutent :

- **Cartes mises en avant** : dans une invocation d'évènement, une carte d'une rareté mise en avant
  est forcément l'une des cartes de l'évènement. L'invocation vaut donc plus si elles te manquent.
- **Bienveillance** : après 209 cartes invoquées sans 4 ★, la 210ᵉ est une 4 ★. Le compteur du
  joueur (`invokeBeforePity`) est suivi en probabilité d'une invocation à l'autre. Les conseils
  indiquent combien de cartes restent avant la prochaine 4 ★ garantie.

Une carte forgée après des invocations ne compte pas deux fois : les invocations la comptaient déjà
comme nouvelle avec une certaine probabilité, et cette part de leur espérance redevient un doublon.
L'ordre des invocations et des créations ne change donc pas la valeur d'un plan.

### Anticipation (option `horizon`)

Le planificateur ne cherche que le plan du jour. Avec l'option `horizon` (case « Anticiper » sous
la recherche, `?horizon=1` dans l'API ou `HORIZON=true`), les monnaies gardées ne valent plus
seulement leur poids fixe, mais aussi ce qu'elles rapporteront plus tard :

- **cristaux** : les cartes d'évènement ne se forgent que pendant le Vortex de leur groupe. Le groupe
  des prochains Vortex est prévu d'après ton historique (ordre observé : Classique, Autres, ZLAN,
  ZEvent), et la forge de chacun est simulée avec ta collection ;
- **poudre** : les essais d'ascension encore à créditer d'ici la fin du Vortex (deux par midi).

Les évènements ne sont pas anticipés : l'API ne les annonce pas avant leur début.

Une dépense n'est faite aujourd'hui que si elle rapporte plus que ce que ses monnaies rapporteraient
plus tard, et seulement pour la part qui sera vraiment dépensée : au-delà, une monnaie retrouve son
poids. Un encadré « À garder pour plus tard », en tête du plan, dit ce qui est gardé et pour quoi ;
les conseils signalent les échéances proches (fin du Vortex et de sa forge, fin d'un évènement ou
des défis de la semaine). L'étude complète, avec ses
limites, est dans [`docs/planification-temporelle.md`](docs/planification-temporelle.md).

Deux réglages, dans le panneau « Réglages » de l'interface, l'API ou les variables d'environnement :

- **Valeur de l'avenir** (`horizonDiscount`, 0,9) : ce que vaut un gain une saison de Vortex plus
  tard, face au même gain aujourd'hui. Plus elle est haute, plus le plan attend ;
- **Saisons examinées** (`horizonSeasons`, 4) : prochains Vortex pris en compte. 4 couvre une
  rotation complète des groupes, 1 n'attend que le prochain Vortex.

## Développement

Prérequis : Node 22 et pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm dev          # API sur :8080 + interface Vite sur :5173 (rechargement à chaud)
pnpm test         # tests (vitest)
pnpm check        # types + lint + format + tests
pnpm build        # interface + serveur
ZU_USERS=alexpresso DRY_RUN=1 pnpm --filter @zuninja/worker once   # un passage en console
pnpm fixtures     # réenregistre l'instantané de l'API utilisé par les tests
```

**Publier une version** : chaque push sur `main` (une PR fusionnée, par exemple) publie l'image
`ghcr.io/lightd31/zunivers-ninja` une fois les vérifications passées, avec les tags `latest` et
`sha-<commit>`. La version affichée par `/health` est le commit court (ex : `cf3f33c`). Hors image,
elle vaut `dev`.

Avec Docker : `docker compose -f docker-compose.dev.yml up`.

```
packages/core   Moteur : client API (zod), modèle, règles du jeu, planificateur
apps/worker     Serveur Hono : API, interface statique, cron, notifications
apps/web        Interface React + Tailwind (mode serveur ou autonome)
```

L'interface peut aussi être compilée en **mode autonome**
(`pnpm --filter @zuninja/web build:standalone`). Le calcul se fait alors entièrement dans le
navigateur, sans serveur. C'est pratique pour GitHub Pages (workflow manuel `pages.yml`).

## Migration depuis la v1

- Neo4j n'est plus nécessaire : supprime le service `neo4j` et son volume.
- `DISCORD_TAGS` est toujours lu, mais préfère `ZU_USERS`. `WEBHOOK_URL` ne change pas.
- Les plugins Java sont remplacés par `JSON_WEBHOOK_URL`, qui reçoit le plan complet à chaque changement.
- L'ancienne route `GET /advices/{pseudo}` devient `GET /api/plan/{pseudo}`.
