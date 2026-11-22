import type { CouncilSession } from './session';

export interface Env {
	/** One Durable Object per council session, named by its ticket. */
	COUNCIL_SESSION: DurableObjectNamespace<CouncilSession>;
	/** The cost and error record. */
	DB: D1Database;
	/** The bearer token every caller must present. */
	MCP_AUTH_TOKEN: string;
	/** Provider keys. A route whose key is missing is skipped. */
	ANTHROPIC_API_KEY?: string;
	OPENAI_API_KEY?: string;
	GEMINI_API_KEY?: string;
	OLLAMA_API_KEY?: string;
	FIREWORKS_API_KEY?: string;
	/** Optional override of WAIT_SECONDS in config.ts. */
	WAIT_SECONDS?: string;
}
