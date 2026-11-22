import { describe, expect, it } from 'vitest';
import { authenticateRequest } from '../src/auth';
import { MEMBERS, checkMembers, type Member, type Route } from '../src/config';
import { formatAnswers, formatPending } from '../src/format';
import { askDescription, handleToolsList, validateToolCall } from '../src/mcp/handlers';
import { askMember, availableMembers, usableRoutes, type CallRoute } from '../src/models';
import { costOf, priceAt } from '../src/pricing';

const route = (provider: Route['provider'], model: string): Route => ({
	provider,
	model,
	price: { input: 2, cachedInput: 0.2, output: 10 }
});

const kimi: Member = {
	id: 'kimi',
	name: 'Kimi',
	routes: [route('ollama', 'kimi-a'), route('fireworks', 'kimi-b')]
};
const gpt: Member = { id: 'gpt', name: 'GPT', routes: [route('openai', 'gpt-x')] };

const reply = (text: string) => ({
	text,
	usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500 },
	finishReason: 'stop'
});

describe('config', () => {
	it('ships a valid member list', () => {
		expect(checkMembers(MEMBERS)).toEqual([]);
	});

	it('reports duplicate ids, bad ids and members with no routes', () => {
		const problems = checkMembers([gpt, { ...gpt }, { id: 'Bad Id', name: 'x', routes: [] }]);
		expect(problems.join('\n')).toMatch(/used twice/);
		expect(problems.join('\n')).toMatch(/lower case/);
		expect(problems.join('\n')).toMatch(/no routes/);
	});
});

describe('pricing', () => {
	it('charges cached input at the cached rate', () => {
		const cost = costOf(route('openai', 'm'), {
			inputTokens: 1_000_000,
			cachedInputTokens: 400_000,
			outputTokens: 100_000
		});
		// 600k at $2 + 400k at $0.20 + 100k at $10
		expect(cost).toBeCloseTo(1.2 + 0.08 + 1, 6);
	});

	it('uses a price change from its start date', () => {
		const changing: Route = {
			...route('google', 'm'),
			priceChanges: [{ from: '2026-12-01', input: 4, cachedInput: 0.4, output: 20 }]
		};
		expect(priceAt(changing, new Date('2026-11-30T23:59:59Z')).output).toBe(10);
		expect(priceAt(changing, new Date('2026-12-01T00:00:00Z')).output).toBe(20);
	});
});

describe('available members', () => {
	it('leaves out a member with no key and skips routes with no key', () => {
		const env = { FIREWORKS_API_KEY: 'k' };
		expect(availableMembers(env, [kimi, gpt]).map((m) => m.id)).toEqual(['kimi']);
		expect(usableRoutes(env, kimi).map((r) => r.provider)).toEqual(['fireworks']);
	});
});

describe('askMember', () => {
	const env = { OLLAMA_API_KEY: 'k', FIREWORKS_API_KEY: 'k' };
	const soon = () => Date.now() + 60_000;

	it('answers through the first route and records one attempt with its cost', async () => {
		const call: CallRoute = async () => reply('hello');
		const answer = await askMember(env, kimi, 'q', soon(), call);
		expect(answer.ok).toBe(true);
		expect(answer.text).toBe('hello');
		expect(answer.attempts).toHaveLength(1);
		expect(answer.attempts[0].provider).toBe('ollama');
		expect(answer.attempts[0].cost).toBeCloseTo(0.002 + 0.005, 6);
	});

	it('falls back to the second route when the first fails', async () => {
		const call: CallRoute = async (_env, r) => {
			if (r.provider === 'ollama') throw new Error('upstream 503');
			return reply('from fireworks');
		};
		const answer = await askMember(env, kimi, 'q', soon(), call);
		expect(answer.ok).toBe(true);
		expect(answer.text).toBe('from fireworks');
		expect(answer.attempts.map((a) => [a.provider, a.ok])).toEqual([
			['ollama', false],
			['fireworks', true]
		]);
		expect(answer.attempts[0].error).toBe('upstream 503');
	});

	it('reports the last error when every route fails, without throwing', async () => {
		const call: CallRoute = async () => {
			throw new Error('bad key');
		};
		const answer = await askMember(env, kimi, 'q', soon(), call);
		expect(answer.ok).toBe(false);
		expect(answer.error).toBe('bad key');
		expect(answer.attempts).toHaveLength(2);
	});

	it('treats an empty reply as a failure', async () => {
		const call: CallRoute = async () => ({ ...reply(''), finishReason: 'length' });
		const answer = await askMember({ OPENAI_API_KEY: 'k' }, gpt, 'q', soon(), call);
		expect(answer.ok).toBe(false);
		expect(answer.error).toMatch(/no answer/);
	});

	it('does not call a model once the deadline has passed', async () => {
		let calls = 0;
		const call: CallRoute = async () => {
			calls++;
			return reply('late');
		};
		const answer = await askMember(env, kimi, 'q', Date.now() - 1, call);
		expect(calls).toBe(0);
		expect(answer.ok).toBe(false);
		expect(answer.error).toBe('timed out');
	});
});

