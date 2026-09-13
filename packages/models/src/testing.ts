import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** The subset of an OpenAI chat completion request the tests inspect. */
export interface ChatCompletionRequest {
  model: string;
  messages: {
    role: string;
    content?: unknown;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
  }[];
  tools?: {
    type: 'function';
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
}

export interface FakeToolCall {
  id?: string;
  name: string;
  /** A JSON string exactly as the server should send it, or an object to stringify. */
  arguments: string | Record<string, unknown>;
}

export interface FakeReply {
  text?: string;
  toolCalls?: FakeToolCall[];
  /** A non-200 status makes the server answer with an OpenAI-style error body. */
  status?: number;
  delayMs?: number;
  completionTokens?: number;
}

export interface FakeOpenAIServer {
  /** Includes `/v1`. */
  baseURL: string;
  requests: ChatCompletionRequest[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

/**
 * A local OpenAI-compatible chat completions server for tests. `reply` receives each request and
 * its zero-based index and decides the response; `GET /v1/models` lists `models`.
 */
export async function startFakeOpenAIServer(
  reply: (request: ChatCompletionRequest, index: number) => FakeReply | Promise<FakeReply>,
  options: { models?: string[] } = {}
): Promise<FakeOpenAIServer> {
  const requests: ChatCompletionRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        sendJson(response, 200, {
          object: 'list',
          data: (options.models ?? []).map((id) => ({ id, object: 'model' })),
        });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        sendJson(response, 404, { error: { message: `No route for ${request.url}` } });
        return;
      }
      const body = JSON.parse(await readBody(request)) as ChatCompletionRequest;
      const index = requests.push(body) - 1;
      const planned = await reply(body, index);
      if (planned.delayMs) await new Promise((resolve) => setTimeout(resolve, planned.delayMs));
      if (planned.status && planned.status !== 200) {
        sendJson(response, planned.status, {
          error: { message: `fake failure ${planned.status}` },
        });
        return;
      }
      const toolCalls = (planned.toolCalls ?? []).map((call, position) => ({
        id: call.id ?? `call_${index}_${position}`,
        type: 'function',
        function: {
          name: call.name,
          arguments:
            typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
        },
      }));
      sendJson(response, 200, {
        id: `chatcmpl-${index}`,
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
            message: {
              role: 'assistant',
              content: planned.text ?? null,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: planned.completionTokens ?? 5,
          total_tokens: 10 + (planned.completionTokens ?? 5),
        },
      });
    })().catch((error: unknown) => {
      sendJson(response, 500, { error: { message: String(error) } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake server has no port');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
