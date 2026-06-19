# 🔒 Credential Guard

**Blocks reading of credential files and guides the model toward secure secret management tools.** Overrides the built-in `read` tool to prevent accidental credential leakage into session history — with conditional fallback secret tools when the companion `secret-store` extension is absent.

![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)
![MIT License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Pi Extension](https://img.shields.io/badge/pi--extension-orange?style=flat-square)

---

## ✨ Features

- 🚫 **Blocks credential reads** — prevents `read` tool from accessing `auth.json`, `.env`, `.aws`, `.ssh`, etc.
- 🧠 **Companion-aware** — detects `secret-store` extension via `pi.getAllTools()`; adjusts guidance accordingly
- 📋 **Conditional fallback tools** — registers in-memory `ask_secret` / `get_secret` / `with_secret` when secret-store is not installed
- 🔌 **Transparent passthrough** — non-credential files pass through to the original `createReadTool` with full rendering, offsets, images, and syntax highlighting preserved
- 🛡️ **Output redaction** — fallback `with_secret` auto-redacts secret values from command output
- 📝 **Zero value leakage** — tool results never reveal any part of the credential value (no prefix, no length, no character count)

---

## 📦 What It Provides

### Read Guard (always active)

Overrides the built-in `read` tool to block credential file access. Non-blocked reads delegate to the original implementation — all rendering, truncation, offset/limit, and image handling are preserved.

| Scenario | Guidance on blocked file |
|---|---|
| **secret-store installed** | *"Use `import_secret` to import credentials, then `get_secret` / `with_secret` to access them."* |
| **secret-store absent** | *"Use `ask_secret` to enter values manually, then `get_secret` / `with_secret` (session-only, in-memory)."* |

### Fallback Secret Tools (when secret-store absent)

When the companion `secret-store` extension is not loaded, Credential Guard automatically registers lightweight **in-memory** versions of the core secret tools. Values are session-scoped and never persisted to disk. These fallbacks are **silently omitted** when secret-store is detected — its persistent versions take precedence.

| Tool | Description | Storage |
|---|---|---|
| `ask_secret` | Prompt user for a credential via masked TUI dialog | `Map<string, string>` (session only) |
| `get_secret` | Check a secret is accessible — never reveals value | `Map<string, string>` (session only) |
| `with_secret` | Run a command with secret injected as `$SECRET` env var | `Map<string, string>` (session only) |

### Blocked Paths

| Pattern | Examples |
|---------|----------|
| `auth.json` (exact) | `~/.pi/agent/auth.json`, `~/.local/share/opencode/auth.json` |
| `.env`, `.env.*` | `.env`, `.env.local`, `.env.production` |
| `credentials*` | `.aws/credentials`, `credentials.json` |
| `secret*`, `secrets*` | `secrets.json`, `secret.yaml` |
| `*.key`, `*.pem`, `*.p12`, `*.pfx` | `id_rsa`, `cert.pem`, `keystore.p12` |
| `.ssh/` (directory) | SSH private keys |
| `.aws/` (directory) | AWS access keys |
| `.gnupg/` (directory) | GPG keys |
| `gcloud/` (config path) | Google Cloud service account keys |

---

## 🚀 Quick Start

### Minimal (guard + in-memory fallback)

```bash
pi install /path/to/credential-guard
# or: ln -s /path/to/credential-guard ~/.pi/agent/packages/credential-guard && /reload
```

`ask_secret`, `get_secret`, and `with_secret` are available immediately — values stay in memory for the session only.

### Recommended (with persistent secret store)

```bash
pi install /path/to/credential-guard
pi install /path/to/secret-store
/reload
```

`get_secret` / `with_secret` now persist to disk. `import_secret` and custom templates become available.

**Verify:**

```
read(path="~/.aws/credentials")
  → "Access denied: path contains blocked directory: .aws"
  → "Use import_secret to import credentials…"

read(path="src/index.ts")
  → Normal read (syntax highlighting, line numbers, truncation)
```

---

## 💡 Usage Examples

### Blocked credential file (with secret-store)

```
User: "Set up my project from .env"

read(path=".env")
  → credential-guard blocks
  → "Use import_secret to import credentials from this file"
  → import_secret(path=".env") → parses → stores → deletes source
  → get_secret / with_secret for safe access
```

### Blocked credential file (without secret-store)

```
User: "Deploy to AWS"

read(path="~/.aws/credentials")
  → credential-guard blocks
  → "Use ask_secret to manually enter credential values"
  → ask_secret(key="aws_access_key_id", prompt="Enter AWS access key")
  → stored in memory → with_secret for deployment
```

### Non-credential files pass through

```
read(path="src/components/App.tsx")
  → Normal read: syntax highlighting, line numbers, offset/limit, truncation warnings
```

### Fallback secret flow

```
User: "Push to GitHub"

Agent: ask_secret(key="github_token", prompt="Enter your GitHub PAT")
  → User pastes in masked dialog → "Secret 'github_token' stored (session-only)"
  → with_secret(key="github_token", command="curl -H 'Authorization: Bearer $SECRET' ...")
  → Secret injected as env var, never in session history
```

---

## 🔌 Companion Extension: Secret Store

Credential Guard provides in-memory fallbacks on its own. For **persistent storage** and **bulk file import**, pair it with the [Secret Store](https://github.com/Immac/pi-utils-secret-store) extension:

| Capability | Credential Guard alone | + Secret Store |
|------------|----------------------|----------------|
| Read blocking | ✅ Always active | ✅ Always active |
| `ask_secret` | ✅ In-memory (session only) | ✅ Persisted to `auth.json` |
| `get_secret` / `with_secret` | ✅ In-memory (session only) | ✅ Persisted, survives restarts |
| `import_secret` | ❌ Not available | ✅ Bulk import `.env` / JSON / INI |
| Custom templates | ❌ Not available | ✅ `import_secret_template_add` |

### Protection Loop

```
read(path="~/.aws/credentials")
  └─ credential-guard blocks
       └─ "Use import_secret to import this file"
            └─ import_secret(path="~/.aws/credentials")
                 └─ Parsed → stored persistently → source optionally deleted
                      └─ get_secret / with_secret (survives restarts)
```

---

## 🛠️ Development

```bash
npm run validate   # tsc --noEmit --skipLibCheck
```

### Project Structure

```
credential-guard/
├── package.json                  # ESM package, pi extension entry
├── tsconfig.json                 # TypeScript config (ES2022, strict)
├── src/extensions/credential-guard/
│   └── credential-guard.ts       # Extension entry: read override, fallback tools, lifecycle
└── README.md
```

### Prerequisites

- Node.js 18+
- `@earendil-works/pi-coding-agent` (peer dependency)

---

## 📖 Resources

- [Pi Extension Docs — Tool Overrides](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md#overriding-built-in-tools)
- [Secret Store](https://github.com/Immac/pi-utils-secret-store) — companion extension for credential management
- [tool-override.ts example](https://github.com/earendil-works/pi-coding-agent/blob/main/examples/extensions/tool-override.ts)
- [AuthStorage API](https://github.com/earendil-works/pi-coding-agent)

---

## 📄 License

MIT
