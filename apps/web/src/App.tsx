import {
  DEFAULT_STRATEGY,
  isStrategy,
  type PlanResult,
  type RuleSet,
  type StrategyId,
} from '@zuninja/core';
import { CircleAlert, Clock, Crown, RefreshCw, Sparkles, Swords, Target, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Collection } from './components/Collection';
import { Header, Logo } from './components/Header';
import { PlanList } from './components/PlanList';
import { SearchForm } from './components/SearchForm';
import { SettingsDrawer } from './components/SettingsDrawer';
import { Summary } from './components/Summary';
import { fetchPlan, PlanError, STANDALONE } from './lib/api';
import { fmt, fmt1, formatTime, signed } from './lib/format';
import { loadSettings, saveSettings, withStrategy, type Settings } from './lib/settings';
import { load, save } from './lib/storage';

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; plan: PlanResult };
type Tab = 'plan' | 'collection';

const RECENT_KEY = 'zuninja:recent';

function readUrl(): { user: string; ruleSet: RuleSet | null; strategy: StrategyId | null } {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode')?.toUpperCase();
  const strategy = params.get('strategy');
  return {
    user: params.get('u')?.trim() ?? '',
    ruleSet: mode === 'HARDCORE' || mode === 'NORMAL' ? mode : null,
    strategy: isStrategy(strategy) ? strategy : null,
  };
}

function writeUrl(user: string, s: Settings) {
  const params = new URLSearchParams();
  if (user) params.set('u', user);
  if (user && s.ruleSet === 'HARDCORE') params.set('mode', 'hardcore');
  if (user && s.strategy !== DEFAULT_STRATEGY) params.set('strategy', s.strategy);
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
}

