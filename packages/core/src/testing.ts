import type {
  LoreHit,
  LoreIndex,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from './model';

export type ScriptedResponse = ModelResponse | { throw: string };

/** Replays canned responses per seat, in order. Records every request it receives. */
export class ScriptedModelClient implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly queues: Map<string, ScriptedResponse[]>;

  constructor(script: Record<string, readonly ScriptedResponse[]>) {
    this.queues = new Map(
      Object.entries(script).map(([seat, responses]) => [seat, [...responses]])
    );
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const next = this.queues.get(request.seat)?.shift();
    if (!next) throw new Error(`ScriptedModelClient: no response left for seat "${request.seat}"`);
    if ('throw' in next) throw new Error(next.throw);
    return next;
  }

  remaining(seat: string): number {
    return this.queues.get(seat)?.length ?? 0;
  }
}

let callCounter = 0;

export function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  callCounter++;
  return { id: `call-${callCounter}`, name, args };
}

export function respond(...calls: ToolCall[]): ModelResponse {
  return { text: '', toolCalls: calls };
}

/** Keyword-overlap lore search over a fixed list of chunks, for tests and fixtures. */
export class StaticLoreIndex implements LoreIndex {
  constructor(private readonly chunks: readonly LoreHit[]) {}

  async search(query: string, limit: number): Promise<LoreHit[]> {
    const words = query
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 2);
    if (words.length === 0) return [];
    return this.chunks
      .map((chunk) => {
        const haystack = `${chunk.title} ${chunk.text}`.toLowerCase();
        const matches = words.filter((word) => haystack.includes(word)).length;
        return { ...chunk, score: matches / words.length };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
