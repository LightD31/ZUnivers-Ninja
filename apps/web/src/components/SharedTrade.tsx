import {
  DEFAULT_TRADE_KEEP,
  explainTrade,
  TRADE_MAX_CARDS,
  type CardWorth,
  type ExplainedSide,
  type TradeCost,
  type TradeExplanation,
  type TradeIssue,
  type TradeNeed,
  type TradeResult,
  type WorthPart,
} from '@zuninja/core';
import {
  ArrowLeftRight,
  CircleAlert,
  CircleCheck,
  Heart,
  RefreshCw,
  Scale,
  SquareTerminal,
  Tag,
  UserRound,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchTrade, PlanError } from '../lib/api';
import { RARITY_LABEL, RARITY_TINT, SHINY_NAME } from '../lib/game';
import {
  linkUrl,
  picksFromLink,
  sharedTradeUrl,
  sideView,
  tradeCards,
  type LinkedCard,
  type SharedTradeLink,
} from '../lib/share';
import { CardThumb } from './CardChip';
import { CopyButton } from './CopyButton';
import { PlayerAvatar } from './Trade';

const SHINY_SUFFIX = ['', '+', '*'];
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
const quote = (names: string[]) => names.map((n) => `« ${n} »`).join(', ');
/** Points avec leur signe : `+5 pts`, `−1 pt`, `0 pt`. */
const signedPoints = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${plural(Math.abs(n), 'pt')}`;

/** Ce que des exemplaires apportent à celui qui les reçoit. */
function receiverText({ kind, copies }: WorthPart<TradeNeed>, fusions: string[]): string {
  switch (kind) {
    case 'missing':
      return 'lui manque';
    case 'constellation':
      return copies > 1 ? `${copies} niveaux de constellation` : 'un niveau de constellation';
    case 'fusion': {
      const what = copies > 1 ? `${copies} composants` : 'un composant';
      return fusions.length > 0 ? `${what} de sa fusion ${quote(fusions)}` : `${what} de fusion`;
    }
    case 'enchant':
      return copies > 1
        ? `${copies} normales à enchanter pour ses dorées`
        : 'une normale à enchanter pour sa dorée';
    case 'none':
      return copies > 1
        ? `${copies} exemplaires sans usage`
        : 'sans usage : déjà tout ce qui lui sert';
  }
}

/** Ce que des exemplaires coûtent à celui qui les cède. */
function giverText({ kind, copies }: WorthPart<TradeCost>, fusions: string[]): string {
  switch (kind) {
    case 'spare':
      return copies > 1 ? `${copies} exemplaires en trop` : 'en trop';
    case 'last':
      return 'son dernier exemplaire : la carte quitte sa collection';
    case 'constellation':
      return copies > 1
        ? `${copies} doublons gardés pour sa constellation`
        : 'un doublon gardé pour sa constellation';
    case 'fusion': {
      const what = copies > 1 ? `${copies} composants gardés` : 'gardée';
      return fusions.length > 0
        ? `${what} pour sa fusion ${quote(fusions)}`
        : `${what} pour une fusion`;
    }
    case 'enchant':
      return copies > 1
        ? `${copies} normales gardées pour les enchanter`
        : "gardée pour l'enchanter";
  }
}

/** Points d'une part : gagnés, perdus, ou utiles plus tard (fusion, dorée à enchanter). */
function PartPoints({ part, role }: { part: WorthPart<string>; role: 'receiver' | 'giver' }) {
  if (part.points > 0)
    return role === 'receiver' ? (
      <b className="text-zu-400">+{plural(part.points, 'pt')}</b>
    ) : (
      <b className="text-gold">−{plural(part.points, 'pt')}</b>
    );
  if (part.kind === 'spare') return <b className="text-white/70">rien de perdu</b>;
  if (part.kind === 'fusion' || part.kind === 'enchant')
    return <b className="text-white/70">0 pt tout de suite</b>;
  return <b className="text-white/70">0 pt</b>;
}

/** Ce que vaut une carte pour l'un des deux joueurs, celui qui la reçoit ou celui qui la cède. */
function WorthLine({
  worth,
  role,
  name,
}: {
  worth: CardWorth;
  role: 'receiver' | 'giver';
  name: string;
}) {
  const side = worth[role];
  return (
    <p>
      <span className="font-semibold text-white">{name}</span>{' '}
      <span className="text-white/55">{role === 'receiver' ? 'la reçoit' : 'la cède'}</span> :{' '}
      {side.parts.map((part, i) => (
        <span key={`${part.kind}:${i}`}>
          {i > 0 && ' · '}
          {role === 'receiver'
            ? receiverText(part as WorthPart<TradeNeed>, side.fusions)
            : giverText(part as WorthPart<TradeCost>, side.fusions)}{' '}
          <PartPoints part={part} role={role} />
        </span>
      ))}
    </p>
  );
}

function WorthRow({
  worth,
  giver,
  receiver,
}: {
  worth: CardWorth;
  giver: string;
  receiver: string;
}) {
  const { card } = worth;
  return (
    <li className="surface flex gap-3 p-3">
      <CardThumb card={card} />
      <div className="min-w-0 flex-1 space-y-1.5 text-xs text-white/80">
        <p className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium text-white">{card.name}</span>
          {card.count > 1 && <span className="shrink-0 text-zu-400">×{card.count}</span>}
        </p>
        <WorthLine worth={worth} role="receiver" name={receiver} />
        <WorthLine worth={worth} role="giver" name={giver} />
        {(worth.receiver.wanted || worth.giver.offered) && (
          <p className="flex flex-wrap gap-1.5">
            {worth.receiver.wanted && (
              <span className="chip text-white/70">
                <Heart className="size-3 text-pink-400" />
                Recherchée par {receiver} sur le marché
              </span>
            )}
            {worth.giver.offered && (
              <span className="chip text-white/70">
                <Tag className="size-3 text-sky-400" />
                Proposée par {giver} sur le marché
              </span>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

/** Bilan d'un joueur : ce qu'il reçoit, ce qu'il cède. Le même cadre pour les deux. */
function Balance({ side, other }: { side: ExplainedSide; other: ExplainedSide }) {
  const received = other.gives.reduce((t, w) => t + w.card.count, 0);
  const given = side.gives.reduce((t, w) => t + w.card.count, 0);
  const left = side.player.tradesLeft;
  return (
    <section className="card space-y-3 p-4">
      <header className="flex items-center gap-3">
        <PlayerAvatar src={side.player.avatar} name={side.player.displayName} />
        <div className="min-w-0">
          <h2 className="truncate font-bold tracking-wide">{side.player.displayName}</h2>
          <p className="truncate text-xs text-white/60">
            @{side.player.name}
            {side.market && ' · annonce sur le marché'}
          </p>
        </div>
      </header>
      <dl className="space-y-1.5 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-white/65">Reçoit {plural(received, 'carte')}</dt>
          <dd className={`font-mono ${side.gain > 0 ? 'text-zu-400' : 'text-white/70'}`}>
            {signedPoints(side.gain)}
          </dd>
        </div>
        {side.indirect > 0 && (
          <p className="text-xs text-white/55">
            dont {plural(side.indirect, 'exemplaire')} pour une fusion ou une dorée à enchanter
          </p>
        )}
        <div className="flex justify-between gap-3">
          <dt className="text-white/65">Cède {plural(given, 'carte')}</dt>
          <dd className={`font-mono ${side.loss > 0 ? 'text-gold' : 'text-white/70'}`}>
            {side.loss > 0 ? `−${plural(side.loss, 'pt')}` : 'rien de perdu'}
          </dd>
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.08] pt-1.5">
          <dt className="font-semibold">Bilan</dt>
          <dd className="font-mono font-semibold">{signedPoints(side.gain - side.loss)}</dd>
        </div>
      </dl>
      <p className="text-xs text-white/55">
        {left > 0
          ? `Encore ${plural(left, 'échange')} possible${left > 1 ? 's' : ''} aujourd'hui`
          : "Plus d'échange aujourd'hui : l'échange sera pour demain"}
      </p>
    </section>
  );
}

