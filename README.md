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

## 📦 What It Does

Credential Guard overrides the single `read` tool. When a blocked path is detected, it returns a guidance message instead of file contents:

| Scenario | Block message says |
|---|---|
| secret-store installed | *"Use `import_secret` to import credentials, then `get_secret` / `with_secret` to access them."* |
| secret-store not installed | *"Blocked. Install the secret-store extension for secure credential management."* |

Allowed reads pass through to the original `read` implementation unchanged — all rendering, truncation, offset/limit, and image handling are preserved.

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

```bash
pi install /path/to/credential-guard
# or: cp -r credential-guard ~/.pi/agent/extensions/credential-guard && /reload
```

Then install the companion for full credential management:

```bash
pi install /path/to/secret-store
/reload
```

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

For the best experience, pair Credential Guard with the [Secret Store](https://github.com/Immac/pi-utils-secret-store) extension:

| Tool | Purpose |
|---|---|
| `ask_secret` | Prompt user for a credential, store securely |
| `get_secret` | Retrieve metadata without leaking values |
| `with_secret` | Run commands with secret injected as env var |
| `import_secret` | Bulk import from `.env`, JSON, INI, or custom template |

### How they work together

```
read(path="~/.aws/credentials")
  └─ credential-guard blocks
       └─ "Use import_secret to import this file"
            └─ import_secret(path="~/.aws/credentials")
                 └─ Parsed as INI → stored as aws:default:aws_access_key_id
                      └─ Source file optionally deleted
                           └─ Values available via get_secret / with_secret
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
