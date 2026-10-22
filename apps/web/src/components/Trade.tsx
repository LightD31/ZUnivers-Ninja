import {
  DEFAULT_TRADE_KEEP,
  proposeTrade,
  tradeAlternatives,
  tradeCardList,
  tradeMessage,
  tradeValue,
  type CardKey,
  type RuleSet,
  type TradeCard,
  type TradeKeep,
  type TradeKeptFor,
  type TradeNeed,
  type TradePicks,
  type TradeProposal,
  type TradeResult,
  type TradeSide,
} from '@zuninja/core';
import {
  ArrowLeftRight,
  Check,
  ChevronRight,
  CircleAlert,
  Handshake,
  Heart,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Tag,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchTrade, PlanError } from '../lib/api';
import { RARITY_LABEL, RARITY_TINT, SHINY_NAME } from '../lib/game';
import type { Settings } from '../lib/settings';
import { load, save } from '../lib/storage';
import { CardChip } from './CardChip';
import { CopyButton } from './CopyButton';

const PARTNERS_KEY = 'zuninja:trade-partners';
const SHINY_RING = ['ring-white/10', 'ring-gold', 'ring-[#aaa5fa]'];
const SHINY_SUFFIX = ['', '+', '*'];

/**
 * Réserve d'un joueur, comme les cases du plan : ce qu'il garde au lieu de l'échanger, et ce qu'il
 * lui manque encore (les exemplaires à lui proposer).
 */
const KEEP_OPTIONS: { key: keyof TradeKeep; label: string; title: string }[] = [
  {
    key: 'golden',
    label: 'Normales à enchanter',
    title: 'Les normales à enchanter pour monter la constellation dorée : gardées, et demandées.',
  },
  {
    key: 'goldenFusions',
    label: 'Fusions dorées',
    title: 'Les normales à enchanter pour les fusions dorées à faire : gardées, et demandées.',
  },
  {
    key: 'constellation',
    label: 'Constellations',
    title: 'Les doublons qui montent la constellation de la carte : gardés, et demandés.',
  },
];

/** Ce qu'une carte déjà possédée apporte encore au receveur. */
const NEED_SHORT: Record<Exclude<TradeNeed, 'missing'>, string> = {
  constellation: 'constellation',
  fusion: 'fusion',
  enchant: 'à enchanter',
};

/** Ce que le donneur perdrait en cédant une carte qu'il garde. */
const KEPT_SHORT: Record<TradeKeptFor, string> = {
  last: 'dernière',
  fusion: 'fusion',
  enchant: 'à enchanter',
  constellation: 'constellation',
};

