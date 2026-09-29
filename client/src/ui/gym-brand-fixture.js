// Catalogue fixture mirroring GET /api/gyms `presentation` (F-7). Test-only.
const colours = { ink: '#111111', inkHover: '#222222', tint: '#333333', on: '#ffffff' };
export const CATALOGUE = [
  { id: 'psycle-london', presentation: { shortName: 'Psycle', plate: '#212121', light: colours, dark: colours, displayAliases: {},
    wordmark: { text: 'PSYCLE', full: { src: '/gyms/psycle-london.avif' }, compact: { src: '/gyms/psycle-london-half.avif' }, mark: { src: '/gyms/psycle-london-small.avif' } } } },
  { id: 'jab-boxing', presentation: { shortName: 'JAB', plate: '#6C1F20', light: colours, dark: colours, displayAliases: { studios: { 'recovery 2.0': 'Recovery' } },
    wordmark: { text: 'JAB', full: { src: '/gyms/jab-boxing.svg' }, compact: { src: '/gyms/jab-boxing.svg' }, mark: { src: '/gyms/jab-boxing-mark.svg?v=3' } } } },
  { id: 'third-gym', presentation: { shortName: 'Third', plate: '#0a7a3c', light: colours, dark: colours, displayAliases: {},
    wordmark: { text: 'THIRD' } } },
];