describe('auth', () => {
	const env = { MCP_AUTH_TOKEN: 'secret-token' };

	it('accepts the right bearer token', async () => {
		expect((await authenticateRequest(env, 'Bearer secret-token')).ok).toBe(true);
	});

	it('rejects a wrong token, a missing header and an unset secret', async () => {
		expect((await authenticateRequest(env, 'Bearer nope')).ok).toBe(false);
		expect((await authenticateRequest(env, null)).ok).toBe(false);
		expect((await authenticateRequest({ MCP_AUTH_TOKEN: '' }, 'Bearer x')).ok).toBe(false);
	});
});

describe('tool calls', () => {
	const members = [kimi, gpt];
	const call = (name: string, args: Record<string, unknown>) =>
		validateToolCall({ name, arguments: args }, members);

	it('asks every member by default', () => {
		const v = call('ask_council', { prompt: 'why?' });
		expect(v.ok && v.tool === 'ask_council' && v.args.memberIds).toEqual(['kimi', 'gpt']);
	});

	it('asks only the named members, in config order', () => {
		const v = call('ask_council', { prompt: 'why?', members: ['gpt'] });
		expect(v.ok && v.tool === 'ask_council' && v.args.memberIds).toEqual(['gpt']);
	});

	it('rejects an empty prompt and an unknown member', () => {
		expect(call('ask_council', { prompt: '  ' }).ok).toBe(false);
		const v = call('ask_council', { prompt: 'q', members: ['nobody'] });
		expect(!v.ok && v.message).toMatch(/Unknown member id: nobody/);
	});

	it('accepts a well-formed ticket and rejects anything else', () => {
		expect(call('collect_council', { ticket: 'a'.repeat(32) }).ok).toBe(true);
		expect(call('collect_council', { ticket: 'short' }).ok).toBe(false);
		expect(call('collect_council', {}).ok).toBe(false);
	});

	it('rejects an unknown tool', () => {
		expect(call('nope', {}).ok).toBe(false);
	});

	it('lists both tools and names the available members', () => {
		const listed = handleToolsList(1, members, 50) as { result: { tools: Array<{ name: string }> } };
		expect(listed.result.tools.map((t) => t.name)).toEqual(['ask_council', 'collect_council']);
		expect(askDescription(members, 50)).toContain('kimi (Kimi), gpt (GPT)');
		expect(askDescription([], 50)).toContain('No council members are available');
	});
});

describe('result text', () => {
	const ok = { id: 'gpt', name: 'GPT', ok: true, text: 'Use a queue.' };
	const failed = { id: 'kimi', name: 'Kimi', ok: false, text: '', error: 'timed out' };

	it('shows each answer under its member and names the members that failed', () => {
		const { text, isError } = formatAnswers([ok, failed]);
		expect(isError).toBe(false);
		expect(text).toContain('1 of 2 members answered');
		expect(text).toContain('## GPT\n\nUse a queue.');
		expect(text).toContain('- Kimi: timed out');
	});

	it('names the model that answered when it was not the one asked', () => {
		const { text } = formatAnswers([{ ...ok, answeredBy: 'other-model' }]);
		expect(text).toContain('## GPT (answered by other-model)');
	});

	it('is an error when nobody answered', () => {
		expect(formatAnswers([failed]).isError).toBe(true);
	});

	it('tells the caller how to collect a pending council', () => {
		const text = formatPending('abc', 1, 4, 50);
		expect(text).toContain('1 of 4');
		expect(text).toContain('collect_council');
		expect(text).toContain('"abc"');
	});
});
