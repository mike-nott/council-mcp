// Cost of one model call, from its token counts and the route's price in config.ts.
// Follows calculateLlmCost in ayima-agent.

import type { Price, Route } from './config';

export interface Usage {
	/** All input tokens, cached ones included. */
	inputTokens: number;
	/** The part of inputTokens the provider served from its cache. */
	cachedInputTokens: number;
	/** All output tokens, thinking included. */
	outputTokens: number;
}

/** The price in force on a date: the latest change that has started, or the base price. */
export function priceAt(route: Route, at: Date): Price {
	let price: Price = route.price;
	for (const change of route.priceChanges ?? []) {
		if (at.getTime() >= Date.parse(`${change.from}T00:00:00Z`)) price = change;
	}
	return price;
}

/** Cost in USD. */
export function costOf(route: Route, usage: Usage, at: Date = new Date()): number {
	const price = priceAt(route, at);
	const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
	const uncached = usage.inputTokens - cached;
	return (
		(uncached * price.input + cached * price.cachedInput + usage.outputTokens * price.output) /
		1_000_000
	);
}