/** Ce que le jeu refuserait, dit pour les deux joueurs à égalité. */
function issueText(issue: TradeIssue, names: [string, string]): string {
  if (issue.kind === 'unmatched')
    return `${plural(issue.cards, 'carte')} sans contrepartie de même rareté et brillance : le jeu exige les mêmes des deux côtés.`;
  const who = names[issue.side === 'give' ? 0 : 1];
  return `${who} cède ${plural(issue.copies, 'carte')} : ${TRADE_MAX_CARDS} au plus de chaque côté.`;
}

/** Cartes du lien que l'un des joueurs n'a plus (déjà échangées ?), ou plus en assez d'exemplaires. */
function unavailable(linked: LinkedCard[], given: CardWorth[]): string[] {
  return linked.flatMap((l) => {
    const found = given.find((w) => w.card.identifier === l.identifier && w.card.shiny === l.shiny);
    const ref = `${l.identifier}${SHINY_SUFFIX[l.shiny]}`;
    if (!found) return [ref];
    return found.card.count < l.count ? [`${ref} (${found.card.count} sur ${l.count})`] : [];
  });
}

/**
 * La page d'un échange : ce que chaque carte vaut pour chacun des deux joueurs, sans préférer
 * aucun des deux. Les mêmes cadres, les mêmes couleurs et les mêmes commandes pour chacun.
 */
