import type { z } from "zod";
import type { ILLMModel } from "../interfaces";
import { isRecord } from "../utils/typeGuards";

/** A model asked for one object sometimes wraps it: `[{…}]` is that object. Any other array is left alone. */
function unwrapSoleObject(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1) {
    const [only] = value as unknown[];
    if (isRecord(only)) {
      return only;
    }
  }
  return value;
}

/**
 * The JSON object in an LLM reply: a fenced block when present, else the
 * outermost `{…}`. A lone object wrapped in a one-element array is unwrapped.
 */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return unwrapSoleObject(JSON.parse(candidate));
  } catch {
    const braces = candidate.match(/\{[\s\S]*\}/);
    if (!braces) {
      throw new Error("No JSON object found in LLM response");
    }
    return JSON.parse(braces[0]);
  }
}

/** Send one user prompt, collect the streamed reply, and validate its JSON against `schema`. */
export async function requestLlmJson<T>(
  model: ILLMModel,
  prompt: string,
  options: { timeoutMs: number; signal?: AbortSignal; schema: z.ZodType<T> },
): Promise<T> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    onAbort();
  }
  options.signal?.addEventListener("abort", onAbort);
  const timeout = setTimeout(() => controller.abort(new Error("LLM request timed out")), options.timeoutMs);
  let text = "";
  try {
    const response = await model.sendRequest([{ role: "user", content: prompt }], controller.signal);
    for await (const chunk of response) {
      text += chunk;
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
  return options.schema.parse(extractJsonObject(text));
}
