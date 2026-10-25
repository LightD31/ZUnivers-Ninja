import { DEFAULT_TRADE_KEEP, type TradeCard } from '@zuninja/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, withStrategy, type Settings } from '../src/lib/settings';
import {
  cardsToLink,
  linkQuery,
  linkUrl,
  partnerView,
  picksFromLink,
  picksToLink,
  readLink,
  readSharedTrade,
  sharedFromTrade,
  sharedTradeQuery,
  sideView,
  type SharedTradeLink,
  type View,
} from '../src/lib/share';

const custom: Settings = {
  ...withStrategy({ ...DEFAULT_SETTINGS, ruleSet: 'HARDCORE' }, 'vortex'),
  keepExtra: 2,
  horizon: true,
  horizonDiscount: 0.75,
  skip: ['recycle', 'invoke'],
  weights: { ...withStrategy(DEFAULT_SETTINGS, 'vortex').weights, balance: 0.0035 },
};

const view: View = {
  user: 'alice',
  ruleSet: 'HARDCORE',
  settings: custom,
  tab: 'collection',
  trade: {
    partner: 'bob',
    keep: { me: { golden: false, goldenFusions: true, constellation: true }, other: null },
    picks: {
      receive: [
        { identifier: 2010, shiny: 2, count: 1 },
        { identifier: 1001, shiny: 2, count: 2 },
      ],
      give: [{ identifier: 2014, shiny: 1, count: 1 }],
    },
  },
};

describe('lien d’une page', () => {
  it('reproduit exactement la page : réglages, onglet, échange et cartes choisies', () => {
    const query = linkQuery(view);
    expect(readLink(`?${query}`)).toEqual(view);
    // Lisible : les listes gardent leurs virgules, les cartes la notation du jeu.
    expect(query).toContain('skip=recycle,invoke');
    expect(query).toContain('take=2010c,1001cx2');
    expect(query).toContain('give=2014d');
    expect(linkUrl(view, 'https://ninja.example/')).toBe(`https://ninja.example/?${query}`);
  });

  it('omet ce qui est implicite : préréglage de la stratégie, onglet, réserves par défaut', () => {
    const plain: View = {
      user: 'alice',
      ruleSet: 'NORMAL',
      settings: DEFAULT_SETTINGS,
      tab: 'plan',
      trade: null,
    };
    expect(linkQuery(plain)).toBe('u=alice&strategy=equilibre');
    const trading: View = {
      ...plain,
      tab: 'trade',
      trade: { partner: 'bob', keep: { me: null, other: null }, picks: { receive: [], give: [] } },
    };
    expect(linkQuery(trading)).toBe('u=alice&strategy=equilibre&with=bob');
    expect(linkQuery({ ...trading, tab: 'achievements' })).toContain('tab=achievements&with=bob');
    expect(linkQuery({ ...plain, user: '' })).toBe('');
  });

  it('laisse ses propres réglages au visiteur d’un lien sans stratégie (anciens liens)', () => {
    expect(readLink('?u=alice')).toEqual({
      user: 'alice',
      ruleSet: null,
      settings: null,
      tab: 'plan',
      trade: null,
    });
    expect(readLink('?u=alice&mode=hardcore&keepExtra=3')).toMatchObject({
      ruleSet: 'HARDCORE',
      settings: null,
    });
    // Avec la stratégie, ce que le lien ne dit pas vaut son préréglage.
    expect(readLink('?u=alice&strategy=equilibre').settings).toEqual(DEFAULT_SETTINGS);
  });

  it('ouvre l’onglet Échanges avec un partenaire, et ignore ce qu’il ne comprend pas', () => {
    expect(readLink('?u=a&with=b').tab).toBe('trade');
    expect(readLink('?u=a&with=b&tab=plan').tab).toBe('plan');
    expect(readLink('?u=a&tab=yolo').tab).toBe('plan');
    expect(readLink('?u=a&with=b&take=2010c,abc,1001x0,3001dx3&keep=').trade).toEqual({
      partner: 'b',
      keep: { me: { golden: false, goldenFusions: false, constellation: false }, other: null },
      picks: {
        receive: [
          { identifier: 2010, shiny: 2, count: 1 },
          { identifier: 1001, shiny: 0, count: 1 },
          { identifier: 3001, shiny: 1, count: 3 },
        ],
        give: [],
      },
    });
  });
});

