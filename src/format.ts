// Turns a council's answers into the text the calling agent reads.

export interface ShownAnswer {
	id: string;
	name: string;
	ok: boolean;
	text: string;
	error?: string;
	answeredBy?: string;
}

function heading(answer: ShownAnswer): string {
	return answer.answeredBy
		? `## ${answer.name} (answered by ${answer.answeredBy})`
		: `## ${answer.name}`;
}

export function formatAnswers(answers: ShownAnswer[]): { text: string; isError: boolean } {
	const answered = answers.filter((a) => a.ok);
	const failed = answers.filter((a) => !a.ok);
	const failedLines = failed.map((a) => `- ${a.name}: ${a.error ?? 'failed'}`);

	if (answered.length === 0) {
		return {
			text: ['No council member answered.', ...failedLines].join('\n'),
			isError: true
		};
	}

	const parts = [
		`# Council answers (${answered.length} of ${answers.length} members answered)`,
		...answered.map((a) => `${heading(a)}\n\n${a.text}`)
	];
	if (failed.length > 0) parts.push(['## Did not answer', ...failedLines].join('\n'));
	return { text: parts.join('\n\n'), isError: false };
}

export function formatPending(
	ticket: string,
	answered: number,
	total: number,
	waitSeconds: number
): string {
	return (
		`The council is still working: ${answered} of ${total} members have answered so far. ` +
		`Call collect_council with ticket "${ticket}" to get the answers. ` +
		`It waits up to ${waitSeconds} seconds; if the council is still working then, call it again.`
	);
}

export function formatUnknownTicket(ttlSeconds: number): string {
	return (
		'There is no council session for that ticket. Its answers were already collected, or it expired. ' +
		`Uncollected answers are kept for ${Math.round(ttlSeconds / 60)} minutes.`
	);
}
