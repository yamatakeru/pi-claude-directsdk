# Claude Native

A Pi model provider that sends each Pi model call through the unmodified Claude Code executable. Pi owns the conversation; Claude Native replays it to Claude in native form for every call.

## Replay

**Replay**:
Resending the Pi conversation to Claude in native form on every model call.

**Input contract**:
Which Pi histories the replay accepts, and how it adjusts the parts native form cannot represent ([ADR 0001](docs/adr/0001-replay-input-contract.md)).

**Carrier**:
The original native response stored with a Pi assistant message, including its signed thinking.

**Projection**:
The visible parts of an assistant message (text, thinking, tool calls) that are compared with its carrier. When they differ, the carrier is not used.

**Native transcript**:
The request path for models that accept tool changes mid-conversation, where later system messages stay in place.

**Collapsed request**:
The request path for other models, where all system messages are merged into one leading system prompt.

**Replay adjustment**:
A change the replay makes to the history under the input contract, such as replaying a tool call as text, omitting a turn, or adding a missing tool result. Each one is recorded in the request's diagnostics.

## Tools

**Declared tools**:
The tools a request makes available to the model, including tools declared earlier in the conversation when the model supports tool changes mid-conversation. A historical tool call is replayed natively only when its tool is declared.
_Avoid_: inventory

**Active tools**:
The tools Pi currently lets the model call. A tool call in a fresh response must name an active tool.
_Avoid_: inventory, current inventory, host inventory
