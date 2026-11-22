# Council MCP

An MCP server that puts a question in front of a council of frontier AI models and returns every member's answer.

It is built for agents that run on smaller or local models. When such an agent is stuck, faces a decision that is costly to get wrong, or wants its work reviewed, it calls the council and gets independent answers from several stronger models.

It runs on Cloudflare Workers. You deploy your own copy, with your own API keys.

## How it works

1. An agent calls `ask_council` with a prompt.
2. The server sends the prompt to every council member at the same time.
3. Each member answers on its own. Members do not see each other's answers.
4. The agent gets all the answers back, each under the member's name.

The default council:

| Id | Member | Provider | Key needed |
|---|---|---|---|
| `claude` | Claude Fable 5.2 | Anthropic | `ANTHROPIC_API_KEY` |
| `gpt` | GPT-6.2 Astra | OpenAI | `OPENAI_API_KEY` |
| `gemini` | Gemini 4 Neon | Google | `GEMINI_API_KEY` |
| `kimi` | Kimi K3.1 Pro | Ollama cloud, then Fireworks | `OLLAMA_API_KEY` or `FIREWORKS_API_KEY` |

You do not need every key. A member whose key is missing is left out, so two keys give you a two-member council.

## The tools

| Tool | Arguments | Returns |
|---|---|---|
| `ask_council` | `prompt` (required), `members` (optional list of member ids) | Every member's answer, or a ticket |
| `collect_council` | `ticket` | The answers for that ticket, or a note that the council is still working |

Things a calling agent should know. The tool descriptions tell it all of this:

- **The members see only the prompt.** They cannot see the agent's conversation, read files, search the web or ask questions. The prompt has to carry everything they need.
- **Answers can take minutes.** `ask_council` waits up to 50 seconds. If the council has not finished, it returns a ticket, and `collect_council` fetches the answers when they are ready.
- **A failed member does not sink the call.** The other answers still come back, with a note naming who failed and why. A member is dropped after 5 minutes.
- **There is one round.** To have the council review its own answers, the agent sends the answers back in a new `ask_council` call.
- **Each call costs money.** It runs several expensive models at once.

## Set it up

You need a Cloudflare account, Node.js 22 or later, and at least one provider API key.

```bash
git clone https://github.com/mike-nott/council-mcp.git
cd council-mcp
npm install
npx wrangler login
```

### 1. Create your access token

Every MCP client must send this token. Generate one and keep it somewhere safe:

```bash
echo "council_$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n')"
```

### 2. Deploy

```bash
npm run deploy
```

Wrangler creates the D1 database for the cost record on the first deploy. If it asks for a database id instead, run `npx wrangler d1 create council` and add the `database_id` it prints to the `[[d1_databases]]` block in `wrangler.toml`.

The deploy prints your server's address, which looks like `https://council-mcp.<your-subdomain>.workers.dev`.

### 3. Add your secrets

Set the access token, then a key for each provider you want on the council:

```bash
echo "<your token>" | npx wrangler secret put MCP_AUTH_TOKEN
echo "<key>" | npx wrangler secret put ANTHROPIC_API_KEY
echo "<key>" | npx wrangler secret put OPENAI_API_KEY
echo "<key>" | npx wrangler secret put GEMINI_API_KEY
echo "<key>" | npx wrangler secret put OLLAMA_API_KEY
echo "<key>" | npx wrangler secret put FIREWORKS_API_KEY
```

Secrets are stored by Cloudflare. They are never written to this repository. `.env.example` lists each key and where to get it.

### 4. Connect a client

The MCP endpoint is your server's address plus `/mcp`. The client must send the token as a bearer token.

Claude Code:

```bash
claude mcp add --transport http council https://council-mcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <your token>"
```

Most other clients take a JSON entry like this one. The exact key names vary by client, so check its documentation:

```json
{
	"mcpServers": {
		"council": {
			"type": "http",
			"url": "https://council-mcp.<your-subdomain>.workers.dev/mcp",
			"headers": { "Authorization": "Bearer <your token>" }
		}
	}
}
```

## Change the council

Everything about the council lives in [`src/config.ts`](src/config.ts). Edit it, then run `npm run deploy`.

A member looks like this:

```ts
{
	id: 'kimi',
	name: 'Kimi K3.1 Pro',
	routes: [
		{ provider: 'ollama', model: 'kimi-k3.1-pro', price: { input: 2, cachedInput: 0.2, output: 10 } },
		{
			provider: 'fireworks',
			model: 'accounts/fireworks/models/kimi-k3p1-pro',
			price: { input: 2, cachedInput: 0.2, output: 10 }
		}
	]
}
```

- **`id`** is what a caller passes in `members` to pick this member.
- **`name`** is the heading above the member's answer.
- **`routes`** are the ways to reach the model, tried in order. The second route is used only if the first fails. One route is enough.
- **`provider`** is one of `anthropic`, `openai`, `google`, `ollama` or `fireworks`. Each reads its key from the secret named in the table above.
- **`model`** is the model id that provider uses.
- **`price`** is in US dollars per million tokens. It is used only for the cost record, so update it when you change a model. `priceChanges` holds announced changes with their start dates.
- **`options`** (optional) are extra provider settings, such as `{ effort: 'high' }` on Anthropic or `{ reasoningEffort: 'high' }` on OpenAI. With no options, each model uses its own default thinking level.

To swap a model, change `model` and `price`. To add a member, add an entry. To remove one, delete its entry.

The same file holds three timings:

| Setting | Default | Meaning |
|---|---|---|
| `WAIT_SECONDS` | 50 | How long a tool call waits before returning a ticket |
| `MEMBER_TIMEOUT_SECONDS` | 300 | How long a member has to answer |
| `ANSWER_TTL_SECONDS` | 3600 | How long uncollected answers are kept |

Many MCP clients give up on a tool call after about a minute, which is why the wait is 50 seconds. If your client waits longer, raise it.

To add a provider that is not in the list, add it to `Provider` in `src/config.ts` and to the three maps at the top of `src/models.ts`. A provider with an OpenAI-compatible API needs only its base URL.

## The cost record

Every model call writes one row to a D1 table: the time, member, provider, model, token counts, cost, duration and any error.

```bash
npm run costs    # calls, tokens and cost per member per day
npm run errors   # the 50 most recent failures
```

Costs are worked out from the prices in `src/config.ts`, so they are estimates. Your providers' own billing pages are the final word.

## What is stored

- **Prompts** are sent to each provider and are never stored by this server.
- **Answers** are held only until the caller has received them. Answers waiting on a ticket are deleted once collected, or after one hour if nobody collects them.
- **The cost record** holds no prompt or answer text.

Your prompts do go to each model provider, under that provider's own data terms.

## Run it locally

```bash
cp .env.example .dev.vars    # then fill in the values
npm run dev                  # serves http://localhost:8787/mcp
npm test
npm run typecheck
```

`.dev.vars` and `.env` are git-ignored. Local runs call the real model providers and cost real money.

A quick check that the server is up:

```bash
curl -s http://localhost:8787/mcp \
  -H "Authorization: Bearer <your token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## How it is built

- `src/index.ts` is the Worker. It checks the token and speaks MCP over HTTP, with no MCP SDK.
- `src/session.ts` is a Durable Object, one per council call. It keeps the model calls running after the first tool call has returned a ticket, and holds the answers until they are collected.
- `src/models.ts` calls the models through the [AI SDK](https://ai-sdk.dev).
- `src/record.ts` writes the cost record.

If the server is redeployed while a council is running, the members that had not finished are reported as failed. Nothing is retried.

## Licence

MIT. See [LICENSE](LICENSE).
