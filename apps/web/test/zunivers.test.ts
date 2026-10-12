import { describe, expect, it } from 'vitest';
import { zuniversCardUrl } from '../src/lib/game';

describe('lien vers la fiche ZUnivers', () => {
  it('ouvre la fiche de la carte, sur sa version chroma quand c’est elle', () => {
    expect(zuniversCardUrl({ slug: '3117-trophee-twitch-marbre', shiny: 0 })).toBe(
      'https://zunivers.zerator.com/carte/3117-trophee-twitch-marbre',
    );
    expect(zuniversCardUrl({ slug: '3117-trophee-twitch-marbre', shiny: 1 })).toBe(
      'https://zunivers.zerator.com/carte/3117-trophee-twitch-marbre',
    );
    expect(zuniversCardUrl({ slug: '1009-gnome', shiny: 2 })).toBe(
      'https://zunivers.zerator.com/carte/1009-gnome?mode=chroma',
    );
  });

  it('n’a pas de lien pour une carte inconnue du catalogue', () => {
    expect(zuniversCardUrl({ slug: '', shiny: 0 })).toBeNull();
  });
});