/** Pourquoi une carte gardée coûte quelque chose, à soi (`owner` nul) ou à l'autre joueur. */
function keptNote(reason: TradeKeptFor, owner: string | null): string {
  if (reason === 'last') return owner ? 'c’est sa dernière' : 'c’est ta dernière';
  const use =
    reason === 'fusion'
      ? 'pour une fusion'
      : reason === 'enchant'
        ? "pour l'enchanter"
        : 'pour sa constellation';
  return owner ? `${owner} la garde ${use}` : `tu la gardes ${use}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

/**
 * Valeur d'un côté de l'échange : ses points de collection, les exemplaires qui servent sans en
 * rapporter tout de suite (composants de fusion, normales à enchanter), et ceux donnés en plus de
 * ce qui sert (au-delà des besoins du receveur).
 */
function valueText(cards: TradeCard[]): string {
  const points = cards.reduce((total, c) => total + tradeValue(c), 0);
  const count = (f: (c: TradeCard) => number) => cards.reduce((total, c) => total + f(c), 0);
  const indirect = count((c) => c.gains.slice(0, c.count).filter((gain) => gain === 0).length);
  const extra = count((c) => Math.max(0, c.count - c.gains.length));
  return [
    plural(points, 'pt'),
    indirect > 0 && `${plural(indirect, 'exemplaire')} à enchanter ou fusionner`,
    extra > 0 && `${plural(extra, 'exemplaire')} en plus des besoins`,
  ]
    .filter(Boolean)
    .join(' + ');
}
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

interface Props {
  /** Joueur affiché : celui qui propose l'échange. */
  me: string;
  ruleSet: RuleSet;
  settings: Settings;
  initialPartner: string;
  onPartner: (name: string) => void;
}

/** Échanges : ce que deux joueurs peuvent se donner, et une proposition équilibrée. */
export function Trade({ me, ruleSet, settings, initialPartner, onPartner }: Props) {
  const [partner, setPartner] = useState(initialPartner);
  // Tes cases reprennent celles du plan ; l'autre joueur garde tout par défaut.
  const [keepMe, setKeepMe] = useState<TradeKeep>(() => ({
    golden: settings.keepForGolden,
    goldenFusions: settings.keepForGoldenFusions,
    constellation: !settings.skip.includes('constellation'),
  }));
  const [keepOther, setKeepOther] = useState<TradeKeep>(DEFAULT_TRADE_KEEP);
  const [trade, setTrade] = useState<TradeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cartes choisies de chaque côté, avec leur nombre d'exemplaires.
  const [receive, setReceive] = useState<TradePicks>({});
  const [give, setGive] = useState<TradePicks>({});
  const [filter, setFilter] = useState('');
  const [recent, setRecent] = useState<string[]>(() => load(PARTNERS_KEY, []));
  const request = useRef(0);

  const compare = useCallback(
    async (other: string, keep: { me: TradeKeep; other: TradeKeep }, fresh = false) => {
      const id = ++request.current;
      setLoading(true);
      setError(null);
      try {
        const result = await fetchTrade({ me, other, ruleSet, keep, fresh });
        if (id !== request.current) return;
        setTrade(result);
        setRecent((r) => {
          const name = result.other.player.name;
          const next = [name, ...r.filter((x) => x.toLowerCase() !== name.toLowerCase())].slice(
            0,
            6,
          );
          save(PARTNERS_KEY, next);
          return next;
        });
      } catch (e) {
        if (id !== request.current) return;
        setTrade(null);
        setError(e instanceof PlanError ? e.message : 'Une erreur inattendue est survenue.');
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [me, ruleSet],
  );

  useEffect(() => {
    if (partner) void compare(partner, { me: keepMe, other: keepOther });
  }, [partner, keepMe, keepOther, compare]);

  const choose = (name: string) => {
    if (name.toLowerCase() === me.toLowerCase()) {
      setError('Choisis un autre joueur que toi pour échanger.');
      return;
    }
    setTrade(null);
    setReceive({});
    setGive({});
    setFilter('');
    setPartner(name);
    onPartner(name);
  };

  const proposal = useMemo(
    () => (trade ? proposeTrade(trade, { receive, give }) : null),
    [trade, receive, give],
  );

  const query = fold(filter.trim());
  const visible = (c: TradeCard) =>
    !query ||
    fold(c.name).includes(query) ||
    `${c.identifier}${SHINY_SUFFIX[c.shiny]}`.startsWith(query);
  type SetPicks = (f: (picks: TradePicks) => TradePicks) => void;
  // Une carte choisie l'est avec ses exemplaires utiles par défaut ; un second clic la retire.
  const toggle = (set: SetPicks) => (card: TradeCard) =>
    set(({ [card.key]: picked, ...rest }) => (picked ? rest : { ...rest, [card.key]: card.count }));
  const add = (set: SetPicks) => (card: TradeCard) =>
    set((p) => (p[card.key] ? p : { ...p, [card.key]: card.count }));
  const setCount = (set: SetPicks) => (key: CardKey, count: number) =>
    set((p) => ({ ...p, [key]: count }));
  const picks = Object.keys(receive).length + Object.keys(give).length;

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        <PartnerForm
          key={partner}
          initial={partner}
          loading={loading}
          suggestions={recent.filter((r) => r.toLowerCase() !== me.toLowerCase())}
          onSubmit={choose}
          onRefresh={
            trade && partner
              ? () => void compare(partner, { me: keepMe, other: keepOther }, true)
              : null
          }
        />

        {error && (
          <p
            className="card flex items-center gap-2 border-l-2 border-danger px-4 py-3 text-sm"
            role="alert"
          >
            <CircleAlert className="size-4 shrink-0 text-danger" />
            {error}
          </p>
        )}
        {!trade && loading && <TradeSkeleton />}
        {!trade && !loading && !error && !partner && (
          <p className="card px-4 py-8 text-center text-sm text-white/65">
            Entre le pseudo d'un autre joueur : tu verras les cartes que chacun peut donner à
            l'autre sans rien perdre, et une proposition d'échange équilibrée.
          </p>
        )}

        {trade && proposal && (
          <>
            <label className="relative block">
              <span className="sr-only">Chercher une carte</span>
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-white/60" />
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Chercher une carte (nom ou numéro)"
                autoComplete="off"
                spellCheck={false}
                className="field h-10 w-full pr-3 pl-10 text-sm"
              />
            </label>
            {picks > 0 && (
              <a
                href="#proposition"
                className="chip transition hover:bg-zu-500/20 hover:text-white lg:hidden"
              >
                <ArrowLeftRight className="size-3.5 text-zu-400" />
                Voir la proposition ({proposal.receive.length} ↔ {proposal.give.length})
              </a>
            )}
            <SideList
              side={trade.other}
              title={`${trade.other.player.displayName} peut te donner`}
              empty={`${trade.other.player.displayName} n'a aucune carte en trop qui te serait utile.`}
              owner={trade.other.player.displayName}
              keep={keepOther}
              onKeep={setKeepOther}
              cards={trade.other.gives.filter(visible)}
              kept={trade.other.kept.filter(visible)}
              filtered={!!query}
              picked={receive}
              proposal={proposal}
              onToggle={toggle(setReceive)}
            />
            <SideList
              side={trade.me}
              title="Tu peux lui donner"
              empty={`Tu n'as aucune carte en trop utile à ${trade.other.player.displayName}.`}
              owner={null}
              keep={keepMe}
              onKeep={setKeepMe}
              cards={trade.me.gives.filter(visible)}
              kept={trade.me.kept.filter(visible)}
              filtered={!!query}
              picked={give}
              proposal={proposal}
              onToggle={toggle(setGive)}
            />
          </>
        )}
      </div>

      {trade && proposal && (
        <Proposal
          trade={trade}
          proposal={proposal}
          picks={{ receive, give }}
          onAsk={add(setReceive)}
          onOffer={add(setGive)}
          onCount={{ receive: setCount(setReceive), give: setCount(setGive) }}
          onClear={() => {
            setReceive({});
            setGive({});
          }}
        />
      )}
    </div>
  );
}

