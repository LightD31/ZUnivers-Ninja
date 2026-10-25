import {
  DEFAULT_TRADE_KEEP,
  proposeTrade,
  TRADE_MAX_CARDS,
  tradeAlternatives,
  tradeCardList,
  tradeCommand,
  tradeIssues,
  tradeMessage,
  tradeValue,
  TRADE_PARTNERS_LIMIT,
  type CardKey,
  type RuleSet,
  type TradeCard,
  type TradeIssue,
  type TradeKeep,
  type TradeKeptFor,
  type TradeNeed,
  type TradePartner,
  type TradePartners,
  type TradePicks,
  type TradeProposal,
  type TradeResult,
  type TradeSide,
} from '@zuninja/core';
import {
  ArrowLeftRight,
  Building2,
  Check,
  ChevronRight,
  CircleAlert,
  Gem,
  Handshake,
  Heart,
  History,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  SquareTerminal,
  Store,
  Tag,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchPartners, fetchTrade, PlanError } from '../lib/api';
import { RARITY_LABEL, RARITY_TINT, SHINY_NAME } from '../lib/game';
import type { Settings } from '../lib/settings';
import { load, save } from '../lib/storage';
import { CardChip } from './CardChip';
import { CopyButton } from './CopyButton';

const PARTNERS_KEY = 'zuninja:trade-partners';
const NO_PICKS: { receive: TradePicks; give: TradePicks } = { receive: {}, give: {} };
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

