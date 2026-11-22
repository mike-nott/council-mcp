// The protocol layer: pure functions that return JSON-RPC responses. Structure
// follows web-mcp's handlers. Schema violations are protocol errors (-32602);
// anything that goes wrong while the council runs comes back as a readable
// tool result instead (see tools.ts).
//
// The tool descriptions are the only guidance a calling model gets, so they
// say when to use the council, what to put in the prompt and what comes back.

import type { Member } from '../config';
import { MCP_ERROR_CODES } from './errors';
import type { JsonRpcResponse } from './types';
import { MCP_PROTOCOL_VERSION } from './types';

export interface AskArgs {
	prompt: string;
	memberIds: string[];
}

export interface CollectArgs {
	ticket: string;
}

export type ValidatedCall =
	| { ok: true; tool: 'ask_council'; args: AskArgs }
	| { ok: true; tool: 'collect_council'; args: CollectArgs }
	| { ok: false; code: number; message: string };

// The tool surface is identical across these revisions, so the server agrees
// with whichever one the client asked for.
const KNOWN_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

/** A ticket is 32 hex characters (see newTicket in tools.ts). */
const TICKET_PATTERN = /^[0-9a-f]{32}$/;

const SERVER_INSTRUCTIONS =
	'The Council is a panel of frontier AI models. Call ask_council when you want a stronger answer, ' +
	'a review of your work or a decision from them. Every member answers independently and you get ' +
	'all the answers back. The members see only the prompt you send, so put everything they need in it. ' +
	'If you want the council to review its own answers, send the answers back in a new ask_council call.';

export function handleInitialize(
	id: string | number | null,
	requestedVersion?: string
): JsonRpcResponse {
	const protocolVersion =
		requestedVersion && KNOWN_PROTOCOL_VERSIONS.includes(requestedVersion)
			? requestedVersion
			: MCP_PROTOCOL_VERSION;
	return {
		jsonrpc: '2.0',
		id,
		result: {
			protocolVersion,
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: 'council-mcp', version: '1.0.0' },
			instructions: SERVER_INSTRUCTIONS
		}
	};
}

function memberList(members: Member[]): string {
	return members.map((m) => `${m.id} (${m.name})`).join(', ');
}

export function askDescription(members: Member[], waitSeconds: number): string {
	const who =
		members.length > 0
			? `The council has ${members.length} member${members.length === 1 ? '' : 's'}: ${memberList(members)}.`
			: 'No council members are available: no provider API key is set on this server.';
	return (
		'Put a question, an idea, a plan or a piece of work in front of the Council, a panel of frontier ' +
		'AI models. Every member answers independently and you get all the answers back, each under ' +
		"the member's name. Use it when you are stuck, when a decision is costly to get wrong, or when " +
		'you want your work reviewed by stronger models. Each call runs several expensive models, so do ' +
		'not use it for something you can answer yourself. ' +
		who +
		' The members see ONLY the prompt you send. They cannot see this conversation, read files, ' +
		'search the web or ask you questions. So put everything they need in the prompt: the question, ' +
		'the relevant code, text or data, what you have already tried, and the kind of answer you want. ' +
		'A vague prompt gets vague answers. ' +
		'The members can disagree. Weigh the answers yourself: look at the reasoning, not at how many ' +
		'members agree. If you want the council to review its own answers, call this tool again with ' +
		'your question and the answers in the prompt. ' +
		`Answers can take a few minutes. If the council has not finished within ${waitSeconds} seconds ` +
		'you get a ticket in place of the answers; call collect_council with that ticket.'
	);
}

export function collectDescription(waitSeconds: number): string {
	return (
		'Collect the answers for a ticket that ask_council returned. ' +
		`Waits up to ${waitSeconds} seconds for the council to finish. If it is still working, call ` +
		'this tool again with the same ticket. Answers can be collected once; they are deleted afterwards.'
	);
}

export function handleToolsList(
	id: string | number | null,
	members: Member[],
	waitSeconds: number
): JsonRpcResponse {
	const tools = [
		{
			name: 'ask_council',
			description: askDescription(members, waitSeconds),
			inputSchema: {
				type: 'object',
				properties: {
					prompt: {
						type: 'string',
						description:
							'Everything the members need: the question or task, all supporting material, and ' +
							'the kind of answer you want. The members see nothing else.'
					},
					members: {
						type: 'array',
						items: { type: 'string', enum: members.map((m) => m.id) },
						description:
							'Optional. The ids of the members to ask. Leave it out to ask every member.'
					}
				},
				required: ['prompt']
			}
		},
		{
			name: 'collect_council',
			description: collectDescription(waitSeconds),
			inputSchema: {
				type: 'object',
				properties: {
					ticket: {
						type: 'string',
						description: 'The ticket returned by ask_council.'
					}
				},
				required: ['ticket']
			}
		}
	];
	return { jsonrpc: '2.0', id, result: { tools } };
}

function invalid(message: string): ValidatedCall {
	return { ok: false, code: MCP_ERROR_CODES.INVALID_PARAMS, message };
}

export function validateToolCall(params: unknown, members: Member[]): ValidatedCall {
	const p = params as { name?: string; arguments?: Record<string, unknown> } | null | undefined;
	const args = p?.arguments ?? {};

	if (p?.name === 'ask_council') {
		const prompt = args.prompt;
		if (typeof prompt !== 'string' || !prompt.trim()) {
			return invalid("'prompt' is required and must be a non-empty string.");
		}
		const available = members.map((m) => m.id);
		const asked = args.members;
		if (asked === undefined || asked === null) {
			return { ok: true, tool: 'ask_council', args: { prompt, memberIds: available } };
		}
		if (!Array.isArray(asked) || asked.some((m) => typeof m !== 'string')) {
			return invalid("'members' must be an array of member ids.");
		}
		const unknown = (asked as string[]).filter((m) => !available.includes(m));
		if (unknown.length > 0) {
			return invalid(
				`Unknown member id: ${unknown.join(', ')}. Available members: ${available.join(', ') || 'none'}.`
			);
		}
		// An empty list means everyone. Order follows the config, not the caller.
		const memberIds =
			asked.length === 0 ? available : available.filter((m) => (asked as string[]).includes(m));
		return { ok: true, tool: 'ask_council', args: { prompt, memberIds } };
	}

	if (p?.name === 'collect_council') {
		const ticket = typeof args.ticket === 'string' ? args.ticket.trim().toLowerCase() : '';
		if (!TICKET_PATTERN.test(ticket)) {
			return invalid("'ticket' is required and must be a ticket returned by ask_council.");
		}
		return { ok: true, tool: 'collect_council', args: { ticket } };
	}

	return {
		ok: false,
		code: MCP_ERROR_CODES.METHOD_NOT_FOUND,
		message: `Unknown tool: ${String(p?.name)}`
	};
}
