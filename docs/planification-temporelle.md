# Planifier dans le temps : étude de faisabilité

> Étude d'octobre 2026. Elle a donné l'option `horizon` (« Anticiper » dans l'interface),
> expérimentale et désactivée par défaut.

## En bref

- Le planificateur ne cherche que **le plan du jour**. Les monnaies qu'il garde valent un poids fixe :
  il ne sait pas que le Vortex change dans trois jours, ni que des essais d'ascension arriveront
  jusqu'à la fin de la saison.
- L'API ne donne que **le présent** : la saison de Vortex en cours et les évènements en cours. Le
  reste se déduit :
  - les saisons durent 14 jours ;
  - les essais d'ascension et les récompenses quotidiennes suivent des règles fixes ;
  - le groupe des prochains Vortex suit un ordre régulier depuis un an.
- **Une recherche sur plusieurs jours n'en vaut pas la peine.** Ce qui manquait, c'est la valeur des
  monnaies gardées. Chaque période à venir est simulée une fois, et ce qu'y rapporteraient les
  monnaies devient leur **valeur de garde**. Le plan du jour ne dépense que si ça rapporte plus.
- **Résultat** : sur le joueur des tests, rien ne change, faute de cristaux. Avec 20 000 cristaux de
  plus, +13 % de points en 8 semaines ; avec 100 000, +51 %. C'est encore mieux quand la prévision du
  Vortex se trompe à chaque fois. Coût : une vingtaine de millisecondes par plan sur le joueur des
  tests.
- **Recommandation** : mesurer sur de vrais joueurs avec le script fourni (section 6), puis activer
  l'option par défaut si les gains se confirment.

## 1. Ce que le jeu permet de savoir de l'avenir

Vérifié sur l'API le 19/10/2026 :

| Information                       | Source                                                                   | Connue d'avance ?                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Fin du Vortex en cours            | `/public/tower/season` (`endDate`)                                       | Oui. 14 jours, du lundi au lundi : la fin est le premier jour de la saison suivante.                                                       |
| Groupe du prochain Vortex         | Rien dans l'API. Historique du joueur : `/public/tower/{pseudo}`         | Prévisible (voir ci-dessous).                                                                                                              |
| Essais d'ascension à venir        | Règle du jeu : deux par jour à midi, cumulables jusqu'à la fin du Vortex | Oui.                                                                                                                                       |
| Récompenses `/journa` et `/bonus` | `/app/settings`, corporation, abonnement                                 | Oui.                                                                                                                                       |
| Fin des défis de la semaine       | `/public/challenge/{pseudo}` (`endDate`)                                 | Oui. Les défis de la semaine suivante, non.                                                                                                |
| Prochain Vortex                   | `/public/tower/next` : la tour de la saison suivante                     | Oui, pour la saison suivante seulement (ajouté après cette étude).                                                                         |
| Évènements à venir                | `/public/event/current` : seulement ceux en cours                        | Non. `/public/event` ne donne que des noms ; `/upcoming`, `/next`, `/{nom}` : 404. Le site officiel n'utilise que `/public/event/current`. |

**Rotation des Vortex.** La saison en cours ouvre à la forge les packs de tout son groupe
(Classique, Autres, ZLAN, ZEvent). D'après l'historique des fixtures (saisons 0 à 111) et l'API
(saisons 118 et 119), les groupes tournent dans l'ordre **Classique → Autres → ZLAN → ZEvent**
depuis la saison 93 (13/10/2025) :

- 16 transitions sur 18 suivent cet ordre. Les deux autres ont eu lieu à l'arrivée de la tour
  ZLAN 2026 (saison 109) ;
- avant, l'ordre était presque aléatoire : 10 transitions sur 30 entre les saisons 60 et 92 ;
- la saison 118 (Manoir Nougaret, Classique) a bien été suivie de la 119 (TMCUP, Autres).

La prévision apprend donc l'ordre sur l'historique du joueur, plutôt que de le coder en dur. La
saison suivante n'est même plus une prévision : `/public/tower/next` annonce sa tour, et son groupe
est pris tel quel. Au-delà, c'est
une chaîne de Markov : le groupe suivant dépend du groupe en cours. Seules les paires de saisons
consécutives comptent, les plus récentes davantage, et l'ordre observé sert de point de départ.
Depuis la saison 118, elle donne Autres (100 %), puis ZLAN (99 %), puis ZEvent (83 %).

## 2. Les décisions qui dépendent du temps

| Décision                                          | Pourquoi                                                                                                                                                                                                                                                                  | Faisabilité                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Cristaux d'un Vortex à l'autre**                | Les cristaux ne paient que les cartes d'évènement, forgeables 2 semaines sur 8. Une ★ normale coûte 50 cristaux pour 1 point (0,02 point par cristal), une normale enchantée pour monter une constellation dorée ★ coûte 400 cristaux pour 120 points (0,30 par cristal). | Prévision du groupe.              |
| **Poudre pour les ascensions à venir**            | 20 poudres par `/as`. Les essais arrivent jusqu'à la fin du Vortex, avant midi ceux du jour ne sont pas encore crédités.                                                                                                                                                  | Déterministe.                     |
| **Échéances**                                     | Dernier jour pour forger les cartes du groupe, essais perdus, fin d'un évènement, fin des défis.                                                                                                                                                                          | Déterministe, simples conseils.   |
| Poudre pour les ascensions du **prochain** Vortex | Les essais ne se reportent pas d'une saison à l'autre, la poudre si.                                                                                                                                                                                                      | Écarté (voir section 8).          |
| Évènements à venir                                | Garder la ZUMonnaie pour un évènement dont les cartes mises en avant manquent.                                                                                                                                                                                            | Non : jamais annoncés à l'avance. |
| Défis de la semaine suivante                      | Leur type n'est connu qu'au lundi.                                                                                                                                                                                                                                        | Non.                              |

## 3. Pourquoi pas une recherche sur plusieurs jours

Ajouter une action « attendre » et une horloge à l'état multiplierait la profondeur de la recherche
par 14 à 56 (une à quatre saisons), avec autant de branches à chaque jour. Elle dépasserait la limite
de 20 secondes par plan. Et elle ne saurait rien de plus :

- les tirages ne sont que des espérances ;
- les évènements et les défis à venir sont inconnus ;
- le plan est recalculé toutes les 30 minutes : seul ce qui se joue aujourd'hui compte.

Ce qui manquait à la recherche du jour, c'est le prix des monnaies qu'elle ne dépense pas.

## 4. Conception retenue : horizon glissant

### 4.1 Calendrier (`packages/core/src/rules/calendar.ts`)

- `remainingAscensionCredits` : essais encore à créditer avant la fin du Vortex (deux par midi à venir).
- `lootUntil` : récompenses `/journa` et `/bonus` d'ici une date, bonus de corporation et
  d'abonnement compris.
- `forecastSeasons` : dates des prochaines saisons et probabilité de chaque groupe (section 1).
- `predictedSeason` : une saison prévue, pour simuler sa forge.

L'historique des Vortex (`Player.towerHistory`) et la fin des défis (`Challenge.end`) étaient déjà
dans les réponses de l'API : ils sont maintenant gardés à la normalisation.

### 4.2 Valeur de garde (`packages/core/src/engine/hold.ts`)

Pour chaque monnaie `c`, la valeur d'un solde `x` devient :

```
V_c(x) = w_c · x + F_c(x + r_c) − F_c(r_c)
```

- `w_c` est le poids habituel de la monnaie ;
- `F_c(y)` est ce que rapportent, au-delà de leur poids, les `y` premières unités dépensées plus
  tard, les dépenses les plus rentables d'abord. C'est une fonction concave par paliers ;
- `r_c` est le revenu certain d'ici là : il couvre d'abord les dépenses à venir, et les unités
  gardées aujourd'hui ne servent qu'au-delà.

Au-delà de tout ce qui sera dépensé plus tard, une unité ne vaut plus que son poids. Le plan ne garde
donc que ce qui servira : avec 550 cristaux et une dépense de 400 au prochain Vortex, les 150 autres
se dépensent aujourd'hui (test « ne garde que ce que le prochain Vortex dépensera »).

### 4.3 Les périodes à venir (`packages/core/src/engine/horizon.ts`)

Chaque période est simulée une fois, en glouton (la même `rollout` qui calcule déjà le prix
d'opportunité des monnaies), depuis l'état de départ du plan. Seules ses nouveautés sont proposées
(`Context.futureWindow`) :

- **Vortex d'un autre groupe** : les packs qu'il ouvre à la forge, avec les cristaux du joueur.
  - Chaque dépense vaut son gain par cristal × probabilité × rabais.
  - Le rabais est de 0,9 par saison d'attente (option `horizonDiscount`) : l'inventaire aura
    changé, et le groupe n'est qu'une prévision.
  - La probabilité est celle que le groupe revienne dans les 4 prochaines saisons (option
    `horizonSeasons`), saison par saison.
- **Essais d'ascension à venir** : chaque essai vaut ce que rapporte une ascension à l'étage où le
  joueur en sera, avec les mêmes termes que le candidat d'ascension de la recherche.

### 4.4 Dans la recherche

- `stateValue` ajoute la valeur de garde.
- `candidates()` retire à chaque dépense ce que ses monnaies auraient rapporté plus tard.

La recherche (faisceau, prix d'opportunité, fin en glouton, regroupement) reste la même et attend
d'elle-même. Sans l'option, rien ne change : même plan, au caractère près (test « ne change rien sans
l'option »).

### 4.5 Ce que voit le joueur

- **En tête du plan**, un encadré « À garder pour plus tard » : une ligne par monnaie gardée, par
  exemple « 400 Cristaux · Vortex « ZLAN » du 19/10 (prévu) · ~+104 pts » ou « 100 Poudre · 14
  essais d'ascension d'ici le 18/10 ». Le même libellé (`reserveLabel`) sert sur Discord et en
  console. Un plan vide parce qu'il garde tout le dit, au lieu de « Rien à faire ».
- **Conseils** : les échéances proches. Ce sont le dernier jour du Vortex et de sa forge (avec la
  prochaine ouverture prévue du groupe), les essais perdus ce soir, la fin d'un évènement et les
  défis pas terminés.
- **Interface** : la case « Anticiper » sous la stratégie, ses réglages dans le panneau
  « Réglages », et les prochains Vortex prévus dans l'encadré Vortex.
- **Discord** : un champ « À garder ».
- **API** : `?horizon=1` ; `HORIZON=true` côté serveur. Le plan JSON contient `horizon` (saisons
  prévues, monnaies gardées) et `stats.horizon` (périodes simulées, écartées, temps).

## 5. Heuristiques : ne pas explorer de branches inutiles

Les « branches » de l'avenir sont les périodes à venir. Chacune n'est simulée que si elle peut
changer le plan du jour :

1. **Seulement ce qui est nouveau.** Le Vortex du groupe en cours, ou un Vortex Classique, n'ouvre
   rien qui ne soit déjà forgeable. Les essais d'ascension ne sont pas simulés une fois le sommet
   atteint.
2. **Seulement si la monnaie le permet.** Il faut assez de cristaux pour la moindre création ou
   enchantement de la période. La période est aussi écartée si le joueur a refusé l'action
   (`allow`), si la stratégie ne compte pas les tirages (Prudent), ou si le mode de jeu est fermé.
3. **Seulement si c'est probable.** Une période dont le poids (probabilité × rabais) est sous 5 %
   est écartée, comme un groupe qui ne suit pas la rotation.
4. **Une seule simulation par groupe**, quelle que soit la saison où il revient. Elle s'arrête quand
   le stock du joueur est épuisé, et au plus après 120 dépenses.
5. **Un budget** : 15 % de la limite de temps du plan. Au-delà, les périodes restantes sont écartées
   et les monnaies gardent leur poids.
6. **Dans la recherche du jour**, la valeur de garde élimine d'emblée les dépenses que l'avenir bat :
   elles ne prennent plus de place dans le faisceau.

Sur le joueur des tests, l'anticipation simule 4 périodes en environ 25 ms, sur environ 300 ms pour
tout le plan.

## 6. Mesures

### Tests (`packages/core/test/horizon.test.ts`, `calendar.test.ts`)

| Cas                                                                      | Sans anticipation            | Avec                                        |
| ------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------- |
| Vortex Autres, 400 cristaux, constellation dorée possible au Vortex ZLAN | 3 créations ★ (150 cristaux) | Garde les 400 cristaux                      |
| Même cas avec 550 cristaux                                               | 3 créations                  | 3 créations, garde 400                      |
| Vortex ZLAN en cours                                                     | Constellation dorée          | Constellation dorée (aujourd'hui)           |
| 100 poudres, 14 essais d'ascension à venir                               | 2 créations ★                | Garde les 100 poudres                       |
| Joueur des tests                                                         | —                            | Même plan, prévision Autres → ZLAN → ZEvent |

### Simulation sur 8 semaines

Le script `packages/core/scripts/horizon-eval.ts` joue un plan par jour, à 14 h, et l'applique :
cartes, monnaies, Vortex. Les Vortex suivants sont ceux que prévoit `forecastSeasons`. Les tirages
comptent pour leur espérance. Joueur des tests, du 11/10/2026 au 05/12/2026 (Classique, Autres,
ZLAN, ZEvent, Classique) :

| Cristaux en plus                     | Points sûrs sans | Points sûrs avec | Écart          | Temps de calcul en plus (56 plans) |
| ------------------------------------ | ---------------: | ---------------: | -------------- | ---------------------------------: |
| 0 (53 cristaux)                      |            1 330 |            1 330 | =              |                              0,2 s |
| 5 000                                |            2 074 |            2 074 | =              |                              0,5 s |
| 20 000                               |            3 795 |            4 306 | +511 (+13 %)   |                              1,3 s |
| 100 000                              |            9 229 |           13 930 | +4 701 (+51 %) |                              3,8 s |
| 20 000, Vortex dans l'ordre inverse  |            4 233 |            4 268 | +35 (+1 %)     |                              0,9 s |
| 100 000, Vortex dans l'ordre inverse |           11 039 |           13 156 | +2 117 (+19 %) |                              2,1 s |

- Sans anticipation, tous les cristaux partent au premier Vortex d'évènement (Autres), dans des
  cartes à 0,02 point par cristal. Il n'en reste plus pour les constellations dorées des Vortex ZLAN
  et ZEvent.
- Sur 16 semaines, l'écart reste le même qu'à 8 semaines (+511 avec 20 000 cristaux) : une dépense
  gaspillée ne se rattrape pas.
- Même quand la prévision se trompe à chaque fois (« ordre inverse »), l'anticipation fait mieux :
  garder pour « un autre groupe » reste juste, seul le moment change.
- La poudre pour les ascensions ne change rien pour ce joueur, avec ou sans 2 000 poudres en plus,
  en Équilibré comme en Vortex : elle ne lui manque pas. Les invocations (`--draws`) ne changent pas
  ces écarts.

Ces mesures ne portent que sur un joueur, peu riche. Pour mesurer sur de vrais joueurs :

```bash
pnpm tsx packages/core/scripts/horizon-eval.ts --weeks 8 pseudo1 pseudo2 …
pnpm tsx packages/core/scripts/horizon-eval.ts --strategy vortex --give loreDust=2000
pnpm tsx packages/core/scripts/horizon-eval.ts --truth reverse --give loreFragment=20000
```

## 7. Limites et risques

- **La rotation est une observation, pas une règle de l'API.** Un changement d'ordre se rattrape en
  quelques saisons (les transitions récentes comptent davantage). Une prévision fausse coûte peu :
  les cristaux restent utilisables au Vortex suivant de leur groupe.
- **Historique troué** : un joueur qui a manqué des saisons a moins de paires consécutives, et l'ordre
  observé compte davantage. Le choix de la tour dans le groupe (celle qui n'est pas revenue depuis le
  plus longtemps) peut alors se tromper. C'est sans effet sur la forge, qui ouvre tout le groupe.
- **La simulation part de l'inventaire d'aujourd'hui.** Les cartes obtenues d'ici là n'y sont pas, et
  les tirages ne sont que des espérances. Le plan, recalculé chaque jour, corrige au fil de l'eau.
- **Revenu sous-estimé** : seules les récompenses quotidiennes comptent, pas les recyclages ni les
  défis. Le plan garde donc un peu trop plutôt que pas assez.
- **Ascensions** : chaque essai est estimé sur la probabilité de chaque étage (`State.tower`), sommet
  compris. Les 4 cristaux d'un échec comptent dans sa valeur, pas dans son prix.
- **Évènements** : l'API ne les annonce jamais avant leur début. Leur anticipation (option
  `horizonEventDays`) a donc été retirée : elle ne se déclenchait jamais.
- **Fin de saison** : `ascensionCredits` (avant cette étude) compte encore le jour de fin comme dans
  la saison. C'est sans effet, l'API passant à la saison suivante ce jour-là.

## 8. Suite possible

1. Mesurer sur de vrais joueurs (section 6), puis activer l'option par défaut.
2. Afficher les conseils d'échéance même sans l'option : ils ne changent pas le plan.
3. Poudre pour les ascensions du prochain Vortex : il faudrait garder les étages de chaque tour dans
   le catalogue, et le gain semble faible en Équilibré.
4. Bienveillance : faire tomber la 4 ★ garantie pendant un évènement dont les cartes mises en avant
   manquent.
5. Réserve manuelle (« garder 5 000 ZUMonnaie pour un évènement »), puisque l'API n'annonce pas les
   évènements.
6. Garder côté serveur la trace des évènements vus, pour apprendre ceux qui reviennent.
7. Hardcore : vérifier si les monnaies perdent leur valeur à la fin d'une saison. Si oui, la valeur de
   garde devrait tomber à zéro à l'approche de la fin.
