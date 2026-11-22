// One council session: a Durable Object named by its ticket.
//
// It exists because the model calls must keep running after the caller's first
// tool call has returned with a ticket. It asks every member at once, stores
// each answer as it arrives, and deletes everything once the answers have been
// delivered or the time limit passes.
//
// The prompt is held in memory only and is never written to storage. If the
// object is restarted mid-run (a deploy, for example) the unfinished members
// are marked as failed and the finished answers are kept; nothing is retried.

import { DurableObject } from 'cloudflare:workers';
import { ANSWER_TTL_SECONDS, MEMBER_TIMEOUT_SECONDS } from './config';
import type { Env } from './env';
import type { ShownAnswer } from './format';
import { askMember, availableMembers, type MemberAnswer } from './models';
import { errorRow, recordAttempts } from './record';

// An alarm this often keeps the object in memory while members are running.
const HEARTBEAT_MS = 20_000;
// Extra time allowed after the member deadline before a call is given up on.
const GRACE_MS = 10_000;

interface Meta {
	/** Short id that groups this session's rows in the cost record. */
	council: string;
	members: Array<{ id: string; name: string }>;
	status: 'running' | 'done';
	/** Set when status becomes "done". */
	expiresAt?: number;
}

export type Collected =
	| { status: 'unknown' }
	| { status: 'running'; answered: number; total: number }
	| { status: 'done'; answers: ShownAnswer[] };

const answerKey = (memberId: string): string => `answer:${memberId}`;

export class CouncilSession extends DurableObject<Env> {
	/** The in-flight run. Null after a restart, which is how a restart is detected. */
	private run: Promise<void> | null = null;
	private waiters = new Set<() => void>();

	/** Starts asking the members and returns at once. */
	async start(council: string, prompt: string, memberIds: string[]): Promise<void> {
		const members = availableMembers(this.env).filter((m) => memberIds.includes(m.id));
		const meta: Meta = {
			council,
			members: members.map(({ id, name }) => ({ id, name })),
			status: 'running'
		};
		await this.ctx.storage.put('meta', meta);
		await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);

		const deadline = Date.now() + MEMBER_TIMEOUT_SECONDS * 1000;
		this.run = Promise.all(
			members.map(async (member) => {
				const answer = await Promise.race([
					askMember(this.env, member, prompt, deadline),
					this.giveUp(member, deadline + GRACE_MS)
				]);
				await this.ctx.storage.put(answerKey(member.id), toShown(answer));
				// A failure with no model call behind it still gets a row.
				const rows = answer.attempts.length > 0 ? answer.attempts : [errorRow(answer.error ?? 'failed')];
				await recordAttempts(this.env, council, member.id, rows);
				this.wake();
			})
		)
			.then(() => this.finish(meta))
			.catch((err) => console.error('council run failed', err));
		this.ctx.waitUntil(this.run);
	}

	/**
	 * Waits up to `maxWaitMs` for the council to finish. Answers stay stored
	 * until discard() is called, so a caller that drops the connection while
	 * waiting can still collect them with the ticket.
	 */
	async collect(maxWaitMs: number): Promise<Collected> {
		const end = Date.now() + maxWaitMs;
		for (;;) {
			const meta = await this.ctx.storage.get<Meta>('meta');
			if (!meta) return { status: 'unknown' };
			const answers = await this.storedAnswers(meta);
			if (meta.status === 'done') return { status: 'done', answers };
			const left = end - Date.now();
			if (left <= 0) {
				return { status: 'running', answered: answers.length, total: meta.members.length };
			}
			await this.sleep(left);
		}
	}

	/** Deletes the session. Called once the answers have reached the caller. */
	async discard(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	async alarm(): Promise<void> {
		const meta = await this.ctx.storage.get<Meta>('meta');
		if (!meta) return;

		if (meta.status === 'running') {
			if (this.run) {
				await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
				return;
			}
			// The object was restarted while members were running. Their calls are
			// gone, so close the session with what was already stored.
			for (const member of meta.members) {
				if (await this.ctx.storage.get(answerKey(member.id))) continue;
				const error = 'interrupted by a server restart';
				await this.ctx.storage.put(answerKey(member.id), {
					...member,
					ok: false,
					text: '',
					error
				} satisfies ShownAnswer);
				await recordAttempts(this.env, meta.council, member.id, [errorRow(error)]);
			}
			await this.finish(meta);
			return;
		}

		if (Date.now() >= (meta.expiresAt ?? 0)) {
			await this.ctx.storage.deleteAll();
		} else {
			await this.ctx.storage.setAlarm(meta.expiresAt as number);
		}
	}

	private async finish(meta: Meta): Promise<void> {
		const expiresAt = Date.now() + ANSWER_TTL_SECONDS * 1000;
		await this.ctx.storage.put('meta', { ...meta, status: 'done', expiresAt } satisfies Meta);
		await this.ctx.storage.setAlarm(expiresAt);
		this.run = null;
		this.wake();
	}

	private async storedAnswers(meta: Meta): Promise<ShownAnswer[]> {
		const stored = await this.ctx.storage.get<ShownAnswer>(meta.members.map((m) => answerKey(m.id)));
		// Members' configured order, not the order they finished in.
		return meta.members.flatMap((m) => stored.get(answerKey(m.id)) ?? []);
	}

	/** A failure that resolves at `at`, in case a model call never settles. */
	private giveUp(member: { id: string; name: string }, at: number): Promise<MemberAnswer> {
		return new Promise((resolve) =>
			setTimeout(
				() => resolve({ ...member, ok: false, text: '', error: 'timed out', attempts: [] }),
				Math.max(0, at - Date.now())
			)
		);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const done = (): void => {
				clearTimeout(timer);
				this.waiters.delete(done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.waiters.add(done);
		});
	}

	private wake(): void {
		for (const done of [...this.waiters]) done();
	}
}

function toShown(answer: MemberAnswer): ShownAnswer {
	const { id, name, ok, text, error, answeredBy } = answer;
	return { id, name, ok, text, error, answeredBy };
}