/** Ce qu'une carte déjà possédée apporte encore au receveur, ou rien (`none`). */
const NEED_SHORT: Record<Exclude<TradeNeed, 'missing'>, string> = {
  constellation: 'constellation',
  fusion: 'fusion',
  enchant: 'à enchanter',
  none: 'sans usage',
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

/** Règle du jeu que l'échange ne respecte pas encore. */
function issueText(issue: TradeIssue): string {
  if (issue.kind === 'unmatched')
    return `${plural(issue.cards, 'carte')} sans contrepartie de même rareté et brillance : le jeu exige les mêmes des deux côtés.`;
  return `${issue.side === 'give' ? 'Tu donnes' : 'Tu reçois'} ${plural(issue.copies, 'carte')} : ${TRADE_MAX_CARDS} au plus de chaque côté.`;
}

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
  // Recherche des meilleurs partenaires : repliée quand on ouvre l'échange avec l'un d'eux.
  const [finder, setFinder] = useState<TradePartners | null>(null);
  const [finding, setFinding] = useState(false);
  const [finderError, setFinderError] = useState<string | null>(null);
  const [finderOpen, setFinderOpen] = useState(true);
  const search = useRef(0);
  const suggestions = recent.filter((r) => r.toLowerCase() !== me.toLowerCase());

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

  const findPartners = async (fresh = false) => {
    const id = ++search.current;
    setFinding(true);
    setFinderError(null);
    setFinderOpen(true);
    try {
      const result = await fetchPartners({
        me,
        ruleSet,
        keep: { me: keepMe, other: keepOther },
        names: suggestions,
        fresh,
      });
      if (id === search.current) setFinder(result);
    } catch (e) {
      if (id !== search.current) return;
      setFinder(null);
      setFinderError(e instanceof PlanError ? e.message : 'Une erreur inattendue est survenue.');
    } finally {
      if (id === search.current) setFinding(false);
    }
  };

  /** Ouvre l'échange avec un joueur, avec des cartes déjà choisies (le meilleur échange). */
  const choose = (name: string, picks = NO_PICKS) => {
    if (name.toLowerCase() === me.toLowerCase()) {
      setError('Choisis un autre joueur que toi pour échanger.');
      return;
    }
    setReceive(picks.receive);
    setGive(picks.give);
    setFilter('');
    if (name.toLowerCase() === partner.toLowerCase()) return;
    setTrade(null);
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
          finding={finding}
          suggestions={suggestions}
          onSubmit={(name) => choose(name)}
          onFind={() => void findPartners()}
          onRefresh={
            trade && partner
              ? () => void compare(partner, { me: keepMe, other: keepOther }, true)
              : null
          }
        />

        {(finder || finding || finderError) && (
          <PartnerFinder
            result={finder}
            loading={finding}
            error={finderError}
            open={finderOpen}
            current={partner}
            onToggle={() => setFinderOpen(!finderOpen)}
            onRefresh={() => void findPartners(true)}
            onOpen={(p) => {
              setFinderOpen(false);
              choose(p.player.name, p.picks);
            }}
          />
        )}

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
        {!trade && !loading && !error && !partner && !finder && !finding && (
          <p className="card px-4 py-8 text-center text-sm text-white/65">
            Entre le pseudo d'un autre joueur : tu verras les cartes que chacun peut donner à
            l'autre sans rien perdre, et une proposition d'échange équilibrée. Ou cherche les
            meilleurs partenaires : les joueurs qui ont en double les cartes qui te manquent, et à
            qui les tiennes en trop serviraient.
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
              extra={trade.other.extra.filter(visible)}
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
              extra={trade.me.extra.filter(visible)}
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
  finding,
  suggestions,
  onSubmit,
  onFind,
  onRefresh,
}: {
  initial: string;
  loading: boolean;
  /** Recherche des meilleurs partenaires en cours. */
  finding: boolean;
  suggestions: string[];
  onSubmit: (name: string) => void;
  onFind: () => void;
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
      <button
        type="button"
        className="btn-ghost h-9 w-full justify-center sm:w-auto"
        onClick={onFind}
        disabled={finding}
        title={`Compare ta collection avec celles des plus gros possesseurs des cartes que tu cherches, de ta corporation, du marché et de tes échanges récents (${TRADE_PARTNERS_LIMIT} joueurs au plus)`}
      >
        {finding ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Sparkles className="size-4 text-zu-400" />
        )}
        Trouver les meilleurs partenaires
      </button>
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

const PARTNERS_SHOWN = 8;

/** Date d'une annonce du marché, avec l'année : certaines datent de plusieurs années. */
const listingDate = (iso: string) =>
  new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Les meilleurs joueurs avec qui échanger, classés selon les points que le meilleur échange avec
 * chacun te rapporte. Un clic ouvre l'échange, ses cartes déjà choisies.
 */
function PartnerFinder({
  result,
  loading,
  error,
  open,
  current,
  onToggle,
  onRefresh,
  onOpen,
}: {
  result: TradePartners | null;
  loading: boolean;
  error: string | null;
  open: boolean;
  /** Joueur dont l'échange est ouvert. */
  current: string;
  onToggle: () => void;
  onRefresh: () => void;
  onOpen: (partner: TradePartner) => void;
}) {
  const [all, setAll] = useState(false);
  const partners = result?.partners ?? [];
  const shown = all ? partners : partners.slice(0, PARTNERS_SHOWN);
  const summary = loading
    ? 'Recherche en cours…'
    : result
      ? `${plural(partners.length, 'partenaire')} sur ${plural(result.checked, 'joueur')} comparé${result.checked > 1 ? 's' : ''}`
      : '';
  return (
    <section className="card overflow-hidden" aria-busy={loading}>
      <header className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-3">
        <Sparkles className="size-4 shrink-0 text-zu-400" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-bold tracking-wide uppercase">Meilleurs partenaires</h2>
          {summary && <p className="text-xs text-white/60">{summary}</p>}
        </div>
        {result && !loading && (
          <button
            type="button"
            className="btn-ghost h-9 px-2.5"
            onClick={onRefresh}
            title="Relancer la recherche avec les collections à jour"
            aria-label="Relancer la recherche"
          >
            <RefreshCw className="size-4" />
          </button>
        )}
        <button
          type="button"
          className="btn-ghost h-9 px-2.5"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? 'Replier les partenaires' : 'Afficher les partenaires'}
        >
          <ChevronRight className={`size-4 transition ${open ? 'rotate-90' : ''}`} />
        </button>
      </header>
      {open && (
        <>
          {error && (
            <p className="flex items-center gap-2 px-4 py-3 text-sm" role="alert">
              <CircleAlert className="size-4 shrink-0 text-danger" />
              {error}
            </p>
          )}
          {loading && (
            <div className="space-y-3 px-4 py-3">
              <p className="text-xs text-white/60">
                Recherche des plus gros possesseurs des cartes que tu cherches, puis comparaison de
                ta collection avec la leur, celles de ta corporation, du marché et de tes échanges
                récents ({TRADE_PARTNERS_LIMIT} joueurs au plus) : quelques secondes.
              </p>
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex animate-pulse items-center gap-3">
                  <div className="size-9 rounded-full bg-white/[0.07]" />
                  <div className="h-4 flex-1 rounded bg-white/[0.07]" />
                </div>
              ))}
            </div>
          )}
          {result && !loading && (
            <>
              {result.me.tradesLeft === 0 && (
                <p className="flex gap-2 px-4 pt-3 text-xs text-gold">
                  <CircleAlert className="size-4 shrink-0" />
                  Tu n'as plus d'échange aujourd'hui : ces échanges seront pour demain.
                </p>
              )}
              {partners.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-white/60">
                  Aucun des {plural(result.checked, 'joueur')} comparés n'a de quoi échanger avec
                  toi sans que l'un de vous perde une carte utile.
                </p>
              ) : (
                <ol className="divide-y divide-white/[0.06]">
                  {shown.map((p, i) => (
                    <PartnerRow
                      key={p.player.name}
                      partner={p}
                      rank={i + 1}
                      current={p.player.name.toLowerCase() === current.toLowerCase()}
                      onOpen={() => onOpen(p)}
                    />
                  ))}
                </ol>
              )}
              {partners.length > shown.length && (
                <div className="border-t border-white/[0.06] px-4 py-2">
                  <button
                    type="button"
                    className="btn-ghost h-8 px-2 text-xs"
                    onClick={() => setAll(true)}
                  >
                    Voir les {partners.length - shown.length} autres
                  </button>
                </div>
              )}
              <p className="border-t border-white/[0.06] px-4 py-3 text-xs text-white/55">
                Classés selon les points de collection que le meilleur échange te rapporte : les
                cartes en trop de chacun dont l'autre a l'usage, de même rareté et brillance des
                deux côtés, {TRADE_MAX_CARDS} au plus. Ont été comparés les plus gros possesseurs de{' '}
                {plural(result.searchedCards, 'carte')} que tu cherches, ta corporation, les
                annonces du marché et tes échanges récents.
                {result.failed.length > 0 &&
                  ` Introuvables : ${result.failed.join(', ')} (pseudo changé ?).`}
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** Un partenaire : ce que le meilleur échange avec lui te rapporte, et pourquoi il est proposé. */
function PartnerRow({
  partner: p,
  rank,
  current,
  onOpen,
}: {
  partner: TradePartner;
  rank: number;
  /** Son échange est celui ouvert. */
  current: boolean;
  onOpen: () => void;
}) {
  const chip = 'chip text-white/70';
  return (
    <li
      className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center ${current ? 'bg-zu-500/10' : ''}`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="w-4 shrink-0 pt-2 text-right font-mono text-xs text-white/45">{rank}</span>
        <PlayerAvatar src={p.player.avatar} name={p.player.displayName} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate font-semibold">{p.player.displayName}</span>
            <span className="text-xs text-white/60">
              tu reçois {plural(p.points.receive, 'pt')} · tu donnes {plural(p.points.give, 'pt')}
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {p.receive.map((c) => (
              <CardChip key={c.key} card={c} />
            ))}
            <span className="text-xs text-white/55">
              contre {plural(p.copies, 'carte')} en trop
              {p.useful.receive > p.receive.length &&
                ` · ${plural(p.useful.receive, 'carte')} utiles en tout`}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 text-xs">
            {p.sources.includes('named') && (
              <span className={chip}>
                <History className="size-3 text-zu-400" />
                Échange récent
              </span>
            )}
            {p.holding > 0 && (
              <span
                className={chip}
                title="Parmi les plus gros possesseurs de cartes que tu cherches, avec des doubles"
              >
                <Gem className="size-3 text-zu-400" />
                {plural(p.holding, 'carte')} que tu cherches en double
              </span>
            )}
            {p.sources.includes('corporation') && (
              <span className={chip}>
                <Building2 className="size-3 text-zu-400" />
                Ta corporation
              </span>
            )}
            {p.listedAt && (
              <span className={chip} title="Annonce sur le marché">
                <Store className="size-3 text-zu-400" />
                Marché · {listingDate(p.listedAt)}
              </span>
            )}
            {p.player.tradesLeft === 0 && (
              <span className="chip text-gold">Plus d'échange aujourd'hui</span>
            )}
          </div>
        </div>
      </div>
      <button
        type="button"
        className={`${current ? 'btn-ghost' : 'btn-primary'} h-9 shrink-0`}
        onClick={onOpen}
      >
        <ArrowLeftRight className="size-4" />
        {current ? 'Choisir ces cartes' : "Voir l'échange"}
      </button>
    </li>
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
  extra,
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
  /** Surplus du donneur dont l'autre n'a pas l'usage. */
  extra: TradeCard[];
  filtered: boolean;
  picked: TradePicks;
  proposal: TradeProposal;
  onToggle: (card: TradeCard) => void;
}) {
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
      <FoldedGroup
        title={owner ? `Cartes que ${owner} garde` : 'Cartes que tu gardes'}
        note={
          owner
            ? `Elles te seraient utiles, mais ${owner} les garde (dernier exemplaire, fusion, enchantement ou constellation) : à demander seulement si c'est d'accord.`
            : "Elles seraient utiles à l'autre, mais tu les gardes (dernier exemplaire, fusion, enchantement ou constellation). Si on te les demande, choisis-les : la proposition dit ce que tu peux demander en échange."
        }
        cards={kept}
        filtered={filtered}
        picked={picked}
        proposal={proposal}
        onToggle={onToggle}
      />
      <FoldedGroup
        title={owner ? `Autres cartes en trop de ${owner}` : 'Tes autres cartes en trop'}
        note={
          owner
            ? `Tu as déjà tout ce qui te sert de celles-ci, mais tu peux les demander quand même.`
            : "L'autre a déjà tout ce qui lui sert de celles-ci, mais tu peux les donner quand même : choisies, elles comptent dans l'échange comme les autres."
        }
        cards={extra}
        filtered={filtered}
        picked={picked}
        proposal={proposal}
        onToggle={onToggle}
      />
    </section>
  );
}

/** Groupe de cartes replié sous une liste (cartes gardées, autres cartes en trop). */
function FoldedGroup({
  title,
  note,
  cards,
  filtered,
  picked,
  proposal,
  onToggle,
}: {
  title: string;
  note: string;
  cards: TradeCard[];
  filtered: boolean;
  picked: TradePicks;
  proposal: TradeProposal;
  onToggle: (card: TradeCard) => void;
}) {
  const [show, setShow] = useState(false);
  // Une recherche l'ouvre aussi : on cherche souvent la carte qu'on nous demande.
  const open = show || (filtered && cards.length > 0);
  if (cards.length === 0) return null;
  return (
    <div className="border-t border-white/[0.06] px-4 py-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setShow(!open)}
        className="label flex items-center gap-1.5 text-white/70 transition hover:text-white"
      >
        <ChevronRight className={`size-3.5 transition ${open ? 'rotate-90' : ''}`} />
        {title}
        <span className="text-white/45 normal-case">· {cards.length}</span>
      </button>
      {open && (
        <>
          <p className="mt-1.5 text-xs text-white/55">{note}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            {cards.map((c) => (
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
    card.need === 'none'
      ? "sans usage pour l'autre"
      : card.need !== 'missing' &&
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
        <span
          className={`mt-0.5 block truncate rounded text-center text-[9px] tracking-wide uppercase ${
            card.need === 'none' ? 'bg-white/10 text-white/55' : 'bg-zu-500/15 text-zu-400'
          }`}
        >
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
  const issues = tradeIssues(proposal);
  const command = tradeCommand(other.name, proposal);
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
          donner » (cherche-les par leur nom). Le jeu exige les mêmes raretés et brillances des deux
          côtés, {TRADE_MAX_CARDS} cartes au plus de chaque côté : en face, une carte de même rareté
          et brillance est ajoutée pour équilibrer l'échange, et la proposition liste toutes celles
          que tu peux demander à la place. La commande /échange est prête dès que l'échange est
          valide.
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
          {issues.length > 0 ? (
            <div className="space-y-1 rounded border border-danger/40 px-3 py-2 text-xs text-danger">
              <p className="flex items-center gap-2 font-semibold">
                <CircleAlert className="size-4 shrink-0" />
                Le jeu refuserait cet échange :
              </p>
              <ul className="list-disc space-y-0.5 pl-8">
                {issues.map((issue) => (
                  <li key={`${issue.kind}:${'side' in issue ? issue.side : ''}`}>
                    {issueText(issue)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="label flex items-center gap-1.5">
                <SquareTerminal className="size-3.5 text-zu-400" />
                Commande d'échange
              </p>
              <code className="surface block px-3 py-2 font-mono text-xs break-words text-white/90">
                {command}
              </code>
              <CopyButton text={command} label="Copier la commande" />
            </div>
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
                    <Alternatives title="Tu peux aussi demander" cards={a.ask} onPick={onAsk} />
                  )}
                  {a.offer.length > 0 && (
                    <Alternatives title="Tu peux aussi proposer" cards={a.offer} onPick={onOffer} />
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
 * Contreparties possibles, de même rareté et brillance : un clic ajoute la carte à l'échange, à la
 * place de celle choisie d'office.
 */
function Alternatives({
  title,
  cards,
  onPick,
}: {
  title: string;
  cards: TradeCard[];
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
                  max={Math.min(c.available, TRADE_MAX_CARDS)}
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
