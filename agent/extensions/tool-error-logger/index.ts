/**
 * Tool Error Logger Extension
 *
 * Appends telemetry for every failed tool call (isError=true) to per-tool
 * append-only log files at <agentDir>/logs/tool-errors/<toolName>.jsonl.
 *
 * Respects PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR via getAgentDir().
 *
 * Fields logged per entry:
 *   timestamp   - ISO 8601 timestamp of the error
 *   model       - { provider, id }
 *   toolName    - name of the tool that errored
 *   toolCallId  - unique tool call identifier
 *   input       - arguments passed to the tool
 *   content     - text output blocks produced by the tool
 *   details     - tool-specific error details (exit code, etc.)
 *   isError     - always true (filtered)
 *   session     - session file path (or null for ephemeral)
 *   turn        - turn index within the session
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(getAgentDir(), "logs", "tool-errors");

function ensureLogDir() {
	if (!existsSync(LOG_DIR)) {
		mkdirSync(LOG_DIR, { recursive: true });
	}
}

function appendErrorEntry(toolName = "unknown-tool", entry: Record<string, unknown>) {
	ensureLogDir();
	const file = join(LOG_DIR, `${toolName}.jsonl`);
	appendFileSync(file, JSON.stringify(entry) + "\n");
}

export default function (pi: ExtensionAPI) {
	let currentModel: { provider: string; id: string } | null = null;
	let currentTurn = 0;

	// Track model changes
	pi.on("model_select", async (event) => {
		currentModel = {
			provider: event.model.provider,
			id: event.model.id,
		};
	});

	// Track turn index
	pi.on("turn_start", async (event) => {
		currentTurn = event.turnIndex;
	});

	// Initialize model from session restore
	pi.on("session_start", async (_event, ctx) => {
		const model = ctx.model;
		if (model) {
			currentModel = { provider: model.provider, id: model.id };
		}
	});

	// Log every errored tool result
	pi.on("tool_result", async (event, ctx) => {
		if (!event.isError) { return; }

		const sessionFile = ctx.sessionManager.getSessionFile() ?? null;

		const entry = {
			timestamp: new Date().toISOString(),
			model: currentModel ?? { provider: "unknown", id: "unknown" },
			toolName: event.toolName,
			input: event.input,
			content: event.content,
			toolCallId: event.toolCallId,
      type: event.type,
			details: event.details,
			isError: event.isError,
			session: sessionFile,
			turn: currentTurn,
		};

		try {
			appendErrorEntry(event.toolName, entry);
		} catch {
			// Silently ignore write failures — don't compound errors
		}
	});
}
