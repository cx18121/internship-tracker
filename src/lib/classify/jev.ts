/**
 * One call to TypeSafe's System One endpoint. Jev answers typed questions
 * (a Choice from a set, a Noul yes/no probability) over the given state, all
 * in parallel, and returns calibrated probabilities instead of text. Throws
 * when unconfigured or when the API rejects, so callers can fall back.
 */
export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } };

export interface ChoiceAnswer<T extends string = string> { type: 'choice'; choice: T; probabilities: Record<T, number>; confidence: number }
export interface NoulAnswer { type: 'noul'; noul: number }

export function jevConfigured(): boolean {
  return !!process.env.TYPESAFE_API_KEY;
}

export async function askJev<A extends Record<string, ChoiceAnswer | NoulAnswer>>(state: unknown, questions: Record<keyof A, JevQuestion>): Promise<A> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY not set');
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.JEV_MODEL || 'jev-latest', state, questions }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { answers: A }).answers;
}
