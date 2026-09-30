import { ConstraintSheet, type Language } from '@colosseum/schemas';
import { z } from 'zod';
import { type ParseOutcome, parseGoalRules } from './rules';

/**
 * LLM parser over any OpenAI-compatible chat-completions endpoint (OpenRouter, a local Ollama, Anthropic via a
 * gateway). The model only fills the JSON; zod decides. Temperature 0. If the endpoint is not configured or the
 * output fails validation, the rules parser's result is returned with the LLM errors attached.
 * Env: LLM_BASE_URL (e.g. https://openrouter.ai/api/v1), LLM_API_KEY, LLM_MODEL.
 */
export const llmConfigured = () => Boolean(process.env.LLM_BASE_URL && process.env.LLM_MODEL);

const SYSTEM = `You convert a personal financial goal, written in Portuguese or English, into a JSON object with exactly these fields:
language ("pt"|"en"), currency ("BRL"), target ({"kind":"monthly_cashflow","amountBrl":number,"startMonth":"YYYY-MM","endMonth"?:"YYYY-MM"} or {"kind":"balance","amountBrl":number,"byMonth":"YYYY-MM"}),
profile ("income" for monthly cash-flow goals; "accumulation" or "high_risk" for balance goals; high_risk only when the user accepts stock-market/high risk),
horizonMonths (integer), liquidityWindowDays (integer; days within which the user wants to be able to withdraw; default 30 for income, 90 otherwise),
riskBudget ("low"|"medium"|"high"), creditTolerance ("none"|"limited"|"accept"; "accept" only if the user explicitly accepts credit risk), fxStance ("hedge_near_term" unless the user says they accept dollar/FX exposure),
monthlyContributionBrl (optional number), notes (optional string with anything you could not map).
Output only the JSON object. Do not invent amounts. Today is {TODAY}.`;

const Completion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

export async function parseGoalLlm(
  text: string,
  hint?: Language,
  nowMonth?: string,
): Promise<ParseOutcome> {
  const rules = parseGoalRules(text, hint, nowMonth);
  if (!llmConfigured()) return rules;
  const base = (process.env.LLM_BASE_URL as string).replace(/\/$/, '');
  const model = process.env.LLM_MODEL as string;
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.LLM_API_KEY ? { authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: SYSTEM.replace('{TODAY}', new Date().toISOString().slice(0, 10)),
          },
          { role: 'user', content: text },
        ],
      }),
    });
    const body = Completion.parse(await res.json());
    const raw = body.choices[0]?.message.content ?? '';
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const candidate = JSON.parse(jsonText) as Record<string, unknown>;
    const parsed = ConstraintSheet.safeParse(candidate);
    if (parsed.success) return { sheet: parsed.data, candidate, errors: [], method: 'llm', model };
    return {
      ...rules,
      candidate,
      errors: [
        ...parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: `llm: ${i.message}`,
        })),
        ...rules.errors,
      ],
      method: 'llm',
      model,
    };
  } catch (e) {
    return {
      ...rules,
      errors: [
        { path: '', message: `llm unavailable: ${String(e).slice(0, 120)}` },
        ...rules.errors,
      ],
    };
  }
}
