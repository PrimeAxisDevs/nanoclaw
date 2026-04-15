/**
 * Grok MCP Server for NanoClaw
 * Exposes xAI's Grok models as tools for the container agent.
 * Uses the OpenAI-compatible xAI API endpoint.
 *
 * Tools:
 *   grok_chat             — General chat/reasoning with Grok
 *   grok_generate_prompt  — Ask Grok to craft an optimized system prompt (for teaching Ollama)
 *   grok_critique         — Ask Grok to critique an LLM response and suggest improvements
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const GROK_API_KEY = process.env.GROK_API_KEY ?? '';
const GROK_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_MODEL = 'grok-3-mini';

function log(msg: string): void {
  console.error(`[GROK] ${msg}`);
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GrokResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

async function grokCall(messages: ChatMessage[], model: string, temperature = 0.7): Promise<string> {
  if (!GROK_API_KEY) {
    throw new Error('GROK_API_KEY is not set. Add it to .env and restart NanoClaw.');
  }

  const res = await fetch(`${GROK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROK_API_KEY}`,
    },
    body: JSON.stringify({ model, messages, temperature }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Grok API error (${res.status}): ${errorText}`);
  }

  const data = await res.json() as GrokResponse;
  const content = data.choices[0]?.message?.content ?? '';
  const usage = data.usage;
  if (usage) {
    log(`tokens: ${usage.prompt_tokens} in / ${usage.completion_tokens} out`);
  }
  return content;
}

const server = new McpServer({
  name: 'grok',
  version: '1.0.0',
});

// ─── grok_chat ───────────────────────────────────────────────────────────────

server.tool(
  'grok_chat',
  'Send a message to Grok and get a response. Good for questions that benefit from Grok\'s reasoning, real-time knowledge, or as a second opinion. Use grok-3 for deep reasoning, grok-3-mini for fast tasks.',
  {
    prompt: z.string().describe('The message or question to send to Grok'),
    system: z.string().optional().describe('Optional system prompt to set Grok\'s behavior for this call'),
    model: z.enum(['grok-3', 'grok-3-mini', 'grok-2-1212']).optional().default('grok-3-mini').describe('Grok model to use (default: grok-3-mini)'),
    temperature: z.number().min(0).max(2).optional().default(0.7).describe('Sampling temperature 0–2 (default 0.7)'),
  },
  async (args) => {
    const model = args.model ?? DEFAULT_MODEL;
    log(`>>> Chat with ${model} (${args.prompt.length} chars)`);
    try {
      const messages: ChatMessage[] = [];
      if (args.system) {
        messages.push({ role: 'system', content: args.system });
      }
      messages.push({ role: 'user', content: args.prompt });

      const response = await grokCall(messages, model, args.temperature ?? 0.7);
      log(`<<< Done: ${response.length} chars`);
      return { content: [{ type: 'text' as const, text: response }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

// ─── grok_generate_prompt ────────────────────────────────────────────────────

server.tool(
  'grok_generate_prompt',
  `Ask Grok to craft an optimized system prompt for teaching an Ollama model a specific skill or persona.
Returns a ready-to-use system prompt string that can be passed directly to ollama_create_model.
Use this as the first step in the Grok→Ollama teaching workflow.`,
  {
    topic: z.string().describe('What skill, persona, or knowledge domain to teach (e.g. "Python expert", "creative writing coach", "Socratic reasoning")'),
    base_model: z.string().optional().describe('The Ollama base model this prompt will run on — helps Grok tailor the prompt (e.g. "llama3.2", "mistral")'),
    style: z.string().optional().describe('Tone or style notes (e.g. "concise", "step-by-step", "Socratic", "warm and encouraging")'),
    depth: z.enum(['quick', 'detailed', 'comprehensive']).optional().default('detailed').describe('How thorough the generated system prompt should be'),
  },
  async (args) => {
    const model = 'grok-3';
    log(`>>> Generating system prompt for: ${args.topic}`);
    try {
      const depthMap = {
        quick: '2-3 sentences',
        detailed: '1-3 paragraphs',
        comprehensive: 'as detailed as needed — multiple sections if useful',
      };
      const lengthGuide = depthMap[args.depth ?? 'detailed'];
      const baseModelNote = args.base_model ? ` optimized for the ${args.base_model} model` : '';
      const styleNote = args.style ? ` The tone/style should be: ${args.style}.` : '';

      const systemPrompt = `You are a prompt engineer specializing in crafting system prompts for local LLMs.
Your prompts are precise, actionable, and unlock specific capabilities in smaller open-source models.
Output ONLY the system prompt text — no explanation, no markdown fences, no meta-commentary.`;

      const userPrompt = `Write a system prompt${baseModelNote} that makes the model an expert in: ${args.topic}.
The prompt should be ${lengthGuide}.${styleNote}
Focus on: defining the role clearly, setting behavioral expectations, naming key capabilities, and specifying output format preferences.
Output only the system prompt — start directly with the first word of the prompt.`;

      const response = await grokCall(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        model,
        0.6,
      );
      log(`<<< Generated prompt: ${response.length} chars`);
      return { content: [{ type: 'text' as const, text: response }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

// ─── grok_critique ───────────────────────────────────────────────────────────

server.tool(
  'grok_critique',
  `Ask Grok to evaluate an Ollama model response for quality, accuracy, and depth.
Returns structured feedback and a revised system prompt suggestion if improvement is needed.
Use this after ollama_generate to close the Grok→Ollama teaching loop.`,
  {
    ollama_response: z.string().describe('The response from Ollama that should be evaluated'),
    original_prompt: z.string().describe('The prompt/question that was given to Ollama'),
    current_system_prompt: z.string().optional().describe('The system prompt the Ollama model was using (if any)'),
    quality_target: z.string().optional().describe('What "good" looks like — e.g. "concise step-by-step code", "deep philosophical reasoning"'),
  },
  async (args) => {
    const model = 'grok-3';
    log(`>>> Critiquing Ollama response (${args.ollama_response.length} chars)`);
    try {
      const systemNote = args.current_system_prompt
        ? `\n\nThe model was running with this system prompt:\n---\n${args.current_system_prompt}\n---`
        : '';
      const targetNote = args.quality_target ? `\n\nQuality target: ${args.quality_target}` : '';

      const userPrompt = `You are evaluating a local LLM's response to improve it through better prompting.

Prompt given to the model: ${args.original_prompt}${systemNote}${targetNote}

Model response:
---
${args.ollama_response}
---

Provide:
1. **Score** (1–10) with one-line justification
2. **Strengths** (bullet points)
3. **Weaknesses** (bullet points)
4. **Improved system prompt** — a revised system prompt that would produce a better response (output the full prompt text, not just changes)
5. **Test prompts** — 3 prompts to verify the improvement`;

      const response = await grokCall(
        [{ role: 'user', content: userPrompt }],
        model,
        0.5,
      );
      log(`<<< Critique complete: ${response.length} chars`);
      return { content: [{ type: 'text' as const, text: response }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