function PartnerForm({
  initial,
  loading,
  suggestions,
  onSubmit,
  onRefresh,
}: {
  initial: string;
  loading: boolean;
  suggestions: string[];
  onSubmit: (name: string) => void;
  onRefresh: (() => void) | null;
}) {
  const [value, setValue] = useState(initial);
  return (
    <section className="card space-y-3 p-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const name = value.trim();
          if (name) onSubmit(name);
        }}
      >
        <label className="relative flex-1">
          <span className="sr-only">Pseudo de l'autre joueur</span>
          <Handshake className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-white/60" />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Échanger avec… (pseudo Discord)"
            autoComplete="off"
            spellCheck={false}
            className="field h-10 w-full pr-3 pl-10 text-sm"
          />
        </label>
        <button type="submit" className="btn-primary h-10" disabled={loading || !value.trim()}>
          {loading ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Comparer
        </button>
        {onRefresh && (
          <button
            type="button"
            className="btn-ghost h-10 px-2.5"
            onClick={onRefresh}
            disabled={loading}
            title="Recharger les collections"
            aria-label="Recharger les collections"
          >
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
      </form>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className="chip transition hover:bg-zu-500/20 hover:text-white"
              onClick={() => {
                setValue(s);
                onSubmit(s);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-white/60">
        Seules les cartes échangeables sont comparées : le surplus de chacun dont l'autre a l'usage
        (cartes qui lui manquent, doublons pour ses constellations, normales à enchanter, composants
        de fusion), selon la réserve de chacun ci-dessous. Les cartes recherchées sur le marché
        passent en premier.
      </p>
    </section>
  );
}

function SideList({
  side,
  title,
  empty,
  owner,
  keep,
  onKeep,
  cards,
  kept,
  filtered,
  picked,
  proposal,
  onToggle,
}: {
  side: TradeSide;
  title: string;
  empty: string;
  /** Nom du joueur qui donne ces cartes, `null` pour soi. */
  owner: string | null;
  keep: TradeKeep;
  onKeep: (keep: TradeKeep) => void;
  cards: TradeCard[];
  /** Cartes utiles à l'autre mais que le donneur garde. */
  kept: TradeCard[];
  filtered: boolean;
  picked: TradePicks;
  proposal: TradeProposal;
  onToggle: (card: TradeCard) => void;
}) {
  const [showKept, setShowKept] = useState(false);
  // Une recherche montre aussi les cartes gardées : on cherche souvent celle qu'on nous demande.
  const keptOpen = showKept || (filtered && kept.length > 0);
  const groups = new Map<number, TradeCard[]>();
  for (const c of [...cards].sort((a, b) => b.rarity - a.rarity))
    groups.set(c.rarity, [...(groups.get(c.rarity) ?? []), c]);
  const left = side.player.tradesLeft;
  const trades =
    left > 0
      ? `${owner ? `${owner} a` : 'Tu as'} encore ${plural(left, 'échange')} aujourd'hui`
      : `${owner ? `${owner} n'a` : "Tu n'as"} plus d'échange aujourd'hui`;
  return (
    <section className="card overflow-hidden">
      <header className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-3">
        <PlayerAvatar src={side.player.avatar} name={side.player.displayName} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-bold tracking-wide uppercase">{title}</h2>
          <p className="text-xs text-white/60">
            {trades}
            {side.market && ' · annonce sur le marché'}
          </p>
        </div>
        <span className="shrink-0 text-xs text-white/60">{plural(side.gives.length, 'carte')}</span>
      </header>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.06] px-4 py-2 text-xs">
        <span
          className="text-white/60"
          title={`Ce que ${owner ?? 'tu'} ${owner ? 'garde' : 'gardes'} au lieu de l'échanger, et ce qu'il ${owner ? 'lui' : 'te'} manque encore : décocher une case libère ces exemplaires et ne les demande plus.`}
        >
          {owner ? `Réserve de ${owner}` : 'Ta réserve'} :
        </span>
        {KEEP_OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            aria-pressed={keep[o.key]}
            title={o.title}
            onClick={() => onKeep({ ...keep, [o.key]: !keep[o.key] })}
            className={`chip transition ${
              keep[o.key]
                ? 'bg-zu-500/20 text-white ring-1 ring-zu-500/50'
                : 'text-white/55 hover:text-white'
            }`}
          >
            {keep[o.key] && <Check className="size-3 text-zu-400" />}
            {o.label}
          </button>
        ))}
      </div>
      {cards.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-white/60">
          {filtered ? 'Aucune carte en trop ne correspond à la recherche.' : empty}
        </p>
      ) : (
        <div className="space-y-4 px-4 py-3">
          {[...groups].map(([rarity, list]) => (
            <div key={rarity}>
              <h3 className={`label mb-2 ${RARITY_TINT[rarity] ?? ''}`}>
                {RARITY_LABEL[rarity] ?? rarity}{' '}
                <span className="text-white/45 normal-case">· {list.length}</span>
              </h3>
              <div className="flex flex-wrap gap-3">
                {list.map((c) => (
                  <TradeTile
                    key={c.key}
                    card={c}
                    picked={!!picked[c.key]}
                    added={proposal.added.includes(c.key)}
                    unmatched={proposal.unmatched.includes(c.key)}
                    onToggle={() => onToggle(c)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {kept.length > 0 && (
        <div className="border-t border-white/[0.06] px-4 py-3">
          <button
            type="button"
            aria-expanded={keptOpen}
            onClick={() => setShowKept(!keptOpen)}
            className="label flex items-center gap-1.5 text-white/70 transition hover:text-white"
          >
            <ChevronRight className={`size-3.5 transition ${keptOpen ? 'rotate-90' : ''}`} />
            {owner ? `Cartes que ${owner} garde` : 'Cartes que tu gardes'}
            <span className="text-white/45 normal-case">· {kept.length}</span>
          </button>
          {keptOpen && (
            <>
              <p className="mt-1.5 text-xs text-white/55">
                {owner
                  ? `Elles te seraient utiles, mais ${owner} les garde (dernier exemplaire, fusion, enchantement ou constellation) : à demander seulement si c'est d'accord.`
                  : "Elles seraient utiles à l'autre, mais tu les gardes (dernier exemplaire, fusion, enchantement ou constellation). Si on te les demande, choisis-les : la proposition dit ce que tu peux demander en échange."}
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                {kept.map((c) => (
                  <TradeTile
                    key={c.key}
                    card={c}
                    picked={!!picked[c.key]}
                    added={false}
                    unmatched={proposal.unmatched.includes(c.key)}
                    onToggle={() => onToggle(c)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Carte à choisir : un clic l'ajoute à l'échange (ou l'en retire). */
function TradeTile({
  card,
  picked,
  added,
  unmatched,
  onToggle,
}: {
  card: TradeCard;
  picked: boolean;
  added: boolean;
  unmatched: boolean;
  onToggle: () => void;
}) {
  const outline = picked
    ? `outline-2 outline-offset-2 ${unmatched ? 'outline-danger' : 'outline-zu-500'}`
    : added
      ? 'outline-2 outline-offset-2 outline-dashed outline-zu-400'
      : '';
  const ref = `${card.identifier}${SHINY_SUFFIX[card.shiny]}`;
  const notes = [
    card.keptFor
      ? `gardée : ${KEPT_SHORT[card.keptFor]}`
      : `${plural(card.spare, 'exemplaire')} en trop`,
    card.need !== 'missing' &&
      `utile pour ${card.need === 'enchant' ? "l'enchanter" : `sa ${NEED_SHORT[card.need]}`} (${plural(card.gains.length, 'exemplaire')})`,
    card.wanted && 'recherchée sur le marché',
    card.offered && 'proposée sur le marché',
    added && "ajoutée pour équilibrer l'échange",
    unmatched && 'sans contrepartie de même rareté',
  ].filter(Boolean);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={picked}
      title={`${card.name} (${ref}) : ${notes.join(', ')}`}
      className="group relative block w-16 shrink-0 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zu-500"
    >
      <span
        className={`relative block aspect-[5/7] overflow-hidden rounded bg-ink-700 ring-2 ${SHINY_RING[card.shiny]} ${outline}`}
      >
        {card.image ? (
          <img
            src={card.image}
            alt=""
            loading="lazy"
            className="size-full object-cover transition group-hover:scale-105"
          />
        ) : (
          <span className="grid size-full place-items-center text-[10px] text-white/45">
            {card.identifier}
          </span>
        )}
        {picked && (
          <span className="absolute inset-0 grid place-items-center bg-black/50">
            <Check className="size-6 text-zu-400" />
          </span>
        )}
        {card.count > 1 && (
          <span className="absolute right-0.5 bottom-0.5 rounded bg-zu-500 px-1 text-[10px] leading-4 font-bold text-white">
            ×{card.count}
          </span>
        )}
      </span>
      {card.wanted && (
        <span className="absolute -top-1.5 -left-1.5 grid size-5 place-items-center rounded-full bg-pink-500 text-white shadow">
          <Heart className="size-3" />
        </span>
      )}
      {card.offered && (
        <span className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-sky-500 text-white shadow">
          <Tag className="size-3" />
        </span>
      )}
      <span
        className={`mt-1 block truncate text-center font-mono text-[10px] ${RARITY_TINT[card.rarity] ?? ''}`}
      >
        {ref}
      </span>
      <span className="block truncate text-center text-[10px] text-white/60">{card.name}</span>
      {card.need !== 'missing' && (
        <span className="mt-0.5 block truncate rounded bg-zu-500/15 text-center text-[9px] tracking-wide text-zu-400 uppercase">
          {NEED_SHORT[card.need]}
        </span>
      )}
      {card.keptFor && (
        <span className="mt-0.5 block truncate rounded bg-gold/15 text-center text-[9px] tracking-wide text-gold uppercase">
          {KEPT_SHORT[card.keptFor]}
        </span>
      )}
    </button>
  );
}

function Proposal({
  trade,
  proposal,
  picks,
  onAsk,
  onOffer,
  onCount,
  onClear,
}: {
  trade: TradeResult;
  proposal: TradeProposal;
  picks: { receive: TradePicks; give: TradePicks };
  /** Ajoute une carte de l'autre joueur à l'échange. */
  onAsk: (card: TradeCard) => void;
  /** Ajoute une de mes cartes à l'échange. */
  onOffer: (card: TradeCard) => void;
  /** Change le nombre d'exemplaires d'une carte choisie. */
  onCount: {
    receive: (key: CardKey, count: number) => void;
    give: (key: CardKey, count: number) => void;
  };
  onClear: () => void;
}) {
  const other = trade.other.player;
  const empty = proposal.receive.length + proposal.give.length === 0;
  const message = tradeMessage(other.displayName, proposal);
  const alternatives = tradeAlternatives(trade, proposal).filter(
    (a) => a.ask.length + a.offer.length > 0,
  );
  const keptCards = [
    ...proposal.give.flatMap((c) => (c.keptFor ? [{ card: c, owner: null }] : [])),
    ...proposal.receive.flatMap((c) => (c.keptFor ? [{ card: c, owner: other.displayName }] : [])),
  ];
  return (
    <aside id="proposition" className="card space-y-4 p-4 lg:sticky lg:top-24">
      <h2 className="flex items-center gap-2 font-bold tracking-wide uppercase">
        <ArrowLeftRight className="size-4 text-zu-400" />
        Proposition
      </h2>
      {empty ? (
        <p className="text-sm text-white/65">
          Choisis les cartes que tu veux recevoir, ou celles qu'on te demande dans « Tu peux lui
          donner » (cherche-les par leur nom). En face, une carte de même rareté et brillance est
          ajoutée pour équilibrer l'échange, et la proposition liste toutes celles que tu peux
          demander à la place.
        </p>
      ) : (
        <>
          <ProposalList
            title="Tu reçois"
            cards={proposal.receive}
            proposal={proposal}
            picks={picks.receive}
            onCount={onCount.receive}
          />
          <ProposalList
            title="Tu donnes"
            cards={proposal.give}
            proposal={proposal}
            picks={picks.give}
            onCount={onCount.give}
          />
          <p className="text-xs text-white/60" title="Points de collection que chacun gagne">
            Valeur : tu reçois {valueText(proposal.receive)} · tu donnes {valueText(proposal.give)}
          </p>
          {proposal.unmatched.length > 0 && (
            <p className="flex gap-2 text-xs text-danger">
              <CircleAlert className="size-4 shrink-0" />
              {plural(proposal.unmatched.length, 'carte')} sans contrepartie de même rareté et
              brillance : à négocier.
            </p>
          )}
          {keptCards.length > 0 && (
            <ul className="space-y-1 text-xs text-gold">
              {keptCards.map(({ card, owner }) => (
                <li key={card.key} className="flex gap-2">
                  <CircleAlert className="size-4 shrink-0" />
                  <span>
                    {card.identifier}
                    {SHINY_SUFFIX[card.shiny]} {card.name} : {keptNote(card.keptFor!, owner)}.
                  </span>
                </li>
              ))}
            </ul>
          )}
          {(trade.me.player.tradesLeft === 0 || other.tradesLeft === 0) && (
            <p className="flex gap-2 text-xs text-gold">
              <CircleAlert className="size-4 shrink-0" />
              {trade.me.player.tradesLeft === 0
                ? "Tu n'as plus d'échange aujourd'hui : propose-le pour demain."
                : `${other.displayName} n'a plus d'échange aujourd'hui : propose-le pour demain.`}
            </p>
          )}
          <p className="surface px-3 py-2 text-xs whitespace-pre-wrap text-white/80">{message}</p>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={message} label="Copier le message" />
            {proposal.give.length > 0 && (
              <CopyButton text={tradeCardList(proposal.give)} label="Mes cartes" />
            )}
            {proposal.receive.length > 0 && (
              <CopyButton text={tradeCardList(proposal.receive)} label="Ses cartes" />
            )}
            <button type="button" className="btn-ghost px-2 py-1.5" onClick={onClear}>
              <X className="size-4" />
              Vider
            </button>
          </div>
          {alternatives.length > 0 && (
            <div className="space-y-3 border-t border-white/[0.08] pt-3">
              <p className="label">Autres contreparties possibles</p>
              {alternatives.map((a) => (
                <div key={`${a.rarity}:${a.shiny}`} className="space-y-1.5">
                  <p className={`text-xs ${RARITY_TINT[a.rarity] ?? ''}`}>
                    {RARITY_LABEL[a.rarity] ?? a.rarity} · {SHINY_NAME[a.shiny]}
                  </p>
                  {a.ask.length > 0 && (
                    <Alternatives
                      title={
                        a.askExact
                          ? 'Tu peux aussi demander'
                          : 'Rien de même rareté et brillance : à demander à la place, au plus proche en points'
                      }
                      cards={a.ask}
                      points={!a.askExact}
                      onPick={onAsk}
                    />
                  )}
                  {a.offer.length > 0 && (
                    <Alternatives
                      title={
                        a.offerExact
                          ? 'Tu peux aussi proposer'
                          : 'Rien de même rareté et brillance : à proposer à la place, au plus proche en points'
                      }
                      cards={a.offer}
                      points={!a.offerExact}
                      onPick={onOffer}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </aside>
  );
}

const ALTERNATIVES_SHOWN = 12;

/**
 * Contreparties possibles : un clic ajoute la carte à l'échange, à la place de celle choisie
 * d'office. `points` affiche leur valeur, quand elles ne sont pas de même rareté et brillance.
 */
function Alternatives({
  title,
  cards,
  points,
  onPick,
}: {
  title: string;
  cards: TradeCard[];
  points: boolean;
  onPick: (card: TradeCard) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? cards : cards.slice(0, ALTERNATIVES_SHOWN);
  return (
    <div>
      <p className="mb-1 text-xs text-white/60">
        {title} ({cards.length}) :
      </p>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => onPick(c)}
            title={`Ajouter ${c.name} à l'échange${c.wanted ? ' (recherchée sur le marché)' : ''}`}
            className="chip transition hover:bg-zu-500/20 hover:text-white"
          >
            {c.wanted && <Heart className="size-3 text-pink-400" />}
            <span className={`font-mono font-semibold ${RARITY_TINT[c.rarity] ?? ''}`}>
              {c.identifier}
              {SHINY_SUFFIX[c.shiny]}
            </span>
            <span className="max-w-32 truncate text-white/65">{c.name}</span>
            {points && <span className="text-white/45">{plural(c.points, 'pt')}</span>}
          </button>
        ))}
        {cards.length > shown.length && (
          <button
            type="button"
            className="chip text-white/65 hover:text-white"
            onClick={() => setAll(true)}
          >
            +{cards.length - shown.length}
          </button>
        )}
      </div>
    </div>
  );
}

function ProposalList({
  title,
  cards,
  proposal,
  picks,
  onCount,
}: {
  title: string;
  cards: TradeCard[];
  proposal: TradeProposal;
  picks: TradePicks;
  onCount: (key: CardKey, count: number) => void;
}) {
  return (
    <div>
      <p className="label mb-1.5">
        {title} · {cards.length}
      </p>
      {cards.length === 0 ? (
        <p className="text-xs text-white/50">Rien pour l'instant.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {cards.map((c) => (
            <span
              key={c.key}
              className={`inline-flex items-center gap-1 rounded ${proposal.unmatched.includes(c.key) ? 'ring-1 ring-danger' : ''}`}
            >
              <CardChip card={c} />
              {picks[c.key] !== undefined && c.available > 1 && (
                <CopiesStepper
                  count={c.count}
                  useful={c.gains.length}
                  max={c.available}
                  onChange={(count) => onCount(c.key, count)}
                />
              )}
              {c.need !== 'missing' && (
                <span className="text-[10px] text-white/50">{NEED_SHORT[c.need]}</span>
              )}
              {proposal.added.includes(c.key) && (
                <span
                  className="text-[10px] font-semibold text-zu-400 uppercase"
                  title="Ajoutée pour équilibrer l'échange"
                >
                  auto
                </span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Nombre d'exemplaires d'une carte choisie : de 1 à tous ceux que le donneur peut céder, même
 * au-delà de ce qui sert à celui qui les reçoit.
 */
function CopiesStepper({
  count,
  useful,
  max,
  onChange,
}: {
  count: number;
  /** Exemplaires qui servent au receveur ; les suivants peuvent être donnés quand même. */
  useful: number;
  max: number;
  onChange: (count: number) => void;
}) {
  const button =
    'grid size-5 place-items-center rounded text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-30';
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title={`${plural(useful, 'exemplaire')} utile${useful > 1 ? 's' : ''}, jusqu'à ${max} à donner`}
    >
      <button
        type="button"
        className={button}
        disabled={count <= 1}
        onClick={() => onChange(count - 1)}
        aria-label="Un exemplaire de moins"
      >
        <Minus className="size-3" />
      </button>
      <button
        type="button"
        className={button}
        disabled={count >= max}
        onClick={() => onChange(count + 1)}
        aria-label="Un exemplaire de plus"
      >
        <Plus className="size-3" />
      </button>
    </span>
  );
}

function PlayerAvatar({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setFailed(true)}
        className="size-9 shrink-0 rounded-full object-cover ring-2 ring-zu-500"
      />
    );
  }
  return (
    <div className="grid size-9 shrink-0 place-items-center rounded-full bg-zu-500 font-bold text-white">
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function TradeSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Comparaison des collections">
      {[0, 1].map((i) => (
        <div key={i} className="card animate-pulse space-y-3 p-4">
          <div className="h-4 w-1/3 rounded bg-white/[0.07]" />
          <div className="flex flex-wrap gap-3">
            {Array.from({ length: 8 }, (_, j) => (
              <div key={j} className="aspect-[5/7] w-16 rounded bg-white/[0.07]" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
