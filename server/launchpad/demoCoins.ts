// Invented coins for demo mode. Every name here is made up; the first one plays the platform coin.
import { createHash } from 'node:crypto';
import bs58 from 'bs58';

const mint = (seed: string) => bs58.encode(createHash('sha256').update(`holler-demo:${seed}`).digest()).slice(0, 44);

const coins = [
  { name: 'Holler', symbol: 'HOLLER', description: 'The platform coin. A slice of every coin launched here is paid to the people who call this one out.', ageHours: 300 },
  { name: 'Moth Lamp', symbol: 'MOTH', description: 'It goes toward the light. So do the callers.', ageHours: 2 },
  { name: 'Soup Season', symbol: 'SOUP', description: 'Warm, salty, and paid out in USDC.', ageHours: 7 },
  { name: 'Tiny Crane', symbol: 'CRANE', description: 'Lifts small bags very high.', ageHours: 15 },
  { name: 'Gravel', symbol: 'GRVL', description: 'A coin about rocks. Mostly gravel.', ageHours: 26 },
  { name: 'Night Shift', symbol: 'SHIFT', description: 'For the ones calling it out at 4am.', ageHours: 41 },
  { name: 'Paper Boat', symbol: 'BOAT', description: 'Floats until it does not.', ageHours: 63 },
  { name: 'Velvet Goose', symbol: 'GOOSE', description: 'Honks in USDC.', ageHours: 90 },
  { name: 'Lint', symbol: 'LINT', description: 'Found in every pocket.', ageHours: 130 },
] as const;

export const DEMO_COINS = coins.map((c) => ({
  ...c, mint: mint(c.symbol), website: null, twitter: null, telegram: null,
}));
