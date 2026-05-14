# 🔒 Credential Guard

**Blocks reading of credential files and guides the model toward secure secret management tools.** Overrides the built-in `read` tool to prevent accidental credential leakage into session history.

![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)
![MIT License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Pi Extension](https://img.shields.io/badge/pi--extension-orange?style=flat-square)

---

## ✨ Features

- 🚫 **Blocks credential reads** — prevents `read` tool from accessing auth.json, .env, .aws, .ssh, etc.
- 🧠 **Secret-store aware** — detects companion `secret-store` extension via `pi.getAllTools()`
- 📋 **Conditional guidance** — block message differs based on whether secret-store is installed
- 📝 **System prompt injection** — adds `Credential Management` section when secret-store is absent
- 🔌 **Non-invasive** — spreads original tool definition, delegates allowed reads to the original `createReadTool`

---

## 📦 What It Provides

### Read guard (always active)

Overrides the built-in `read` tool to block credential file access. Allowed reads pass through unchanged — all rendering, truncation, offset/limit, and image handling are preserved.

| Scenario | Blocked file guidance |
|---|---|
| secret-store installed | *"Use `import_secret` to import credentials, then `get_secret` / `with_secret` to access them."* |
| secret-store not installed | *"Use `ask_secret` to enter values manually, then `get_secret`/`with_secret` to use them (session-only, in-memory)."* |

### Fallback secret tools (when secret-store absent)

If the companion `secret-store` extension is not installed, Credential Guard registers lightweight **in-memory** versions of the core secret tools. Values are session-scoped and never persisted to disk:

| Tool | Description | Storage |
|---|---|---|
| `ask_secret` | Prompt the user for a credential via TUI dialog | In-memory `Map` (session only) |
| `get_secret` | Retrieve metadata (key, length) — value cached in memory | In-memory `Map` |
| `with_secret` | Run a command with secret injected as env var | In-memory `Map` |

These fallbacks are **automatically omitted** when the full `secret-store` extension is detected — its persistent versions take precedence.

### Blocked paths

| Pattern | Examples |
|---|---|
| `auth.json` | `~/.pi/agent/auth.json`, `~/.local/share/opencode/auth.json` |
| `.env`, `.env.*` | `.env`, `.env.local`, `.env.production` |
| `credentials*` | `.aws/credentials`, `credentials.json` |
| `secret*`, `secrets*` | `secrets.json`, `secret.yaml` |
| `*.key`, `*.pem`, `*.p12`, `*.pfx` | `id_rsa`, `cert.pem`, `keystore.p12` |
| `.ssh/` | SSH private keys |
| `.aws/` | AWS access keys |
| `.gnupg/` | GPG keys |

---

## 🚀 Quick Start

### Minimal (credential guard + in-memory fallback)

```bash
pi install /path/to/credential-guard
# or: cp -r credential-guard ~/.pi/agent/extensions/credential-guard && /reload
```

`ask_secret`, `get_secret`, and `with_secret` are available immediately — values stay in memory for the session only.

### Recommended (with persistent secret store)

```bash
pi install /path/to/credential-guard
pi install /path/to/secret-store
/reload
```

`get_secret` / `with_secret` now persist to disk. `import_secret` and custom templates become available.

---

## 💡 Usage Examples

No explicit invocation needed — the guard works automatically whenever `read` is called:

```
# Without credential-guard:
read(path="~/.aws/credentials")
  → File contents returned → credentials leaked into session

# With credential-guard:
read(path="~/.aws/credentials")
  → "Access denied: matches credential store path"
  → "Use import_secret to import credentials, then get_secret/with_secret"

# Non-credential files are unaffected:
read(path="src/index.ts")
  → Normal read (syntax highlighting, line numbers, truncation)
```

---

## 🔌 Companion Extension: Secret Store

Credential Guard provides in-memory fallbacks on its own. For **persistent storage** and **bulk file import**, pair it with the [Secret Store](https://github.com/Immac/pi-utils-secret-store) extension:

| Tool | Purpose | Upgrade from fallback… |
|---|---|---|
| `ask_secret` | Prompt user for a credential, **persist to disk** | In-memory only → persisted to `auth.json` |
| `get_secret` / `with_secret` | Retrieve + use credentials | Same API, but values survive restarts |
| `import_secret` | Bulk import from `.env`, JSON, INI, or custom template | Not available in fallback |
| `import_secret_template_add/list/remove` | Custom regex templates for non-standard formats | Not available in fallback |

### How they work together

**With secret-store installed (recommended):**

```
read(path="~/.aws/credentials")
  └─ credential-guard blocks
       └─ "Use import_secret to import this file"
            └─ import_secret(path="~/.aws/credentials")
                 └─ Parsed → stored persistently → source optionally deleted
                      └─ get_secret / with_secret (survives restarts)
```

**Without secret-store (fallback mode):**

```
read(path="~/.aws/credentials")
  └─ credential-guard blocks
       └─ "Use ask_secret to enter values manually"
            └─ ask_secret(key="aws_key", prompt="Enter AWS key")
                 └─ Stored in memory (session only)
                      └─ get_secret / with_secret (lost on restart)
```

---

## 🛠️ Development

```bash
npm run validate   # tsc --noEmit --skipLibCheck
```

### Project Structure

```
credential-guard/
├── package.json
├── tsconfig.json
├── src/extensions/credential-guard/
│   └── credential-guard.ts    # Extension entry: read override + system prompt injection
└── README.md
```

---

## 📖 Resources

- [Pi Extension Docs — Tool Overrides](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md#overriding-built-in-tools)
- [Secret Store](https://github.com/Immac/pi-utils-secret-store) — companion extension for credential management
- [tool-override.ts example](https://github.com/earendil-works/pi-coding-agent/blob/main/examples/extensions/tool-override.ts)

---

## 📄 License

MIT
