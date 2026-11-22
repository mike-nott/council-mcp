// The council's configuration. This is the file to edit when you want different
// members, models, fallbacks or prices. Change it, then run `npm run deploy`.

/** Each provider reads its API key from one secret (see PROVIDERS in models.ts). */
export type Provider = 'anthropic' | 'openai' | 'google' | 'ollama' | 'fireworks';

/** USD per one million tokens. */
export interface Price {
	input: number;
	/** Input tokens the provider served from its cache. */
	cachedInput: number;
	/** Output tokens. Thinking tokens are billed as output by every provider here. */
	output: number;
}

/** One way to reach a model: a provider, the model id it uses, and what it charges. */
export interface Route {
	provider: Provider;
	model: string;
	price: Price;
	/** Announced price changes, oldest first. `from` is an ISO date (UTC). */
	priceChanges?: Array<Price & { from: string }>;
	/**
	 * Extra provider settings sent with every call on this route, for example
	 * `{ effort: 'high' }` on Anthropic or `{ reasoningEffort: 'high' }` on OpenAI.
	 * Leave it out and the model uses its own defaults.
	 */
	options?: Record<string, unknown>;
}

export interface Member {
	/** Short id a caller uses to pick this member. Lower case letters, digits and hyphens. */
	id: string;
	/** The name shown above this member's answer. */
	name: string;
	/**
	 * Tried in order. The second route is used only when the first one fails.
	 * A route whose API key is not set is skipped, and a member with no usable
	 * route is left out of the council.
	 */
	routes: Route[];
}

export const MEMBERS: Member[] = [
	{
		id: 'claude',
		name: 'Claude Fable 5.2',
		routes: [
			{
				provider: 'anthropic',
				model: 'claude-fable-5-2',
				price: { input: 8, cachedInput: 0.2, output: 40 },
				// If Anthropic's safety classifiers decline a request, Anthropic retries
				// it on another Claude model. The answer then names the model that wrote it.
				options: { fallbacks: 'default' }
			}
		]
	},
	{
		id: 'gpt',
		name: 'GPT-6.2 Astra',
		routes: [
			{
				provider: 'openai',
				model: 'gpt-6.2-astra',
				price: { input: 8, cachedInput: 0.4, output: 40 }
			}
		]
	},
	{
		id: 'gemini',
		name: 'Gemini 4 Carbon',
		routes: [
			{
				provider: 'google',
				model: 'gemini-4-carbon',
				price: { input: 2, cachedInput: 0.1, output: 10 },
				priceChanges: [{ from: '2026-12-01', input: 4, cachedInput: 0.2, output: 20 }]
			}
		]
	},
	{
		id: 'kimi',
		name: 'Kimi K3.1 Pro',
		routes: [
			// Ollama's cloud was about 1.7 times faster than Fireworks when tested.
			{
				provider: 'ollama',
				model: 'kimi-k3.1-pro',
				price: { input: 2, cachedInput: 0.2, output: 10 }
			},
			{
				provider: 'fireworks',
				model: 'accounts/fireworks/models/kimi-k3p1-pro',
				price: { input: 2, cachedInput: 0.2, output: 10 }
			}
		]
	}
];

/**
 * How long one tool call waits for the council before it hands back a ticket.
 * Many MCP clients give up on a tool call after about a minute, so this stays
 * under that. Set the WAIT_SECONDS variable in wrangler.toml to override it.
 */
export const WAIT_SECONDS = 50;

/** A member that has not answered after this long is dropped from the result. */
export const MEMBER_TIMEOUT_SECONDS = 300;

/** Uncollected answers are deleted after this long. */
export const ANSWER_TTL_SECONDS = 3600;

/** Returns a list of problems with a member list. Empty means the list is fine. */
export function checkMembers(members: Member[]): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const member of members) {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(member.id)) {
			problems.push(`member id "${member.id}" must be lower case letters, digits and hyphens`);
		}
		if (seen.has(member.id)) problems.push(`member id "${member.id}" is used twice`);
		seen.add(member.id);
		if (!member.name.trim()) problems.push(`member "${member.id}" has no name`);
		if (member.routes.length === 0) problems.push(`member "${member.id}" has no routes`);
		for (const route of member.routes) {
			if (!route.model.trim()) problems.push(`member "${member.id}" has a route with no model`);
			const prices = [route.price, ...(route.priceChanges ?? [])];
			if (prices.some((p) => p.input < 0 || p.cachedInput < 0 || p.output < 0)) {
				problems.push(`member "${member.id}" has a negative price`);
			}
		}
	}
	return problems;
}
