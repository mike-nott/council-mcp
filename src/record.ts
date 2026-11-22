// The cost and error record: one row in D1 per model call. It holds tokens,
// cost, timing and any error. It never holds a prompt or an answer.
//
// Follows writeLog in ayima-agent: a failed write is logged and swallowed, so
// the record can never break a reply.

import type { Env } from './env';
import type { Attempt } from './models';

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS calls (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	council TEXT NOT NULL,
	member TEXT NOT NULL,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	answered_by TEXT,
	tokens_in INTEGER NOT NULL DEFAULT 0,
	tokens_out INTEGER NOT NULL DEFAULT 0,
	tokens_cached INTEGER NOT NULL DEFAULT 0,
	cost REAL NOT NULL DEFAULT 0,
	duration_ms INTEGER NOT NULL DEFAULT 0,
	ok INTEGER NOT NULL DEFAULT 1,
	error TEXT
)`;
const CREATE_INDEX = 'CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts)';

// Created on first use, once per isolate, so nobody has to run a migration.
let tableReady: Promise<unknown> | null = null;

function ensureTable(db: D1Database): Promise<unknown> {
	tableReady ??= db.batch([db.prepare(CREATE_TABLE), db.prepare(CREATE_INDEX)]).catch((err) => {
		tableReady = null;
		throw err;
	});
	return tableReady;
}

/** A row for the record. An Attempt is one; so is an error with no model call behind it. */
export type RecordRow = Omit<Attempt, 'provider'> & { provider: string };

/** A row for a failure that happened outside any model call, such as a restart. */
export function errorRow(error: string): RecordRow {
	return {
		provider: 'none',
		model: 'none',
		ok: false,
		error,
		tokensIn: 0,
		tokensOut: 0,
		tokensCached: 0,
		cost: 0,
		durationMs: 0
	};
}

/**
 * Writes one row per attempt. `council` is a short id shared by the rows of one
 * council call, so they can be grouped.
 */
export async function recordAttempts(
	env: Pick<Env, 'DB'>,
	council: string,
	member: string,
	attempts: RecordRow[]
): Promise<void> {
	if (attempts.length === 0) return;
	try {
		await ensureTable(env.DB);
		const insert = env.DB.prepare(
			`INSERT INTO calls (ts, council, member, provider, model, answered_by, tokens_in,
				tokens_out, tokens_cached, cost, duration_ms, ok, error)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		const now = Date.now();
		await env.DB.batch(
			attempts.map((a) =>
				insert.bind(
					now,
					council,
					member,
					a.provider,
					a.model,
					a.answeredBy ?? null,
					a.tokensIn,
					a.tokensOut,
					a.tokensCached,
					a.cost,
					a.durationMs,
					a.ok ? 1 : 0,
					a.error ?? null
				)
			)
		);
	} catch (err) {
		console.error('record write failed', member, err);
	}
}
