/**
 * Per-turn effort placement. Within one session Claude Code states the effort
 * inside the conversation, at each turn where it changes: the first statement
 * rides on its environment message, and each later change is a system message
 * before the reply it governs. A level change then keeps the cached prefix.
 * Replayed history reaches a fresh child without the level each turn ran at,
 * so the CLI states only the current level, on the environment message, and a
 * level change rewrites the whole prefix.
 *
 * This restores the placement the CLI itself builds when it knows each turn's
 * level (its own resumed sessions), from the level Pi recorded on each
 * assistant message. It applies only where the CLI already uses per-turn
 * effort, and otherwise forwards the request as built.
 */

import type { AssistantMessage, Message } from "@earendil-works/pi-ai/compat";
import { PROVIDER_ID } from "./models.js";
import { replayAssistantCount } from "./replay.js";
import type { NativeContextSkip } from "./native-context.js";
import { isRecord } from "./types.js";

export interface TurnEffortPlan {
  /** Effort each replayed assistant frame ran at, in order. */
  frames: string[];
  /** Effort of this call, which the CLI received as `--effort`. */
  current: string;
}

type Level = Partial<Record<string, string | null>> | undefined;

function frameEffort(message: AssistantMessage, map: Level): string | undefined {
  // The exact effort this provider sent, while the current model has that
  // level; Pi's requested level mapped for the current model otherwise.
  const sent = message.provider === PROVIDER_ID ? message.providerThinkingLevel : undefined;
  if (sent !== undefined && Object.values(map ?? {}).includes(sent)) return sent;
  const level = message.thinkingLevel;
  return (level === undefined ? undefined : map?.[level]) || undefined;
}

/** Recorded effort per replayed assistant frame; undefined where unknown. */
export function recordedTurnEfforts(history: readonly Message[], map: Level): Array<string | undefined> {
  const known: Array<string | undefined> = [];
  for (const message of history) {
    if (message.role !== "assistant") continue;
    const count = replayAssistantCount(message);
    const effort = frameEffort(message, map);
    for (let i = 0; i < count; i += 1) known.push(effort);
  }
  return known;
}

/**
 * Effort per replayed assistant frame for a call at `current`. A turn without
 * a known effort takes the next known one after it, as the CLI does for its
 * own turns, so the value is the same in every later request.
 */
export function planTurnEfforts(
  known: ReadonlyArray<string | undefined>,
  current: string | undefined,
): TurnEffortPlan | undefined {
  if (current === undefined) return undefined;
  const frames: string[] = new Array<string>(known.length);
  let next = current;
  for (let i = known.length - 1; i >= 0; i -= 1) {
    next = known[i] ?? next;
    frames[i] = next;
  }
  return { frames, current };
}

type WireMessage = Record<string, unknown> & { role?: unknown };

function effortOf(message: WireMessage): string | undefined {
  const config = message["output_config"];
  const effort = isRecord(config) ? config["effort"] : undefined;
  return typeof effort === "string" ? effort : undefined;
}

function withEffort(message: WireMessage, effort: string | undefined): WireMessage {
  const config = isRecord(message["output_config"]) ? { ...message["output_config"] } : {};
  if (effort === undefined) delete config["effort"];
  else config["effort"] = effort;
  const { output_config: _old, ...rest } = message;
  return Object.keys(config).length > 0 ? { ...rest, output_config: config } : rest;
}

const statement = (effort: string): WireMessage => ({ role: "system", content: [], output_config: { effort } });

/**
 * Place the effort statements in a parsed Messages request. Returns null when
 * nothing changed. The top-level effort follows the last statement, as in the
 * CLI's own requests. An unexpected shape is left as built.
 */
export function placeTurnEfforts(
  body: Record<string, unknown>,
  plan: TurnEffortPlan,
): "turnEffortsPlaced" | NativeContextSkip | null {
  const noStatement = "turn efforts: no per-turn statement from the CLI";
  const messages = body["messages"];
  if (!Array.isArray(messages) || !messages.every(isRecord)) return noStatement;
  const [stated, ...more] = messages.filter((message) => effortOf(message) !== undefined);
  // The CLI states one level, the current one, on its environment message.
  if (!stated || more.length > 0 || stated["role"] !== "system" || effortOf(stated) !== plan.current) {
    return noStatement;
  }
  const assistants = messages.filter((message) => message["role"] === "assistant").length;
  if (assistants !== plan.frames.length) return "turn efforts: assistant messages do not match the replay";
  if (plan.frames.every((effort) => effort === plan.current)) return null;

  // A statement follows the user message it answers and sits before the next
  // non-user message: on it when that is a system message, otherwise alone.
  const output: WireMessage[] = [];
  let ordinal = 0;
  let effective: string | undefined;
  let pending: string | undefined;
  for (let message of messages as WireMessage[]) {
    const role = message["role"];
    if (role !== "user") {
      if (role === "system") {
        // The CLI's statement must sit where the first one goes.
        if (pending === undefined && effortOf(message) !== undefined) return noStatement;
        message = withEffort(message, pending);
      } else if (pending !== undefined) {
        output.push(statement(pending));
      }
      pending = undefined;
    }
    output.push(message);
    if (role === "assistant") ordinal += 1;
    if (role === "user") {
      const next = plan.frames[ordinal] ?? plan.current;
      if (next !== effective) pending = effective = next;
    }
  }
  if (pending !== undefined) output.push(statement(pending));
  body["messages"] = output;
  return "turnEffortsPlaced";
}
