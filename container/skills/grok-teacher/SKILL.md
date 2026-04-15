---
name: grok-teacher
description: Teach Ollama models using Grok. Grok generates optimized system prompts and critiques Ollama responses to progressively improve a local model before deploying it to a powerful server.
---

# Grok → Ollama Teaching Workflow

Use this skill when the user wants to improve an Ollama model, teach it a new skill, or prepare it for deployment to a production server.

## How it works

1. **Generate** — Grok crafts an optimized system prompt for a target skill/topic
2. **Bake** — The system prompt is baked into a named Ollama model via Modelfile
3. **Test** — The new model is tested with representative prompts
4. **Critique** — Grok evaluates the response and suggests improvements
5. **Iterate** — Repeat until quality is satisfactory
6. **Save** — Final system prompt and model config saved to `training-memories/`

## Quick command patterns

The user can trigger this workflow with natural language like:
- "Teach Ollama to be a better coding assistant"
- "Use Grok to improve Ollama's reasoning"
- "Train a custom Ollama model for [topic]"
- "Prepare Ollama for the server"

## Workflow steps

### Step 1: Check what's available

```
ollama_list_models()
```

Pick a suitable base model. Recommendations:
- `gemma3:1b` — fastest, smallest (good for testing the loop)
- `llama3.2` — good balance of speed and quality
- `qwen3-coder:30b` — best for coding tasks (needs RAM)

### Step 2: Generate the system prompt

```
grok_generate_prompt(
  topic="<what to teach>",
  base_model="<chosen base model>",
  style="<optional tone>",
  depth="detailed"  # or "comprehensive" for production
)
```

Save the output — this is the core of the teaching.

### Step 3: Bake the model

```
ollama_create_model(
  name="<descriptive-name>",    # e.g. "coding-expert-v1"
  base_model="<base>",
  system_prompt="<grok output>",
  temperature=0.7               # optional
)
```

### Step 4: Test the model

Pick 2–3 representative test prompts and run:

```
ollama_generate(
  model="<new model name>",
  prompt="<test prompt>"
)
```

### Step 5: Critique and iterate

Send the response to Grok for evaluation:

```
grok_critique(
  ollama_response="<response from step 4>",
  original_prompt="<test prompt>",
  current_system_prompt="<system prompt used>",
  quality_target="<what good looks like>"
)
```

If the score is below 7/10:
- Take the "Improved system prompt" from Grok's critique
- Go back to Step 3 with the improved prompt, incrementing the version suffix: `v1` → `v2`
- Re-test and re-critique until satisfied

### Step 6: Save training memory

When you reach a satisfying result, save to `training-memories/<topic>.md`:

```markdown
# <Topic> Training Memory

**Date**: <today>
**Base model**: <model>
**Final model name**: <name>
**Iterations**: <n>

## Final System Prompt

<system prompt>

## Test Results

| Prompt | Score | Notes |
|--------|-------|-------|
| ... | .../10 | ... |

## Notes for Deployment

<any notes about this model for the server>
```

## Tips

- Start with `depth="detailed"` — use `"comprehensive"` only for production-ready models
- Name models descriptively: `coding-py-v2`, `writing-coach-warm-v1`
- Keep iteration count low (2–3 rounds) — Grok's first prompt is usually 80% there
- For the powerful server: the final system prompt + base model name is all you need to recreate the model
- Run `ollama_list_models()` after creation to confirm the model appears

## Deploying to the powerful server

Once happy with the model, tell the user:
> Your trained model is ready. To deploy to the server:
> 1. Install Ollama on the server
> 2. Pull the base model: `ollama pull <base_model>`
> 3. Create a file called `Modelfile` with the contents from the training memory
> 4. Run: `ollama create <name> -f Modelfile`
> 5. Test with: `ollama run <name>`
>
> The system prompt in `training-memories/<topic>.md` is the key artifact — it makes any base model behave like your trained version.
