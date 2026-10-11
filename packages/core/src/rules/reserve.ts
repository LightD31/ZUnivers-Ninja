import type { Context } from '../engine/context';
import { isEnchantable } from '../engine/context';
import { getCard, type State } from '../engine/state';
import type { Shiny } from '../model/types';

export interface Reserve {
  /** Exemplaire conservé (+ exemplaires gardés pour les échanges). */
  keep: number;
  /** Exemplaires nécessaires aux fusions dont le résultat manque encore. */
  fusion: number;
  /** Exemplaire normal gardé pour l'enchanter si la version dorée manque. */
  enchant: number;
  /** Doublons nécessaires pour monter la constellation au maximum. */
  constellation: number;
}

/**
 * Exemplaires d'une carte à protéger. Tout ce qui dépasse est un vrai surplus, recyclable sans
 * regret. Corrige l'ancien comportement qui recyclait des cartes encore utiles.
 */
export function reserveFor(ctx: Context, state: State, itemId: string, shiny: Shiny): Reserve {
  const item = ctx.items[itemId];
  const reserve: Reserve = {
    keep: 1 + ctx.options.keepExtra,
    fusion: 0,
    enchant: 0,
    constellation: 0,
  };
  if (!item) return { ...reserve, keep: Number.POSITIVE_INFINITY };

  for (const fusion of ctx.fusionsByInput.get(itemId) ?? []) {
    const result = ctx.items[fusion.resultId];
    if (!result?.shinyAvailable[shiny]) continue;
    if (getCard(state, fusion.resultId, shiny).copies > 0) continue;
    for (const input of fusion.inputs)
      if (input.itemId === itemId) reserve.fusion += input.quantity;
  }

  if (shiny === 0 && isEnchantable(ctx, item) && getCard(state, itemId, 1).copies === 0)
    reserve.enchant = 1;

  if (item.upgradable && shiny <= 1 && item.shinyAvailable[shiny]) {
    reserve.constellation = Math.max(0, item.rarity - getCard(state, itemId, shiny).constellation);
  }
  return reserve;
}

export const reserveTotal = (r: Reserve) => r.keep + r.fusion + r.enchant + r.constellation;

/**
 * Exemplaires qu'une constellation ne doit pas consommer. L'exemplaire gardé pour l'enchantement
 * n'en fait pas partie : la constellation est gratuite, l'enchantement coûte de la poudre.
 */
export const reserveBeforeConstellation = (r: Reserve) => r.keep + r.fusion;