describe('cartes choisies d’un lien', () => {
  const card = (key: string, identifier: number, shiny: 0 | 1 | 2) =>
    ({ key, identifier, shiny }) as TradeCard;
  const cards = [card('casquette:1', 2009, 1), card('flechettes:2', 1001, 2)];

  it('reprennent les cartes d’une proposition avec leurs exemplaires', () => {
    expect(cardsToLink([{ ...cards[0]!, count: 2 }])).toEqual([
      { identifier: 2009, shiny: 1, count: 2 },
    ]);
  });

  it('se retrouvent parmi les cartes de l’échange, les autres sont ignorées', () => {
    expect(picksToLink(cards, { 'casquette:1': 2, 'inconnue:0': 1 })).toEqual([
      { identifier: 2009, shiny: 1, count: 2 },
    ]);
    expect(
      picksFromLink(cards, [
        { identifier: 1001, shiny: 2, count: 1 },
        { identifier: 1001, shiny: 0, count: 1 },
        { identifier: 9999, shiny: 0, count: 1 },
      ]),
    ).toEqual({ 'flechettes:2': 1 });
  });
});

describe('lien pour l’autre joueur', () => {
  it('ouvre le même échange de son côté, avec ses réglages à lui', () => {
    const theirs = partnerView('alice', view.trade!, custom);
    expect(theirs).toEqual({
      user: 'bob',
      ruleSet: null,
      settings: null,
      tab: 'trade',
      trade: {
        partner: 'alice',
        // Ma réserve devient la sienne en face ; la sienne, par défaut, est écrite en entier.
        keep: { me: DEFAULT_TRADE_KEEP, other: view.trade!.keep.me },
        picks: { receive: view.trade!.picks.give, give: view.trade!.picks.receive },
      },
    });
    const query = linkQuery(theirs);
    expect(query).not.toContain('strategy');
    expect(readLink(`?${query}`)).toEqual(theirs);
  });
});

describe('page d’un échange', () => {
  const shared: SharedTradeLink = {
    players: ['bob', 'Alice'],
    gives: [
      [{ identifier: 2014, shiny: 1, count: 1 }],
      [
        { identifier: 2010, shiny: 2, count: 1 },
        { identifier: 1001, shiny: 2, count: 2 },
      ],
    ],
    keep: [{ golden: false, goldenFusions: true, constellation: true }, null],
  };

  it('a le même lien, quel que soit celui qui le partage', () => {
    const query = sharedTradeQuery(shared);
    expect(query).toBe('trade=Alice,bob&a=2010c,1001cx2&b=2014d&kb=goldenFusions,constellation');
    const swapped: SharedTradeLink = {
      players: ['Alice', 'bob'],
      gives: [shared.gives[1], shared.gives[0]],
      keep: [shared.keep[1], shared.keep[0]],
    };
    expect(sharedTradeQuery(swapped)).toBe(query);
    expect(readSharedTrade(`?${query}`)).toEqual(swapped);
  });

  it('n’existe qu’entre deux joueurs différents', () => {
    expect(readSharedTrade('?u=alice')).toBeNull();
    expect(readSharedTrade('?trade=alice')).toBeNull();
    expect(readSharedTrade('?trade=alice,ALICE')).toBeNull();
    expect(readSharedTrade('?trade=alice,bob,carol')).toBeNull();
    expect(readSharedTrade('?trade=alice,bob')).toEqual({
      players: ['alice', 'bob'],
      gives: [[], []],
      keep: [null, null],
    });
  });

  it('reprend l’échange en cours, et l’ouvre du côté de chacun', () => {
    const trade = view.trade!;
    const fromMe = sharedFromTrade('alice', trade, custom);
    expect(fromMe).toEqual({
      players: ['alice', 'bob'],
      gives: [trade.picks.give, trade.picks.receive],
      keep: [trade.keep.me, null],
    });
    expect(sideView(fromMe, 0)).toMatchObject({
      user: 'alice',
      settings: null,
      trade: { partner: 'bob', picks: trade.picks, keep: { me: trade.keep.me } },
    });
    expect(sideView(fromMe, 1)).toEqual(partnerView('alice', trade, custom));
  });
});
