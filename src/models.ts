// Model calls. The provider factory follows ayima-agent's src/agent/model.ts:
// the AI SDK talks to each provider, so there is one call shape for all of them.
//
// A member is asked through its routes in order. The first route that returns
// an answer wins; a route that fails is recorded and the next one is tried.

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, type LanguageModel } from 'ai';
import { MEMBERS, type Member, type Provider, type Route } from './config';
import type { Env } from './env';
import { costOf, type Usage } from './pricing';
import { MEMBER_INSTRUCTIONS } from './prompt';

type KeyName =
	| 'ANTHROPIC_API_KEY'
	| 'OPENAI_API_KEY'
	| 'GEMINI_API_KEY'
	| 'OLLAMA_API_KEY'
	| 'FIREWORKS_API_KEY';

/** The secret each provider needs. */
export const PROVIDER_KEYS: Record<Provider, KeyName> = {
	anthropic: 'ANTHROPIC_API_KEY',
	openai: 'OPENAI_API_KEY',
	google: 'GEMINI_API_KEY',
	ollama: 'OLLAMA_API_KEY',
	fireworks: 'FIREWORKS_API_KEY'
};

// Ollama's cloud and Fireworks both serve an OpenAI-compatible chat API.
const OPENAI_COMPATIBLE_URLS: Partial<Record<Provider, string>> = {
	ollama: 'https://ollama.com/v1',
	fireworks: 'https://api.fireworks.ai/inference/v1'
};

/** The AI SDK key that a route's `options` are sent under. */
const OPTIONS_KEY: Record<Provider, string> = {
	anthropic: 'anthropic',
	openai: 'openai',
	google: 'google',
	ollama: 'openai',
	fireworks: 'openai'
};

type Keys = Pick<Env, KeyName>;

/** The routes of a member whose API key is set, in their configured order. */
export function usableRoutes(env: Keys, member: Member): Route[] {
	return member.routes.filter((route) => Boolean(env[PROVIDER_KEYS[route.provider]]));
}

/** The members that can be asked with the keys that are set. */
export function availableMembers(env: Keys, members: Member[] = MEMBERS): Member[] {
	return members.filter((member) => usableRoutes(env, member).length > 0);
}

function languageModel(env: Keys, route: Route): LanguageModel {
	const apiKey = env[PROVIDER_KEYS[route.provider]] as string;
	switch (route.provider) {
		case 'anthropic':
			return createAnthropic({ apiKey })(route.model);
		case 'openai':
			return createOpenAI({ apiKey })(route.model);
		case 'google':
			return createGoogleGenerativeAI({ apiKey })(route.model);
		case 'ollama':
		case 'fireworks':
			return createOpenAI({ apiKey, baseURL: OPENAI_COMPATIBLE_URLS[route.provider] }).chat(
				route.model
			);
	}
}

export interface ModelReply {
	text: string;
	usage: Usage;
	finishReason: string;
	/** Set when the provider answered with a different model from the one asked. */
	answeredBy?: string;
}

/** One call to one route. Throws on failure. */
export type CallRoute = (
	env: Keys,
	route: Route,
	prompt: string,
	timeoutMs: number
) => Promise<ModelReply>;

/**
 * Streaming is used although only the final text is kept. A model that thinks
 * for minutes keeps bytes moving on a streamed request, where a plain request
 * would sit idle until something in between drops it.
 *
 * No thinking level and no output cap are sent: each model uses its own
 * defaults, and a cap can be spent entirely on thinking, leaving no answer.
 */
export const callModel: CallRoute = async (env, route, prompt, timeoutMs) => {
	// streamText reports a provider error through onError and then rejects its
	// promises with a generic "no output" error, so the real one is kept here.
	let streamError: unknown;
	const result = streamText({
		model: languageModel(env, route),
		instructions: MEMBER_INSTRUCTIONS,
		prompt,
		maxRetries: 1,
		timeout: { totalMs: timeoutMs },
		...(route.options
			? { providerOptions: { [OPTIONS_KEY[route.provider]]: route.options } as never }
			: {}),
		onError: ({ error }) => {
			streamError = error;
		}
	});

	let text: string;
	try {
		text = await result.text;
	} catch (err) {
		throw streamError ?? err;
	}
	if (streamError) throw streamError;

	const [usage, finishReason, response] = await Promise.all([
		result.usage,
		result.finishReason,
		result.response
	]);
	// Only Anthropic substitutes a model (its refusal fallback). Other providers
	// report dated or aliased ids for the model that was asked.
	const answeredBy =
		route.provider === 'anthropic' && response.modelId && !response.modelId.startsWith(route.model)
			? response.modelId
			: undefined;
	return {
		text: text.trim(),
		usage: {
			inputTokens: usage.inputTokens ?? 0,
			cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
			outputTokens: usage.outputTokens ?? 0
		},
		finishReason,
		answeredBy
	};
};

/** One try at one route. Every attempt becomes a row in the cost and error record. */
export interface Attempt {
	provider: Provider;
	model: string;
	ok: boolean;
	error?: string;
	answeredBy?: string;
	tokensIn: number;
	tokensOut: number;
	tokensCached: number;
	cost: number;
	durationMs: number;
}

export interface MemberAnswer {
	id: string;
	name: string;
	ok: boolean;
	text: string;
	/** Why the member did not answer. Set when ok is false. */
	error?: string;
	answeredBy?: string;
	attempts: Attempt[];
}

export function describeError(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timed out';
		return err.message.replace(/\s+/g, ' ').slice(0, 300);
	}
	return String(err).slice(0, 300);
}

/**
 * Asks one member, trying its usable routes in order until one answers or the
 * deadline passes. Never throws: a member that cannot answer comes back with
 * ok=false, so one failure never costs the caller the other answers.
 */
export async function askMember(
	env: Keys,
	member: Member,
	prompt: string,
	deadline: number,
	call: CallRoute = callModel
): Promise<MemberAnswer> {
	const attempts: Attempt[] = [];
	const base = { id: member.id, name: member.name };

	for (const route of usableRoutes(env, member)) {
		const timeoutMs = deadline - Date.now();
		if (timeoutMs <= 0) break;
		const started = Date.now();
		const attempt: Attempt = {
			provider: route.provider,
			model: route.model,
			ok: false,
			tokensIn: 0,
			tokensOut: 0,
			tokensCached: 0,
			cost: 0,
			durationMs: 0
		};
		attempts.push(attempt);
		try {
			const reply = await call(env, route, prompt, timeoutMs);
			attempt.durationMs = Date.now() - started;
			attempt.tokensIn = reply.usage.inputTokens;
			attempt.tokensOut = reply.usage.outputTokens;
			attempt.tokensCached = reply.usage.cachedInputTokens;
			// A fallback model bills at its own rates; the asked model's rates are an upper estimate.
			attempt.cost = costOf(route, reply.usage);
			attempt.answeredBy = reply.answeredBy;
			if (reply.text) {
				attempt.ok = true;
				return { ...base, ok: true, text: reply.text, answeredBy: reply.answeredBy, attempts };
			}
			attempt.error = `returned no answer (finish reason: ${reply.finishReason})`;
		} catch (err) {
			attempt.durationMs = Date.now() - started;
			attempt.error = describeError(err);
		}
	}

	const last = attempts[attempts.length - 1];
	const error = last
		? last.error ?? 'failed'
		: Date.now() >= deadline
			? 'timed out'
			: 'no API key is set for this member';
	return { ...base, ok: false, text: '', error, attempts };
}
