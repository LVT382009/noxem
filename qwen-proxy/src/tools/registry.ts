/*
 * File: registry.ts
 * Project: qwenproxy
 * Tool registry with register/lookup and OpenAI-compatible schema export
 */

import type {
  FunctionToolDefinition,
  JsonSchema,
  ParsedToolCall,
  ToolContext,
  ToolHandler,
  ToolCallResult,
  ToolExecutionOptions,
  ToolRegistration,
} from './types';
import { SchemaValidationError, validateAgainstSchema } from './schema.js';

const DEFAULT_TOOL_TIMEOUT_MS = 30000;

function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

function formatToolError(errorType: ToolCallResult['errorType'], message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ error: { type: errorType, message, ...extra } });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

/**
 * Central tool registry. Tools are registered at startup and looked up by name
 * during the execution loop.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();

  /**
   * Register a new tool.
   * @param name        Unique tool name (must match the function name the LLM will emit)
   * @param description Human-readable description (sent to the LLM)
   * @param parameters  JSON Schema describing the tool's parameters
   * @param handler     Async function that executes the tool
   * @param strict      When true, additionalProperties:false is enforced and
   *                    missing required fields are rejected (default true)
   */
  register<TArgs = any, TResult = any>(
    name: string,
    description: string,
    parameters: JsonSchema,
    handler: ToolHandler<TArgs, TResult>,
    strict = true
  ): void {
    if (this.tools.has(name)) {
      throw new Error(`Tool '${name}' is already registered`);
    }

    // If strict mode, ensure the schema enforces additionalProperties: false
    const enforcedParams = strict
      ? { ...parameters, additionalProperties: false }
      : parameters;

    this.tools.set(name, {
      name,
      description,
      parameters: enforcedParams,
      strict,
      handler: handler as ToolHandler,
    });
  }

  /**
   * Unregister a tool by name. Useful for testing.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Look up a tool by name. Returns undefined if not found.
   */
  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  /**
   * Check whether a tool with the given name exists.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Return all registered tool names.
   */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Return the OpenAI-compatible tool definitions array
   * (for inclusion in the `tools` field of the request body sent to the LLM).
   */
  toOpenAITools(): FunctionToolDefinition[] {
    const defs: FunctionToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      defs.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict,
        },
      });
    }
    return defs;
  }

  /**
   * Validate a tool call's arguments against the registered schema, then
   * invoke the handler. Returns a serialised result string.
   *
   * @throws SchemaValidationError if validation fails
   * @throws Error if the tool is not found
   */
  async execute(
    toolName: string,
    rawArgs: Record<string, unknown>,
    context: ToolContext
  ): Promise<string> {
    const registration = this.tools.get(toolName);
    if (!registration) {
      throw new Error(`Unknown tool: '${toolName}'`);
    }

    // Strict validation
    const validatedArgs = validateAgainstSchema(
      rawArgs,
      registration.parameters,
      `$.${toolName}`
    ) as Record<string, unknown>;

    return serializeToolResult(await registration.handler(validatedArgs, context));
  }

  async executeCall(
    toolCall: ParsedToolCall,
    context: ToolContext,
    options: ToolExecutionOptions = {}
  ): Promise<ToolCallResult> {
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? context.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const registration = this.tools.get(toolCall.name);

    if (!registration) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: formatToolError('unknown_tool', `Unknown tool: '${toolCall.name}'`, { available_tools: this.listNames() }),
        isError: true,
        errorType: 'unknown_tool',
        durationMs: Date.now() - started,
      };
    }

    try {
      const validatedArgs = validateAgainstSchema(
        toolCall.arguments || {},
        registration.parameters,
        `$.${toolCall.name}`
      ) as Record<string, unknown>;

      const result = await withTimeout(
        registration.handler(validatedArgs, context),
        timeoutMs,
        `Tool '${toolCall.name}'`
      );

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: serializeToolResult(result),
        isError: false,
        durationMs: Date.now() - started,
      };
    } catch (err: any) {
      const errorType: ToolCallResult['errorType'] = err instanceof SchemaValidationError
        ? 'validation_error'
        : err?.message?.includes('timed out after')
          ? 'timeout'
          : 'execution_error';
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: formatToolError(errorType, err?.message || 'Tool execution failed'),
        isError: true,
        errorType,
        durationMs: Date.now() - started,
      };
    }
  }

  async executeCalls(
    toolCalls: ParsedToolCall[],
    context: ToolContext,
    options: ToolExecutionOptions = {}
  ): Promise<ToolCallResult[]> {
    if (options.parallel === false) {
      const results: ToolCallResult[] = [];
      for (const call of toolCalls) {
        results.push(await this.executeCall(call, context, options));
      }
      return results;
    }

    return Promise.all(toolCalls.map(call => this.executeCall(call, context, options)));
  }
}

/**
 * Singleton registry instance shared across the application.
 */
export const registry = new ToolRegistry();
