// Tool execution. Anything that goes wrong here comes back as an isError tool
// result the calling model can read, never as a protocol error.

import { ANSWER_TTL_SECONDS, WAIT_SECONDS } from './config';
import type { Env } from './env';
import { formatAnswers, formatPending, formatUnknownTicket } from './format';
import type { AskArgs, CollectArgs } from './mcp/handlers';
import { describeError } from './models';
import type { CouncilSession } from './session';

export interface ToolResult {
	text: string;
	isError: boolean;
	/** Run once the result has reached the caller. Used to delete delivered answers. */
	delivered?: () => Promise<void>;
}

/** The wait time in seconds: the WAIT_SECONDS variable if it is a positive number, else the config value. */
export function waitSeconds(env: Pick<Env, 'WAIT_SECONDS'>): number {
	const override = Number(env.WAIT_SECONDS);
	return Number.isFinite(override) && override > 0 ? override : WAIT_SECONDS;
}

/** 32 hex characters from 16 random bytes. It names the session and is the only way to reach it. */
export function newTicket(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function session(env: Env, ticket: string): DurableObjectStub<CouncilSession> {
	return env.COUNCIL_SESSION.get(env.COUNCIL_SESSION.idFromName(ticket));
}

async function deliver(env: Env, ticket: string): Promise<ToolResult> {
	const wait = waitSeconds(env);
	const stub = session(env, ticket);
	const collected = await stub.collect(wait * 1000);
	switch (collected.status) {
		case 'unknown':
			return { text: formatUnknownTicket(ANSWER_TTL_SECONDS), isError: true };
		case 'running':
			return {
				text: formatPending(ticket, collected.answered, collected.total, wait),
				isError: false
			};
		case 'done':
			return { ...formatAnswers(collected.answers), delivered: () => stub.discard() };
	}
}

export async function runAskCouncil(env: Env, args: AskArgs): Promise<ToolResult> {
	if (args.memberIds.length === 0) {
		return {
			text:
				'No council members are available: no provider API key is set on this server. ' +
				'Set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OLLAMA_API_KEY ' +
				'or FIREWORKS_API_KEY.',
			isError: true
		};
	}
	try {
		const ticket = newTicket();
		// The first 8 characters group this call's rows in the cost record. The
		// full ticket is never stored there.
		await session(env, ticket).start(ticket.slice(0, 8), args.prompt, args.memberIds);
		return await deliver(env, ticket);
	} catch (err) {
		return { text: `The council could not be started: ${describeError(err)}`, isError: true };
	}
}

export async function runCollectCouncil(env: Env, args: CollectArgs): Promise<ToolResult> {
	try {
		return await deliver(env, args.ticket);
	} catch (err) {
		return { text: `The answers could not be collected: ${describeError(err)}`, isError: true };
	}
}
