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
  - défis de la semaine.
- **Interface web** :
  - le plan pas à pas, avec la commande prête à copier et les visuels des cartes ;
  - l'évolution des monnaies et de la collection, les défis et l'état du Vortex ;
  - les fusions à compléter et les cartes manquantes les plus rentables ;
  - des réglages du planificateur ajustables.
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

| Variable                   | Défaut         | Rôle                                                                                                |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `ZU_USERS`                 | —              | Pseudos Discord à conseiller automatiquement, séparés par des virgules. Vide = interface web seule. |
| `RULESET`                  | `NORMAL`       | Mode de jeu : `NORMAL` ou `HARDCORE`.                                                               |
| `CRON`                     | `*/30 * * * *` | Fréquence des conseils automatiques.                                                                |
| `TZ`                       | `Europe/Paris` | Fuseau du cron.                                                                                     |
| `WEBHOOK_URL`              | —              | Webhook Discord où envoyer les conseils.                                                            |
| `DISCORD_MENTION`          | `false`        | Mentionne le joueur dans le message.                                                                |
| `JSON_WEBHOOK_URL`         | —              | Reçoit le plan complet en JSON (remplace l'ancien système de plugins).                              |
| `WEB_URL`                  | —              | URL publique de l'interface, utilisée pour les liens dans Discord.                                  |
| `BEAM_WIDTH` / `BRANCHING` | `16` / `6`     | Effort de recherche du planificateur.                                                               |
| `KEEP_EXTRA`               | `0`            | Exemplaires gardés en plus pour les échanges.                                                       |
| `DRY_RUN`                  | `false`        | Calcule sans rien envoyer.                                                                          |
| `PORT`                     | `8080`         | Port HTTP.                                                                                          |

### API

- `GET /api/plan/:pseudo` renvoie le plan complet en JSON. Paramètres facultatifs :
  - `ruleset` ;
  - `beamWidth`, `branching` et `keepExtra` ;
  - `wBalance`, `wLoreDust`, `wLoreFragment` et `wUpgradeDust` ;
  - `fresh=1` pour ignorer le cache.
- `GET /health` sert de healthcheck pour Docker et Kubernetes.
- `GET /api/plan/:pseudo/discord` renvoie une version compacte pour les bots Discord :
  - le message prêt à poster (`content` et `embeds`) ;
  - le plan en pièce jointe (`attachment`) quand il est trop long ;
  - `hash`, `empty` et `player.discordId`.

  Ajoute `?mention=1` pour mentionner le joueur.

Les deux routes renvoient un `ETag` (empreinte des commandes). Une requête avec `If-None-Match`
reçoit `304 Not Modified` tant que le plan n'a pas changé : un bot peut donc interroger souvent
sans rien recalculer de son côté.

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

## Comment fonctionne le planificateur

1. **Normalisation.** Les données de l'API (cartes, fusions, config de recyclage, évènements,
   Vortex, inventaire, défis…) sont converties en un modèle simple. Une carte Constellation est
   une ligne distincte de l'inventaire : elle ne compte jamais comme un exemplaire utilisable.
2. **Réserve.** Pour chaque carte, le planificateur calcule les exemplaires à protéger :
   - 1 exemplaire gardé ;
   - ceux nécessaires aux fusions encore à faire ;
   - les doublons qui serviront aux niveaux de constellation restants ;
   - un exemplaire à enchanter si la version dorée manque.

   Seul le surplus est recyclé.

3. **Actions sans regret**, appliquées automatiquement : récompenses quotidiennes, fusions possibles,
   constellations avec les doublons, recyclage du surplus.
4. **Recherche en faisceau** sur les dépenses (création, enchantement, fusion à compléter,
   invocation, ascension, évolution). À chaque étape, les meilleurs états sont étendus avec leurs
   actions les plus prometteuses. Un état vaut :
   `points de collection + points espérés des tirages + Σ monnaies × poids`.
5. **Validation.** Le plan retenu est rejoué depuis l'état de départ. Une action impossible ou une
   monnaie négative fait échouer le plan.

Les points suivent les règles du jeu :

- une carte vaut ses points selon sa brillance ;
- une constellation vaut les points de la carte × niveau × 2 ;
- chaque niveau d'Évolution vaut sa rareté.

Les invocations et les ascensions sont aléatoires. Leur valeur est donc une espérance, calculée à
partir des taux de drop officiels et des cartes qu'il te manque. Pour les ascensions, la réputation
gagnée compte aussi.

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
