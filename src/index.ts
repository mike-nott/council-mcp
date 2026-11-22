// council-mcp — MCP server (Streamable HTTP) that puts a prompt to a council of
// frontier models. The transport is web-mcp's, hand-written and dependency-free.
//
// Deliberately STATELESS at the protocol level: no MCP sessions. The bearer
// token is the only thing that grants access, so a session id would add no
// security, and requiring one silently breaks clients that don't echo the
// header back. (A council run does have state, but it lives in a Durable
// Object reached by its ticket, not in an MCP session.)
//
// All errors are HTTP 200 JSON-RPC error bodies.

import { authenticateRequest } from './auth';
import type { Env } from './env';
import { MCP_ERROR_CODES, rpcError } from './mcp/errors';
import { handleInitialize, handleToolsList, validateToolCall } from './mcp/handlers';
import type { JsonRpcRequest, JsonRpcResponse } from './mcp/types';
import { availableMembers } from './models';
import { CouncilSession } from './session';
import { runAskCouncil, runCollectCouncil, waitSeconds } from './tools';

// The Durable Object the binding in wrangler.toml points at.
export { CouncilSession };

// Wildcard is safe: CORS is not the access control here — the bearer token is,
// and a browser cannot attach it without the user configuring the client.
// Without this, any client whose HTTP layer runs in a browser engine (Electron
// or Tauri renderers) fails its preflight before the real request is ever sent.
const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers':
		'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
	'Access-Control-Max-Age': '86400'
};

const SSE_HEADERS: Record<string, string> = {
	'Content-Type': 'text/event-stream; charset=utf-8',
	'Cache-Control': 'no-cache',
	// Required on Workers: without it, compression buffers the stream and
	// nothing reaches the client until the response ends.
	'Content-Encoding': 'identity',
	...CORS_HEADERS
};

const KEEPALIVE_MS = 15_000;
const GET_STREAM_MAX_MS = 300_000; // bounded so an invocation can't live forever

/** A JSON-RPC response, plus an optional step to run once it has reached the caller. */
interface Outcome {
	response: JsonRpcResponse;
	delivered?: () => Promise<void>;
}

function jsonResponse(body: JsonRpcResponse): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
	});
}

function wantsSse(request: Request): boolean {
	return (request.headers.get('Accept') ?? '').includes('text/event-stream');
}

/**
 * Streams one JSON-RPC response as SSE, with `: keepalive` comment frames while
 * the work is in flight. The heartbeats reset client idle timeouts, which is
 * what keeps a call alive while the council is thinking.
 *
 * `delivered` runs only if the response was written to a caller that was still
 * connected, so answers are never deleted on the strength of a failed write.
 */
function sseResponse(work: () => Promise<Outcome>): Response {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const enc = new TextEncoder();
	let closed = false;

	const write = (s: string): Promise<void> =>
		closed
			? Promise.resolve()
			: writer.write(enc.encode(s)).catch(() => {
					// Client disconnected — stop writing, let the work settle.
					closed = true;
				});

	const heartbeat = setInterval(() => void write(': keepalive\n\n'), KEEPALIVE_MS);

	void (async () => {
		let outcome: Outcome;
		try {
			outcome = await work();
		} catch (err) {
			outcome = {
				response: rpcError(
					null,
					MCP_ERROR_CODES.INTERNAL_ERROR,
					err instanceof Error ? err.message : String(err)
				)
			};
		}
		clearInterval(heartbeat);
		await write(`data: ${JSON.stringify(outcome.response)}\n\n`);
		if (!closed && outcome.delivered) {
			await outcome.delivered().catch((err) => console.error('discard failed', err));
		}
		await writer.close().catch(() => {});
	})();

	return new Response(readable, { status: 200, headers: SSE_HEADERS });
}

/**
 * The stream a client opens with GET for server-initiated messages. This server
 * has none to push, so it simply stays alive on keepalives — which is what the
 * client is waiting for. Bounded; clients reconnect, which is normal for SSE.
 */
