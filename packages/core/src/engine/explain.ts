import type { Shiny } from '../model/types';
import {
  proposeTrade,
  tradeCommand,
  tradeIssues,
  type TradeCard,
  type TradeIssue,
  type TradeKeptFor,
  type TradeNeed,
  type TradePicks,
  type TradeProposal,
  type TradeResult,
  type TradeSide,
} from './trade';

/** Ce que coûte un exemplaire cédé : rien (`spare`, du surplus), ou ce pour quoi le donneur le garde. */
export type TradeCost = 'spare' | TradeKeptFor;

/** Des exemplaires d'une carte échangée qui ont le même usage : leur nombre et leurs points. */
export interface WorthPart<K extends string> {
  kind: K;
  copies: number;
  points: number;
}

/** Une carte de l'échange, et ce qu'elle vaut pour chacun des deux joueurs. */
export interface CardWorth {
  /** La carte, `count` étant le nombre d'exemplaires échangés. */
  card: TradeCard;
  /** Pour celui qui la reçoit : ce que chaque exemplaire lui apporte, et les points gagnés. */
  receiver: { parts: WorthPart<TradeNeed>[]; points: number; fusions: string[]; wanted: boolean };
  /** Pour celui qui la cède : ce que chaque exemplaire lui coûte, et les points perdus. */
  giver: { parts: WorthPart<TradeCost>[]; points: number; fusions: string[]; offered: boolean };
}

function group<K extends string>(copies: readonly { kind: K; points: number }[]): WorthPart<K>[] {
  const parts: WorthPart<K>[] = [];
  for (const { kind, points } of copies) {
    const last = parts.at(-1);
    if (last?.kind === kind) {
      last.copies++;
      last.points += points;
    } else parts.push({ kind, copies: 1, points });
  }
  return parts;
}

const total = (parts: readonly WorthPart<string>[]) => parts.reduce((t, p) => t + p.points, 0);

/**
 * Ce que valent les exemplaires échangés d'une carte (`card.count`), pour chacun des deux joueurs.
 * Le receveur les utilise dans l'ordre de son plan (`uses`) ; le donneur cède d'abord son surplus,
 * puis ce qu'il garde, du moins utile au plus utile (`held`).
 */
export function cardWorth(card: TradeCard): CardWorth {
  const received = Array.from({ length: card.count }, (_, i) => ({
    kind: card.uses[i] ?? ('none' as TradeNeed),
    points: card.gains[i] ?? 0,
  }));
  const given: { kind: TradeCost; points: number }[] = Array.from(
    { length: Math.min(card.count, card.spare) },
    () => ({ kind: 'spare', points: 0 }),
  );
  for (const held of card.held)
    for (let i = 0; i < held.copies && given.length < card.count; i++)
      given.push({ kind: held.kind, points: held.points });
  const receiver = group(received);
  const giver = group(given);
  return {
    card,
    receiver: {
      parts: receiver,
      points: total(receiver),
      fusions: card.fusions.receiver,
      wanted: card.wanted,
    },
    giver: {
      parts: giver,
      points: total(giver),
      fusions: card.fusions.giver,
      offered: card.offered,
    },
  };
}

export interface ExplainedSide {
  player: TradeSide['player'];
  /** Le joueur a une annonce sur le marché. */
  market: boolean;
  /** Cartes qu'il cède, et ce qu'elles valent pour chacun. */
  gives: CardWorth[];
  /** Points de collection gagnés avec les cartes reçues. */
  gain: number;
  /** Points de collection perdus avec les cartes cédées. */
  loss: number;
  /** Exemplaires reçus qui lui servent sans rapporter de points tout de suite (fusion, dorée). */
  indirect: number;
}

export interface TradeExplanation {
  /** Les deux joueurs, dans l'ordre de l'échange comparé (`me`, puis `other`). */
  sides: [ExplainedSide, ExplainedSide];
  /** Les cartes par rareté et brillance : le jeu exige autant d'exemplaires des deux côtés. */
  categories: { rarity: number; shiny: Shiny; gives: [CardWorth[], CardWorth[]] }[];
  /** Ce que le jeu refuserait, côté `give` pour le premier joueur, `receive` pour le second. */
  issues: TradeIssue[];
  /** Commande `/échange` de chacun, s'il lance l'échange. */
  commands: [string, string];
}

/**
 * L'échange vu des deux côtés à la fois, sans préférer aucun des joueurs : pour chaque carte, ce
 * qu'elle apporte à celui qui la reçoit et ce qu'elle coûte à celui qui la cède. `gives` : les
 * cartes que cède chacun, avec leurs exemplaires (clés de `trade.me`, puis de `trade.other`). Rien
 * n'est ajouté pour équilibrer : une carte sans contrepartie est signalée dans `issues`.
 */
export function explainTrade(
  trade: Pick<TradeResult, 'me' | 'other'>,
  gives: [TradePicks, TradePicks],
): TradeExplanation {
  const proposal = proposeTrade(trade, { give: gives[0], receive: gives[1] }, { balance: false });
  const worth: [CardWorth[], CardWorth[]] = [
    proposal.give.map(cardWorth),
    proposal.receive.map(cardWorth),
  ];
  const side = (i: 0 | 1): ExplainedSide => {
    const received = worth[i === 0 ? 1 : 0];
    return {
      player: (i === 0 ? trade.me : trade.other).player,
      market: (i === 0 ? trade.me : trade.other).market,
      gives: worth[i],
      gain: received.reduce((t, w) => t + w.receiver.points, 0),
      loss: worth[i].reduce((t, w) => t + w.giver.points, 0),
      indirect: received
        .flatMap((w) => w.receiver.parts)
        .filter((p) => p.kind === 'fusion' || p.kind === 'enchant')
        .reduce((t, p) => t + p.copies, 0),
    };
  };

  const categories = new Map<string, TradeExplanation['categories'][number]>();
  worth.forEach((cards, i) => {
    for (const w of cards) {
      const key = `${w.card.rarity}:${w.card.shiny}`;
      let category = categories.get(key);
      if (!category)
        categories.set(
          key,
          (category = { rarity: w.card.rarity, shiny: w.card.shiny, gives: [[], []] }),
        );
      category.gives[i]!.push(w);
    }
  });

  const swapped: TradeProposal = { ...proposal, give: proposal.receive, receive: proposal.give };
  return {
    sides: [side(0), side(1)],
    categories: [...categories.values()].sort((a, b) => b.rarity - a.rarity || b.shiny - a.shiny),
    issues: tradeIssues(proposal),
    commands: [
      tradeCommand(trade.other.player.name, proposal),
      tradeCommand(trade.me.player.name, swapped),
    ],
  };
}
