# Credential Guard — Architecture

## Purpose & Goals

Credential Guard prevents accidental credential leakage through the `read` tool by intercepting access to known credential file paths and redirecting the LLM toward secure secret management tools. Its core design goals:

1. **Zero credential leakage** — block `read` on all known credential file paths before any data reaches the LLM
2. **Companion-aware** — detect whether `secret-store` is installed and give the best actionable guidance
3. **Self-sufficient** — provide in-memory fallback secret tools when the full store is not available
4. **Transparent** — non-credential files pass through to the original `read` implementation unchanged

---

## System Components

```
┌──────────────────────────────────────────────────────────────┐
│                    LLM Agent (tool calls)                    │
└──────────────┬──────────────────────────────┬───────────────-┘
               │                              │
               ▼                              ▼
┌──────────────────────────┐    ┌──────────────────────────────┐
│     read (overridden)    │    │  Fallback tools (optional)   │
│                          │    │                              │
│  credential-guard.ts     │    │  Only registered when        │
│                          │    │  secret-store is NOT present  │
│  1. isBlocked() check ───▼──►│                              │
│     ┌───────┐    ┌────────┐  │  ask_secret (in-memory)      │
│     │blocked│    │allowed │  │  get_secret (in-memory)      │
│     └───┬───┘    └───┬────┘  │  with_secret (in-memory)     │
│         │            │       └──────────────────────────────┘
│         ▼            ▼
│   return deny    originalRead
│   message       .execute()
│                 (full render,
│                  images,
│                  offset/limit,
│                  truncation)
└──────────────────────────┘
```

### State & Detection

```
┌───────────────────────────────┐
│        Runtime State           │
│                               │
│  hasSecretStore: boolean      │
│    → set via detectSecretStore│
│    → checked on session_start │
│    → checked on each read()   │
│                               │
│  fallbackSecrets: Map<k,v>    │
│    → populated by ask_secret  │
│    → read by get/with_secret  │
│    → cleared on session end   │
│                               │
│  fallbackToolsRegistered: bool│
│    → guard to register once   │
└───────────────────────────────┘
```

---

## Key Principles

### 1. Tool Override Pattern

Credential Guard overrides the built-in `read` tool by spreading the original definition and replacing only the `execute` function:

```typescript
const originalRead = createReadTool(process.cwd());

pi.registerTool({
  ...originalRead,                           // name, description, params, renderCall, renderResult
  description: originalRead.description + " Credential files (...) are blocked by credential-guard.",
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    const check = isBlocked(absolutePath);
    if (check.blocked) { /* return denial */ }
    return originalRead.execute(_toolCallId, params, signal, onUpdate);  // passthrough
  },
});
```

This preserves all rendering (syntax highlighting, line numbers, truncation warnings), parameter validation, and TUI output of the original tool — only the security check is added.

### 2. Multi-Level Path Blocking

The `isBlocked()` function checks three tiers:

| Tier | Check | Examples |
|------|-------|----------|
| **Exact path** | Resolve `~` then compare absolute | `~/.pi/agent/auth.json` |
| **Filename pattern** | Regex on the filename segment | `.env`, `credentials.json`, `id_rsa.key` |
| **Directory pattern** | Check each path segment | `.ssh/`, `.aws/`, `.gnupg/` |

All three are checked independently — a file is blocked if any tier matches.

### 3. Companion Detection via Tool Names

The extension detects the secret-store companion by scanning registered tools:

```typescript
function detectSecretStore() {
  const allTools = pi.getAllTools();
  const toolNames = allTools.map((t) => t.name);
  hasSecretStore =
    toolNames.includes("get_secret") &&
    toolNames.includes("with_secret");
}
```

This is checked on `session_start` (to decide whether to register fallback tools) and on every blocked `read` call (to give the best guidance).

### 4. Conditional Fallback Tools

When secret-store is absent, the extension registers in-memory versions of three tools. These are:
- **Registered once** — guarded by `fallbackToolsRegistered` flag
- **Session-scoped** — stored in a `Map<string, string>` that is never persisted
- **Transparently replaced** — if secret-store is later installed (reload), the fallbacks are superseded by persistent versions with the same tool names

### 5. Zero Value Leakage

