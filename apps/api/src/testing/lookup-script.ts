import type Anthropic from '@anthropic-ai/sdk';

// A scripted model for the conversations' lookups (API-AGENT-LOOKUPS-2), labelled MOCK: it never calls
// a model. Each call reads where the conversation stands, as the API would see it: while lookup rounds
// remain in the script and the call may look up, it asks for that round's lookups (a thinking block
// first, as the Claude 5 family answers); then it answers with the final JSON; a later call that is not
// a lookup round (the repair) answers with the repair JSON, or the final again.

export type ScriptedLookup = { name: string; input: Record<string, unknown> };
export type ModelScript = {
  /** The lookups of each round, in order. */
  lookups?: ScriptedLookup[][];
  /** The answer once the lookups are done. */
  final: unknown;
  /** The answer to a repair call; the final again when absent. */
  repair?: unknown;
};
type Params = {
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  tool_choice?: Anthropic.ToolChoice;
};
export type ScriptedCall = Params & Record<string, unknown>;

const text = (value: unknown) => ({
  stop_reason: 'end_turn' as const,
  content: [
    {
      type: 'text' as const,
      text: typeof value === 'string' ? value : JSON.stringify(value),
      citations: null,
    },
  ] as Anthropic.ContentBlock[],
});

export function scriptedModel(script: ModelScript) {
  const calls: ScriptedCall[] = [];
  /** Every response, as it was returned. */
  const responses: Pick<Anthropic.Message, 'stop_reason' | 'content'>[] = [];
  let answered = false;
  const answer = async (
    params: unknown,
  ): Promise<Pick<Anthropic.Message, 'stop_reason' | 'content'>> => {
    const call = params as ScriptedCall;
    calls.push(call);
    const last = call.messages.at(-1);
    const afterLookup =
      Array.isArray(last?.content) && last.content.some((block) => block.type === 'tool_result');
    const rounds = call.messages.filter(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'tool_result'),
    ).length;
    const lookups = script.lookups ?? [];
    const mayLook = Boolean(call.tools?.length) && call.tool_choice?.type !== 'none';
    if (answered && !afterLookup) return text(script.repair ?? script.final);
    if (mayLook && rounds < lookups.length && (rounds === 0 || afterLookup)) {
      const uses = (lookups[rounds] ?? []).map((lookup, at) => ({
        type: 'tool_use' as const,
        id: `toolu_mock_${rounds}_${at}`,
        name: lookup.name,
        input: lookup.input,
        caller: { type: 'direct' as const },
      }));
      return {
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'MOCK: which figures answer this', signature: 'mock-sig' },
          ...uses,
        ] as unknown as Anthropic.ContentBlock[],
      };
    }
    answered = true;
    return text(script.final);
  };
  /** The client options each call was made with: the time it was given. */
  const options: Array<{ timeout?: number } | undefined> = [];
  const create = async (params: unknown, call?: { timeout?: number }) => {
    options.push(call);
    const response = await answer(params);
    responses.push(response);
    return response;
  };
  return { create, calls, responses, options };
}

/** The tool results of a call's last message, read back. */
export function toolResults(call: ScriptedCall | undefined) {
  const last = call?.messages.at(-1);
  if (!Array.isArray(last?.content)) return [];
  return last.content.flatMap((block) =>
    block.type === 'tool_result'
      ? [
          {
            id: block.tool_use_id,
            error: block.is_error === true,
            json: JSON.parse(String(block.content)),
          },
        ]
      : [],
  );
}
