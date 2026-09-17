/**
 * One structured-output call to Anthropic. The schema is passed as a tool the
 * model is forced to call, so the reply is always valid JSON in that shape.
 * Throws when unconfigured or when the API rejects, so callers can fall back.
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
}

export function classifierConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function classifyStructured<T>(opts: {
  model: string;
  system: string;
  user: string;
  schema: JsonSchema;
  maxTokens?: number;
}): Promise<T> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 400,
      system: opts.system,
      tools: [{ name: 'record', description: 'Record the classification.', input_schema: opts.schema }],
      tool_choice: { type: 'tool', name: 'record' },
      messages: [{ role: 'user', content: opts.user }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content: Array<{ type: string; input?: unknown }> };
  const tool = data.content.find(c => c.type === 'tool_use');
  if (!tool) throw new Error('Anthropic reply had no tool_use block');
  return tool.input as T;
}