export function App() {
  const initial = useRef(readUrl());
  const [settings, setSettings] = useState<Settings>(() => {
    // Un lien partagé (?mode=, ?strategy=) l'emporte sur les réglages enregistrés.
    let s = loadSettings();
    if (initial.current.ruleSet) s = { ...s, ruleSet: initial.current.ruleSet };
    if (initial.current.strategy) s = withStrategy(s, initial.current.strategy);
    return s;
  });
  const [user, setUser] = useState(initial.current.user);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [tab, setTab] = useState<Tab>('plan');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => load(RECENT_KEY, []));
  const [tracked, setTracked] = useState<string[]>([]);
  const request = useRef(0);

  const run = useCallback(async (name: string, s: Settings, fresh = false) => {
    const id = ++request.current;
    setStatus({ kind: 'loading' });
    writeUrl(name, s);
    try {
      const plan = await fetchPlan(name, s, fresh);
      if (id !== request.current) return;
      setStatus({ kind: 'done', plan });
      document.title = `${plan.player.displayName} · ZUnivers Ninja`;
      setRecent((r) => {
        const next = [
          plan.player.name,
          ...r.filter((x) => x.toLowerCase() !== plan.player.name.toLowerCase()),
        ].slice(0, 6);
        save(RECENT_KEY, next);
        return next;
      });
    } catch (error) {
      if (id !== request.current) return;
      setStatus({
        kind: 'error',
        message: error instanceof PlanError ? error.message : 'Une erreur inattendue est survenue.',
      });
    }
  }, []);

  // Premier chargement : pseudo dans l'URL.
  useEffect(() => {
    if (initial.current.user) void run(initial.current.user, settings);
    if (!STANDALONE) {
      fetch('./api/config')
        .then((r) => (r.ok ? r.json() : null))
        .then((c: { users?: string[] } | null) => setTracked(c?.users ?? []))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Réglages modifiés : on les garde et on recalcule (avec un léger délai pour les curseurs).
  const firstSettings = useRef(true);
  useEffect(() => {
    saveSettings(settings);
    if (firstSettings.current) {
      firstSettings.current = false;
      return;
    }
    if (!user) return;
    const timer = setTimeout(() => void run(user, settings), 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const search = (name: string) => {
    setUser(name);
    setTab('plan');
    void run(name, settings);
  };

  const goHome = () => {
    request.current++;
    setUser('');
    setStatus({ kind: 'idle' });
    writeUrl('', settings);
    document.title = 'ZUnivers Ninja';
  };

  const plan = status.kind === 'done' ? status.plan : null;
  const suggestions = [...new Set([...tracked, ...recent])].slice(0, 8);

  return (
    <div className="flex min-h-dvh flex-col">
      <Header
        ruleSet={settings.ruleSet}
        onRuleSet={(ruleSet) => setSettings((s) => ({ ...s, ruleSet }))}
        onOpenSettings={() => setSettingsOpen(true)}
        onHome={goHome}
      />

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-9">
        {!user ? (
          <Landing onSearch={search} suggestions={suggestions} />
        ) : (
          <div className="space-y-5">
            <div className="max-w-xl">
              <SearchForm
                key={user}
                initial={user}
                loading={status.kind === 'loading'}
                onSearch={search}
              />
            </div>

            {status.kind === 'loading' && <LoadingState />}
            {status.kind === 'error' && (
              <ErrorState message={status.message} onRetry={() => void run(user, settings, true)} />
            )}
            {plan && (
              <>
                <PlayerBanner
                  plan={plan}
                  loading={false}
                  onRefresh={() => void run(user, settings, true)}
                />
                {plan.stats.timedOut && (
                  <p className="surface flex items-center gap-2 border-l-2 border-zu-500 px-3 py-2 text-sm">
                    <Clock className="size-4 shrink-0 text-zu-400" />
                    Calcul écourté : la limite de temps du serveur a été atteinte, la fin du plan a
                    été calculée plus simplement. Réduis la largeur du faisceau ou la ramification
                    dans les réglages pour un plan entièrement optimisé.
                  </p>
                )}
                <div>
                  <div className="flex items-end gap-1.5 px-2" role="tablist">
                    {(
                      [
                        ['plan', 'Plan'],
                        ['collection', 'Collection'],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={tab === key}
                        onClick={() => setTab(key)}
                        className={`rounded-t px-5 text-sm tracking-[0.06em] uppercase transition ${
                          tab === key
                            ? 'h-12 bg-ink-700 font-semibold text-white'
                            : 'h-10 bg-ink-800/85 text-white/65 hover:text-white'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="zu-divider" />
                </div>
                <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
                  <div className="min-w-0">
                    {tab === 'plan' ? <PlanList plan={plan} /> : <Collection plan={plan} />}
                  </div>
                  <Summary plan={plan} />
                </div>
              </>
            )}
          </div>
        )}
      </main>

      <Footer plan={plan} />
      <SettingsDrawer
        open={settingsOpen}
        settings={settings}
        onChange={setSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

function Landing({
  onSearch,
  suggestions,
}: {
  onSearch: (u: string) => void;
  suggestions: string[];
}) {
  const features = [
    {
      icon: Target,
      title: 'Plan optimal',
      text: "Recherche en faisceau qui maximise tes points de collection, au lieu d'une simple liste de règles.",
    },
    {
      icon: Swords,
      title: 'Toutes les mécaniques',
      text: 'Journa, bonus, recyclage, forge, fusions, constellations, invocations, Vortex, évolution et défis.',
    },
    {
      icon: Zap,
      title: 'Copier-coller',
      text: 'Chaque étape donne la commande Discord exacte, dans le bon ordre.',
    },
    {
      icon: Sparkles,
      title: 'Notifications',
      text: 'Auto-hébergé avec Docker : reçois ton plan sur Discord dès qu’il change.',
    },
  ];
  return (
    <div className="pt-6 sm:pt-12">
      <section className="max-w-3xl">
        <h1 className="text-4xl leading-tight font-medium sm:text-6xl">
          Ton prochain coup <span className="text-chroma font-bold">ZUnivers</span>, calculé pour
          toi.
        </h1>
        <p className="mt-5 max-w-xl text-lg text-white/80">
          Entre ton pseudo Discord : ZUnivers Ninja analyse ta collection et te donne la meilleure
          suite de commandes pour progresser aujourd'hui.
        </p>
        <div className="mt-8 max-w-xl">
          <SearchForm loading={false} onSearch={onSearch} size="lg" />
        </div>
        {suggestions.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                className="chip transition hover:bg-zu-500/20 hover:text-white"
                onClick={() => onSearch(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="mt-14 ml-auto max-w-md text-right">
        <h2 className="text-3xl font-medium">Découvre le jeu !</h2>
        <p className="mt-3 text-white/80">
          Nouveau sur ZUnivers ? Le guide officiel explique comment bien débuter.
        </p>
        <a
          className="btn-primary mt-4"
          href="https://zunivers.zerator.com/guide"
          target="_blank"
          rel="noreferrer"
        >
          Lire le guide
        </a>
      </section>

      <div className="zu-divider mt-14" />
      <h2 className="zu-heading mt-12">Comment ça marche</h2>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {features.map(({ icon: Icon, title, text }) => (
          <div key={title} className="card p-5">
            <span className="grid size-10 place-items-center rounded bg-zu-500/15">
              <Icon className="size-5 text-zu-400" />
            </span>
            <p className="mt-4 font-semibold tracking-wide uppercase">{title}</p>
            <p className="mt-1.5 text-sm text-white/65">{text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlayerBanner({
  plan,
  onRefresh,
  loading,
}: {
  plan: PlanResult;
  onRefresh: () => void;
  loading: boolean;
}) {
  const tiles = [
    { label: 'Points gagnés', value: signed(plan.gain.points), accent: plan.gain.points > 0 },
    {
      label: 'Gain espéré',
      value: plan.gain.expected > 0.05 ? `≈ +${fmt1(plan.gain.expected)}` : '—',
    },
    { label: 'Commandes', value: fmt(plan.commands.length) },
    { label: 'Points de collection', value: fmt(plan.after.points) },
  ];
  return (
    <section className="card animate-fade-up p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar src={plan.player.avatar} name={plan.player.displayName} />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 truncate text-2xl font-extrabold">
            {plan.player.displayName}
            {plan.player.subscribed && (
              <Crown className="size-5 text-gold" aria-label="Abonné premium" />
            )}
          </h1>
          <p className="truncate text-sm text-white/60">
            @{plan.player.name}
            {plan.player.corporation && <> · {plan.player.corporation}</>}
            {plan.strategy && (
              <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-white/80 uppercase">
                {plan.strategy.label}
              </span>
            )}
            {plan.ruleSet === 'HARDCORE' && (
              <span className="ml-2 rounded bg-danger px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-white uppercase">
                Hardcore
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-white/60">
          <Clock className="size-3.5" />
          {formatTime(plan.generatedAt)}
          <button
            type="button"
            className="btn-ghost px-2.5"
            onClick={onRefresh}
            disabled={loading}
            title="Recalculer avec des données fraîches"
          >
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Actualiser</span>
          </button>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="surface px-3 py-2.5">
            <dt className="label text-[11px]">{t.label}</dt>
            <dd
              className={`mt-0.5 font-mono text-lg font-semibold tabular-nums ${t.accent ? 'text-zu-400' : ''}`}
            >
              {t.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setFailed(true)}
        className="size-16 rounded-full object-cover ring-2 ring-zu-500"
      />
    );
  }
  return (
    <div className="grid size-16 place-items-center rounded-full bg-zu-500 text-2xl font-bold text-white">
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function LoadingState() {
  return (
    <div
      className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]"
      aria-busy="true"
      aria-label="Calcul du plan"
    >
      <div className="card space-y-4 p-4">
        <p className="text-sm text-white/60">
          Analyse de la collection et recherche du meilleur plan…
        </p>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex animate-pulse gap-3">
            <div className="size-9 rounded bg-white/[0.07]" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/3 rounded bg-white/[0.07]" />
              <div className="h-7 rounded bg-white/[0.07]" />
            </div>
          </div>
        ))}
      </div>
      <div className="card h-64 animate-pulse" />
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-12 text-center" role="alert">
      <CircleAlert className="size-9 text-danger" />
      <p className="max-w-md font-medium">{message}</p>
      <button type="button" className="btn-ghost" onClick={onRetry}>
        <RefreshCw className="size-4" />
        Réessayer
      </button>
    </div>
  );
}

function Footer({ plan }: { plan: PlanResult | null }) {
  return (
    <footer className="mt-12 flex flex-col items-center gap-4 px-4 pt-10 pb-8 text-center text-sm">
      <Logo className="size-12" />
      <p>
        <a
          className="underline underline-offset-2 hover:text-zu-400"
          href="https://github.com/LightD31/ZUnivers-Ninja"
          target="_blank"
          rel="noreferrer"
        >
          Code source
        </a>{' '}
        —{' '}
        <a
          className="underline underline-offset-2 hover:text-zu-400"
          href="https://zunivers.zerator.com/guide"
          target="_blank"
          rel="noreferrer"
        >
          Guide ZUnivers
        </a>
      </p>
      <p className="font-medium">Projet communautaire, non affilié à ZUnivers.</p>
      {plan && (
        <p className="font-mono text-xs text-white/35">
          {fmt(plan.stats.explored)} états explorés en {fmt(plan.stats.durationMs)} ms · faisceau{' '}
          {plan.stats.beamWidth}
        </p>
      )}
    </footer>
  );
}