export function SharedTrade({ link }: { link: SharedTradeLink }) {
  const [trade, setTrade] = useState<TradeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (fresh = false) => {
      setLoading(true);
      setError(null);
      try {
        setTrade(
          await fetchTrade({
            me: link.players[0],
            other: link.players[1],
            ruleSet: 'NORMAL',
            keep: {
              me: link.keep[0] ?? DEFAULT_TRADE_KEEP,
              other: link.keep[1] ?? DEFAULT_TRADE_KEEP,
            },
            fresh,
          }),
        );
      } catch (e) {
        setTrade(null);
        setError(e instanceof PlanError ? e.message : 'Une erreur inattendue est survenue.');
      } finally {
        setLoading(false);
      }
    },
    [link],
  );
  useEffect(() => void load(), [load]);

  const explained = useMemo<TradeExplanation | null>(
    () =>
      trade &&
      explainTrade(trade, [
        picksFromLink(tradeCards(trade.me), link.gives[0]),
        picksFromLink(tradeCards(trade.other), link.gives[1]),
      ]),
    [trade, link],
  );

  const names = explained
    ? (explained.sides.map((s) => s.player.displayName) as [string, string])
    : link.players;
  const title = `Échange ${names[0]} ⇄ ${names[1]} · ZUnivers Ninja`;
  useEffect(() => {
    document.title = title;
  }, [title]);

  if (error)
    return (
      <div className="card flex flex-col items-center gap-3 px-6 py-12 text-center" role="alert">
        <CircleAlert className="size-9 text-danger" />
        <p className="max-w-md font-medium">{error}</p>
        <button type="button" className="btn-ghost" onClick={() => void load(true)}>
          <RefreshCw className="size-4" />
          Réessayer
        </button>
      </div>
    );
  if (!explained)
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Chargement de l'échange">
        <p className="text-sm text-white/60">
          Comparaison des collections de {link.players[0]} et {link.players[1]}…
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="card h-40 animate-pulse" />
          ))}
        </div>
      </div>
    );

  const [a, b] = explained.sides;
  const missing = [
    { name: names[0], cards: unavailable(link.gives[0], a.gives) },
    { name: names[1], cards: unavailable(link.gives[1], b.gives) },
  ].filter((m) => m.cards.length > 0);
  const valid = explained.issues.length === 0;

  return (
    <div className="space-y-5">
      <section className="card space-y-4 p-4 sm:p-5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <p className="truncate text-right text-lg font-bold sm:text-2xl">{names[0]}</p>
          <ArrowLeftRight className="size-5 text-zu-400" aria-label="échange avec" />
          <p className="truncate text-lg font-bold sm:text-2xl">{names[1]}</p>
        </div>
        <p className="text-center text-sm text-white/65">
          Ce que chaque carte vaut pour chacun : ce qu'elle apporte à celui qui la reçoit, et ce
          qu'elle coûte à celui qui la cède, en points de collection.
        </p>
        {valid ? (
          <p className="flex items-center justify-center gap-2 text-sm text-zu-400">
            <CircleCheck className="size-4" />
            Le jeu accepte cet échange : mêmes raretés et brillances des deux côtés,{' '}
            {TRADE_MAX_CARDS} cartes au plus.
          </p>
        ) : (
          <div className="space-y-1 rounded border border-danger/40 px-3 py-2 text-sm text-danger">
            <p className="flex items-center gap-2 font-semibold">
              <CircleAlert className="size-4 shrink-0" />
              Le jeu refuserait cet échange :
            </p>
            <ul className="list-disc space-y-0.5 pl-8">
              {explained.issues.map((issue) => (
                <li key={`${issue.kind}:${'side' in issue ? issue.side : ''}`}>
                  {issueText(issue, names)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {missing.length > 0 && (
          <p className="flex gap-2 text-xs text-gold">
            <CircleAlert className="size-4 shrink-0" />
            <span>
              Plus disponibles (déjà échangées ?) :{' '}
              {missing.map((m) => `chez ${m.name}, ${m.cards.join(', ')}`).join(' ; ')}.
            </span>
          </p>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <Balance side={a} other={b} />
        <Balance side={b} other={a} />
      </div>

      <section className="card overflow-hidden">
        <header className="flex items-center gap-2 border-b border-white/[0.08] px-4 py-3">
          <Scale className="size-4 text-zu-400" />
          <h2 className="font-bold tracking-wide uppercase">Cartes échangées</h2>
        </header>
        {explained.categories.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-white/60">
            Aucune carte dans cet échange.
          </p>
        ) : (
          <div className="space-y-5 px-4 py-4">
            {explained.categories.map((category) => {
              const counts = category.gives.map((g) => g.reduce((t, w) => t + w.card.count, 0));
              return (
                <div key={`${category.rarity}:${category.shiny}`} className="space-y-2">
                  <h3 className={`label ${RARITY_TINT[category.rarity] ?? ''}`}>
                    {RARITY_LABEL[category.rarity] ?? category.rarity} ·{' '}
                    {SHINY_NAME[category.shiny]}{' '}
                    <span className="text-white/45 normal-case">
                      · {counts[0]} ⇄ {counts[1]}
                    </span>
                    {counts[0] !== counts[1] && (
                      <span className="ml-2 text-danger normal-case">
                        pas autant de chaque côté
                      </span>
                    )}
                  </h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    {category.gives.map((given, i) => (
                      <div key={i} className="space-y-2">
                        <p className="text-xs text-white/60">{names[i]} cède</p>
                        {given.length === 0 ? (
                          <p className="text-xs text-white/45">Rien dans cette catégorie.</p>
                        ) : (
                          <ul className="space-y-2">
                            {given.map((w) => (
                              <WorthRow
                                key={w.card.key}
                                worth={w}
                                giver={names[i]!}
                                receiver={names[i === 0 ? 1 : 0]!}
                              />
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {valid && (
        <section className="card space-y-3 p-4">
          <h2 className="flex items-center gap-2 font-bold tracking-wide uppercase">
            <SquareTerminal className="size-4 text-zu-400" />
            Commande d'échange
          </h2>
          <p className="text-xs text-white/60">
            L'un des deux la tape dans le jeu, l'autre accepte l'échange.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {explained.commands.map((command, i) => (
              <div key={i} className="space-y-2">
                <p className="label">Si {names[i]} lance l'échange</p>
                <code className="surface block px-3 py-2 font-mono text-xs break-words text-white/90">
                  {command}
                </code>
                <CopyButton text={command} label="Copier la commande" />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-wrap gap-2">
        {([0, 1] as const).map((i) => (
          <a
            key={i}
            href={linkUrl(sideView(link, i))}
            className="btn-ghost px-2.5 py-1.5"
            title={`Ouvrir l'échange dans l'onglet Échanges de ${names[i]}, pour le modifier`}
          >
            <UserRound className="size-4" />
            Ouvrir du côté de {names[i]}
          </a>
        ))}
        <CopyButton text={sharedTradeUrl(link)} label="Copier le lien de la page" />
        <button
          type="button"
          className="btn-ghost px-2.5 py-1.5"
          onClick={() => void load(true)}
          disabled={loading}
          title="Recharger les collections des deux joueurs"
        >
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          Actualiser
        </button>
      </section>
    </div>
  );
}
