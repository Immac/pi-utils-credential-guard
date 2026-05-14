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

import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";

const execAsync = promisify(execCb);

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

  // In-memory secret store used when secret-store extension is absent.
  // Values are session-scoped and never persisted to disk.
  const fallbackSecrets = new Map<string, string>();
  let fallbackToolsRegistered = false;

  // Register fallback secret tools if secret-store extension is not installed.
  // These are in-memory-only versions that work without the persistent store.
  function registerFallbackTools() {
    if (fallbackToolsRegistered) return;
    fallbackToolsRegistered = true;

    // =======================================================================
    // Fallback: ask_secret
    // =======================================================================

    pi.registerTool({
      name: "ask_secret",
      label: "Ask Secret (session)",
      description:
        "Prompt the user to enter a secret value (password, API key, token, etc.) " +
        "and store it in memory for the current session. The value is never persisted to disk. " +
        "Use this when you need a credential the user hasn't provided yet.",
      promptSnippet: "Prompt the user for a secret and store it in memory (session-only)",
      promptGuidelines: [
        "Use ask_secret to get credentials from the user. Values are kept in memory for the session only.",
        "Use get_secret to retrieve a stored secret, then with_secret to run a command with it as an env var.",
      ],
      parameters: Type.Object({
        key: Type.String({ description: "Identifier for the secret (e.g., 'github_token', 'db_password')." }),
        prompt: Type.String({ description: "The prompt message to show the user when asking for the secret." }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const { key, prompt: promptText } = params;

        if (fallbackSecrets.has(key)) {
          const overwrite = await ctx.ui.confirm(
            "Overwrite Secret?",
            `A secret for "${key}" already exists in this session. Overwrite?`
          );
          if (!overwrite) {
            return {
              content: [{ type: "text" as const, text: `Secret "${key}" was not modified.` }],
              details: { stored: false, key },
            };
          }
        }

        const value = await ctx.ui.input(`🔐 ${promptText}`, "");
        if (value === undefined || value.trim() === "") {
          return {
            content: [{ type: "text" as const, text: `User cancelled the prompt for "${key}".` }],
            details: { stored: false, key },
          };
        }

        fallbackSecrets.set(key, value);

        return {
          content: [
            {
              type: "text" as const,
              text: `Secret "${key}" stored in memory (${value.length} chars, session-only). ` +
                `Use with_secret(key="${key}", command="...") to use it.`,
            },
          ],
          details: { stored: true, key, valueLength: value.length, persisted: false },
        };
      },
    });

    // =======================================================================
    // Fallback: get_secret
    // =======================================================================

    pi.registerTool({
      name: "get_secret",
      label: "Get Secret (session)",
      description:
        "Retrieve a previously stored in-memory secret by its key. " +
        "The secret is cached in memory so you can use it with with_secret — " +
        "the raw value is never exposed in tool result content. " +
        "If the secret doesn't exist, use ask_secret first.",
      promptSnippet: "Retrieve a stored secret by key (session-only)",
      parameters: Type.Object({
        key: Type.String({ description: "The identifier of the secret to retrieve." }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const { key } = params;

        if (!fallbackSecrets.has(key)) {
          return {
            content: [
              { type: "text" as const, text: `No secret found for "${key}". Use ask_secret first.` },
            ],
            details: { found: false, key },
          };
        }

        const value = fallbackSecrets.get(key)!;

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Secret "${key}" (${value.length} chars, session-only) retrieved. ` +
                `Use with_secret(key="${key}", command="...") to use it.`,
            },
          ],
          details: { found: true, key, valueLength: value.length, persisted: false },
        };
      },
      renderCall(args, theme, _context) {
        return new Text(
          theme.fg("toolTitle", theme.bold("get_secret ")) +
          theme.fg("accent", args.key),
          0, 0
        );
      },
      renderResult(result, _options, theme, _context) {
        const details = result.details as { found: boolean; key: string } | undefined;
        if (!details?.found) {
          return new Text(theme.fg("warning", `⚠ Secret "${details?.key ?? "?"}" not found`), 0, 0);
        }
        return new Text(
          theme.fg("success", "✓ ") +
          theme.fg("accent", details.key) +
          theme.fg("muted", " (session) → ready for with_secret"),
          0, 0
        );
      },
    });

    // =======================================================================
    // Fallback: with_secret
    // =======================================================================

    pi.registerTool({
      name: "with_secret",
      label: "With Secret (session)",
      description:
        "Run a shell command with a previously stored secret injected as an " +
        "environment variable. The secret is retrieved from the in-memory store " +
        "and injected directly into the subprocess environment. " +
        "It never appears in tool result content, session history, or bash history.\n\n" +
        "The secret is available as \\$SECRET inside the command by default. " +
        "Use envVarName to pick a different variable name.",
      promptSnippet: "Run a command with a stored secret injected as $SECRET env var",
      promptGuidelines: [
        "Use with_secret after get_secret to use a secret without leaking it into conversation history.",
        "The secret is available as \\$SECRET by default. Set envVarName to change the variable name.",
      ],
      parameters: Type.Object({
        key: Type.String({ description: "The key of the secret to use (stored via ask_secret)." }),
        command: Type.String({
          description:
            "The shell command to run. Reference the secret via \\$SECRET (or the name " +
            "specified in envVarName).",
        }),
        envVarName: Type.Optional(
          Type.String({ description: "Environment variable name to inject the secret into (default: SECRET)." })
        ),
        timeout: Type.Optional(
          Type.Number({ description: "Timeout in milliseconds (default: 60000)." })
        ),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const { key, command, envVarName, timeout } = params;

        if (!fallbackSecrets.has(key)) {
          return {
            content: [
              { type: "text" as const, text: `Secret "${key}" is not stored. Use ask_secret first.` },
            ],
            details: { executed: false, key, reason: "not_found" },
          };
        }

        const secret = fallbackSecrets.get(key)!;
        const varName = envVarName || "SECRET";

        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: ctx.cwd,
            env: { ...process.env, [varName]: secret },
            timeout: timeout ?? 60_000,
            maxBuffer: 50 * 1024,
            signal,
          });

          return {
            content: [{ type: "text" as const, text: stdout || "(no output)" }],
            details: { executed: true, key, envVar: varName, exitCode: 0, stderr },
          };
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: e.stderr || e.message }],
            details: { executed: true, key, envVar: varName, exitCode: e.code ?? 1, stderr: e.stderr },
          };
        }
      },
      renderCall(args, theme, _context) {
        const varName = args.envVarName || "SECRET";
        return new Text(
          theme.fg("toolTitle", theme.bold("with_secret ")) +
          theme.fg("accent", args.key) +
          theme.fg("muted", ` → \\$${varName}`),
          0, 0
        );
      },
      renderResult(result, _options, theme, _context) {
        const details = result.details as { executed: boolean; key: string; exitCode?: number } | undefined;
        if (!details?.executed) {
          return new Text(theme.fg("warning", `⚠ with_secret: not found`), 0, 0);
        }
        const code = details.exitCode ?? 0;
        const status = code === 0
          ? theme.fg("success", "✓ ")
          : theme.fg("error", `✗ (exit ${code}) `);
        return new Text(status + theme.fg("accent", details.key), 0, 0);
      },
    });
  }

  // On session start, check if secret-store is present.
  // If not, register in-memory fallback tools so the user has something to use.
  pi.on("session_start", async () => {
    detectSecretStore();
    if (!hasSecretStore) {
      registerFallbackTools();
    }
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
          : `Use ask_secret to manually enter credential values, then get_secret / with_secret to use them. For bulk import from files, install the secret-store extension.`;

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
      // When secret-store is absent, credential-guard registers its own
      // in-memory ask_secret / get_secret / with_secret as session-only fallbacks.
      // No additional guidance needed — the tools are available and self-documenting.
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