function sseKeepaliveStream(): Response {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const enc = new TextEncoder();
	let closed = false;

	const write = (s: string): Promise<void> =>
		closed
			? Promise.resolve()
			: writer.write(enc.encode(s)).catch(() => {
					closed = true;
				});

	void (async () => {
		await write(': connected\n\n');
		const deadline = Date.now() + GET_STREAM_MAX_MS;
		while (!closed && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, KEEPALIVE_MS));
			await write(': keepalive\n\n');
		}
		await writer.close().catch(() => {});
	})();

	return new Response(readable, { status: 200, headers: SSE_HEADERS });
}

/** Produces the JSON-RPC response; the caller decides JSON vs SSE delivery. */
async function dispatch(body: JsonRpcRequest, env: Env): Promise<Outcome> {
	const id = body.id ?? null;

	if (body.method === 'initialize') {
		const requested = (body.params as { protocolVersion?: string } | undefined)?.protocolVersion;
		return { response: handleInitialize(id, requested) };
	}

	// Only members whose API key is set are offered or asked.
	const members = availableMembers(env);

	switch (body.method) {
		case 'tools/list':
			return { response: handleToolsList(id, members, waitSeconds(env)) };
		case 'tools/call': {
			const validated = validateToolCall(body.params, members);
			if (!validated.ok) return { response: rpcError(id, validated.code, validated.message) };
			const result =
				validated.tool === 'ask_council'
					? await runAskCouncil(env, validated.args)
					: await runCollectCouncil(env, validated.args);
			return {
				response: {
					jsonrpc: '2.0',
					id,
					result: {
						content: [{ type: 'text', text: result.text }],
						...(result.isError ? { isError: true } : {})
					}
				},
				delivered: result.delivered
			};
		}
		case 'ping':
			return { response: { jsonrpc: '2.0', id, result: {} } };
		default:
			return {
				response: rpcError(id, MCP_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${body.method}`)
			};
	}
}

async function handlePost(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const auth = await authenticateRequest(env, request.headers.get('Authorization'));
	if (!auth.ok) return jsonResponse(rpcError(null, auth.code, auth.message));

	let body: JsonRpcRequest;
	try {
		body = (await request.json()) as JsonRpcRequest;
	} catch {
		return jsonResponse(rpcError(null, MCP_ERROR_CODES.PARSE_ERROR, 'Invalid JSON'));
	}
	if (body?.jsonrpc !== '2.0' || typeof body.method !== 'string') {
		return jsonResponse(
			rpcError(body?.id ?? null, MCP_ERROR_CODES.INVALID_REQUEST, 'Not a JSON-RPC 2.0 request')
		);
	}

	// A notification has no response at all — answering one would violate the spec.
	if (body.method.startsWith('notifications/')) {
		return new Response(null, { status: 202, headers: CORS_HEADERS });
	}

	// Clients that advertise text/event-stream get the streaming transport;
	// everything else gets a plain JSON body.
	if (wantsSse(request)) return sseResponse(() => dispatch(body, env));

	const outcome = await dispatch(body, env);
	// A plain JSON body gives no signal that it arrived, so the answers are
	// deleted once it has been handed to the runtime.
	if (outcome.delivered) ctx.waitUntil(outcome.delivered().catch(() => {}));
	return jsonResponse(outcome.response);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname !== '/mcp') return new Response('Not Found', { status: 404 });
		switch (request.method) {
			case 'POST':
				return handlePost(request, env, ctx);
			case 'GET': {
				// The server-initiated message stream. There is nothing to push, but
				// clients open this and wait on it; a 405 makes some of them tear the
				// connection down and reconnect in a loop.
				const auth = await authenticateRequest(env, request.headers.get('Authorization'));
				if (!auth.ok) {
					return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
				}
				if (!wantsSse(request)) {
					return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
				}
				return sseKeepaliveStream();
			}
			case 'OPTIONS':
				return new Response(null, { status: 204, headers: CORS_HEADERS });
			case 'DELETE':
				// Nothing to tear down — kept so clients that send it on shutdown
				// get a clean answer rather than a 405.
				return new Response(null, { status: 204, headers: CORS_HEADERS });
			default:
				return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
		}
	}
} satisfies ExportedHandler<Env>;