The fallback tools follow the same policy as the main secret-store:
- `ask_secret` result: *"Secret 'x' stored (session-only)."* — no value, no length
- `get_secret` result: *"Secret 'x' (session-only) retrieved."* — no value, no length
- `with_secret` output: secret auto-redacted via `[REDACTED]` replacement in stdout/stderr

---

## Interaction Flows

### Flow 1: Blocked credential file (secret-store present)

```
read(path="~/.aws/credentials")
  │
  ├─ resolve(ctx.cwd, "~/.aws/credentials")
  │     → /home/user/.aws/credentials
  │
  ├─ isBlocked("/home/user/.aws/credentials")
  │     ├─ Exact path: no match
  │     ├─ Filename: "credentials" → matches /^credentials(\.\w+)?$/i ✓
  │     └─→ { blocked: true, reason: "matches blocked filename pattern: credentials(\\.\\w+)?" }
  │
  ├─ detectSecretStore()
  │     → hasSecretStore = true (get_secret + with_secret found)
  │
  └─ Result:
       "Access denied: '~/.aws/credentials' matches credential store.
        Reason: matches blocked filename pattern: ...
        Use import_secret to import credentials from this file,
        then use get_secret / with_secret to access them."
```

### Flow 2: Allowed non-credential file

```
read(path="src/components/App.tsx")
  │
  ├─ isBlocked("/home/user/project/src/components/App.tsx")
  │     ├─ Exact path: no match
  │     ├─ Filename: "App.tsx" → no regex matches
  │     ├─ Directories: "src", "components" → no directory matches
  │     └─→ { blocked: false }
  │
  └─ return originalRead.execute(...)
       → Full rendering: syntax highlighting, line numbers, truncation, images
```

### Flow 3: Session startup

```
session_start
  │
  ├─ detectSecretStore()
  │     → pi.getAllTools() → ["read", "edit", "bash", ...]
  │     → no "get_secret" → hasSecretStore = false
  │
  ├─ registerFallbackTools()
  │     ├─ pi.registerTool({ name: "ask_secret", ... })
  │     ├─ pi.registerTool({ name: "get_secret", ... })
  │     └─ pi.registerTool({ name: "with_secret", ... })
  │
  └─ Agent can now use ask_secret / get_secret / with_secret

--- later in conversation ---

ask_secret(key="github_token", prompt="Enter PAT")
  → fallbackSecrets.set("github_token", "ghp_abc123")
  → "Secret 'github_token' stored (session-only)."

with_secret(key="github_token", command="curl -H 'Authorization: Bearer $SECRET' ...")
  → fallbackSecrets.get("github_token") → "ghp_abc123"
  → execAsync with { env: { SECRET: "ghp_abc123" } }
  → stdout returned, value auto-redacted from output
```

---

## Lifecycle & State

### State Variables

| Variable | Type | Purpose |
|----------|------|---------|
| `hasSecretStore` | `boolean` | Whether companion secret-store was detected on last check |
| `fallbackSecrets` | `Map<string, string>` | In-memory credential storage (fallback mode only) |
| `fallbackToolsRegistered` | `boolean` | Guard to prevent double-registering fallback tools |

### Boot Order

1. Module loads → `credential-guard.ts` evaluated
2. Plugin factory `default function(pi: ExtensionAPI)` called
   - `originalRead = createReadTool(process.cwd())` — captures original read
   - Override `read` tool registered (always, replaces built-in)
   - Fallback tool registration functions defined but NOT called yet
   - `session_start` and `before_agent_start` handlers registered
3. `session_start` → `detectSecretStore()` → `registerFallbackTools()` if absent
4. Runtime: `read` override active, fallback tools available if registered
5. `before_agent_start` → (currently no-op, but available for system prompt injection)

---

## Project Structure

```
credential-guard/
├── package.json
├── tsconfig.json
├── src/extensions/credential-guard/
│   └── credential-guard.ts    # ~350 lines: all logic in one file
└── README.md
```

Single-file design by intent — the extension's responsibility is narrow:
1. Intercept `read` → check path → allow or deny
2. Optionally provide in-memory secret tools

No parser modules, no test suite, no skills — the companion secret-store extension handles those concerns.
