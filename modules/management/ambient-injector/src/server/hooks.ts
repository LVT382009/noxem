import { logger } from "../logger.js";

export const HookTypes = {
  ON_START: "onStart",
  ON_PROJECT_CHANGE: "onProjectChange",
} as const;

type HookCallback = (context: Record<string, unknown>) => Promise<unknown> | Promise<void>;
type PromptModifierFn = (prompt: string, context: Record<string, unknown>) => Promise<string>;

const hooks: Record<string, HookCallback[]> = {
  [HookTypes.ON_START]: [],
  [HookTypes.ON_PROJECT_CHANGE]: [],
};

const promptModifiers: PromptModifierFn[] = [];

export function registerHook(hookType: string, callback: HookCallback): () => void {
  if (!hooks[hookType]) {
    throw new Error(`Unknown hook type: ${hookType}`);
  }

  hooks[hookType].push(callback);
  logger.flow("hook", "register", { hookType, count: hooks[hookType].length });

  return () => {
    const index = hooks[hookType]?.indexOf(callback);
    if (index != null && index > -1) {
      hooks[hookType]?.splice(index, 1);
    }
  };
}

export async function triggerHook(hookType: string, context: Record<string, unknown> = {}): Promise<unknown[]> {
  if (!hooks[hookType]) {
    throw new Error(`Unknown hook type: ${hookType}`);
  }

  logger.flow("hook", "trigger_start", { hookType, callbackCount: hooks[hookType].length });

  const results: unknown[] = [];
  for (let i = 0; i < hooks[hookType].length; i++) {
    const callback = hooks[hookType][i];
    logger.flow("hook", "callback_executing", { index: i });
    try {
      const result = await callback(context);
      logger.flow("hook", "callback_success");
      results.push(result);
    } catch (error) {
      logger.error("Hook callback failed", { hookType, error: (error as Error).message });
      results.push({ error: (error as Error).message });
    }
  }

  logger.flow("hook", "trigger_complete", { hookType, results: results.length });
  return results;
}

export function getHookCount(hookType: string): number {
  return hooks[hookType]?.length || 0;
}

export function clearHooks(): void {
  for (const hookType of Object.keys(hooks)) {
    hooks[hookType] = [];
  }
}

export function registerPromptModifier(modifier: PromptModifierFn): () => void {
  if (typeof modifier !== "function") {
    throw new Error("Modifier must be a function");
  }

  promptModifiers.push(modifier);
  logger.flow("prompt_modifier", "register", { count: promptModifiers.length });

  return () => {
    const index = promptModifiers.indexOf(modifier);
    if (index > -1) {
      promptModifiers.splice(index, 1);
    }
  };
}

export async function applyPromptModifiers(prompt: string, context: Record<string, unknown> = {}): Promise<string> {
  let modifiedPrompt = prompt;

  logger.flow("prompt_modifier", "apply_start", { count: promptModifiers.length });

  for (let i = 0; i < promptModifiers.length; i++) {
    const modifier = promptModifiers[i];
    logger.flow("prompt_modifier", "applying", { index: i });
    try {
      modifiedPrompt = await modifier(modifiedPrompt, context);
    } catch (error) {
      logger.error("Prompt modifier failed", (error as Error).message);
    }
  }

  logger.flow("prompt_modifier", "apply_complete", { finalLength: modifiedPrompt.length });
  return modifiedPrompt;
}

export function getPromptModifierCount(): number {
  return promptModifiers.length;
}

export function clearPromptModifiers(): void {
  promptModifiers.length = 0;
}
