/**
 * Credential Guard — blocks reading of credential files and guides the model
 * toward secure secret management tools.
 *
 * Overrides the built-in `read` tool to:
 * 1. Block access to known credential file paths (auth.json, .env, .aws, .ssh, etc.)
 * 2. Detect whether the secret-store extension is installed
 * 3. Guide the model toward get_secret / with_secret / import_secret when available
 * 4. Fall back to ask_secret guidance when secret-store is not installed
 *
 * Uses `before_agent_start` to inject conditional system prompt guidelines
 * based on what tools are actually available.
 *
 * Installation:
 *   cp -r credential-guard ~/.pi/agent/extensions/credential-guard
 *   # or: pi install /path/to/credential-guard
 */

import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Blocklist
// =============================================================================

/**
 * Exact file paths that are always blocked.
 * These are resolved against the home directory.
 */
const EXACT_BLOCKED_PATHS = [
  ".pi/agent/auth.json",                    // pi's credential store
  ".local/share/opencode/auth.json",        // OpenCode
  ".config/opencode/auth.json",             // OpenCode (alt path)
];

/**
 * Filename patterns that are blocked anywhere in the tree.
 */
const BLOCKED_FILENAME_PATTERNS = [
  /^\.env$/,
  /^\.env\.[^.]+$/,
  /^credentials(\.\w+)?$/i,
  /^secret(\.\w+)?$/i,
  /^secrets(\.\w+)?$/i,
  /^.+\.key$/,
  /^.+\.pem$/,
  /^.+\.p12$/,
  /^.+\.pfx$/,
];

/**
 * Directory names that indicate a credential directory.
 * If any segment of the path matches, the file is blocked.
 */
const BLOCKED_DIRECTORY_PATTERNS = [
  /^\.ssh$/,
  /^\.aws$/,
  /^\.gnupg$/,
  /^\.config\/gcloud$/,
];

// =============================================================================
// Helpers
// =============================================================================

/** Resolve a home-relative path to absolute */
function resolveHome(path: string): string {
  const home = process.env.HOME || "~";
  return path.replace(/^~/, home);
}

/** Check if a file path should be blocked */
function isBlocked(absolutePath: string): { blocked: boolean; reason?: string } {
  // Check exact paths (resolve ~)
  for (const pattern of EXACT_BLOCKED_PATHS) {
    const resolved = resolveHome(`~/${pattern}`);
    if (absolutePath === resolved) {
      return { blocked: true, reason: `matches credential store path (~/${pattern})` };
    }
  }

  // Check filename
  const segments = absolutePath.split("/");
  const filename = segments[segments.length - 1] ?? "";

  for (const re of BLOCKED_FILENAME_PATTERNS) {
    if (re.test(filename)) {
      return { blocked: true, reason: `matches blocked filename pattern: ${re.source}` };
    }
  }

  // Check path segments for blocked directories
  for (const seg of segments) {
    for (const re of BLOCKED_DIRECTORY_PATTERNS) {
      if (re.test(seg)) {
        return { blocked: true, reason: `path contains blocked directory: ${seg}` };
      }
    }
  }

  return { blocked: false };
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  // Detect whether the secret-store extension is installed by checking
  // for its tools in the active tool set.
  let hasSecretStore = false;

  function detectSecretStore() {
    const allTools = pi.getAllTools();
    const toolNames = allTools.map((t) => t.name);
    hasSecretStore =
      toolNames.includes("get_secret") &&
      toolNames.includes("with_secret");
  }

  // Re-check on session start (all extensions are loaded by then)
  // and before each agent turn (tools may be registered dynamically).
  pi.on("session_start", async () => {
    detectSecretStore();
  });

  // ===========================================================================
  // Override `read`
  // ===========================================================================

  // Get the original read tool implementation to preserve full behavior
  // (truncation, offset/limit, image handling, syntax highlighting, etc.)
  const originalRead = createReadTool(process.cwd());

  pi.registerTool({
    // Spread original definition to inherit name, description, parameters,
    // renderCall, renderResult — preserving syntax highlighting, line numbers,
    // truncation warnings, and all TUI rendering.
    ...originalRead,

    // Override description to mention the guard
    description:
      originalRead.description +
      " Credential files (auth.json, .env, .aws, .ssh/, etc.) are blocked by the credential-guard extension.",

    // Prompt guidelines are kept generic here — they're always present in the
    // system prompt regardless of whether secret-store is installed.
    // Tool-specific guidance (secret-store tools, ask instructions) is injected
    // conditionally via before_agent_start below.
    promptGuidelines: [
      "The read tool blocks access to credential files (auth.json, .env, .aws/credentials, .ssh/, etc.).",
      "Do not attempt to read credential files with bash or other tools either.",
    ],

    // Override execute to add path checking
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const rawPath = (params as { path: string }).path;
      const absolutePath = resolve(ctx.cwd, rawPath);

      const check = isBlocked(absolutePath);
      if (check.blocked) {
        const guidance = hasSecretStore
          ? `Use import_secret to import credentials from this file, then use get_secret / with_secret to access them.`
          : `This credential file is blocked to prevent leakage. Install the secret-store extension for secure credential management (import, retrieval, env-var injection).`;

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Access denied: "${rawPath}" matches a blocked pattern (credential file).\n` +
                `Reason: ${check.reason}\n\n${guidance}`,
            },
          ],
          details: { blocked: true, reason: check.reason },
        };
      }

      // Delegate to the original read tool (wrapped — ctx injected internally)
      return originalRead.execute(_toolCallId, params, signal, onUpdate);
    },
  });

  // ===========================================================================
  // Conditional system prompt injection
  // ===========================================================================

  pi.on("before_agent_start", async (event) => {
    const { systemPromptOptions } = event;
    detectSecretStore();

    const parts: string[] = [];

    if (!hasSecretStore) {
      parts.push(
        "• Credential files (auth.json, .env, .aws/, .ssh/, etc.) are blocked from reading. " +
        "Install the secret-store extension to enable secure credential management tools: " +
        "import_secret (bulk import from files), get_secret/with_secret (retrieval + env-var injection), " +
        "and ask_secret (prompt user for individual values)."
      );
    }

    if (parts.length > 0) {
      return {
        systemPrompt: `${event.systemPrompt}

## Credential Management

${parts.join("\n")}`,
      };
    }

    return undefined;
  });
}
