# 🔒 Credential Guard

**Blocks reading of credential files and guides the model toward secure secret management tools.**

---

## How It Works

Overrides the built-in `read` tool to block access to known credential file paths:

| Pattern | Examples blocked |
|---------|-----------------|
| `auth.json` | `~/.pi/agent/auth.json` |
| `.env`, `.env.*` | `.env`, `.env.local`, `.env.production` |
| `credentials*` | `.aws/credentials`, `credentials.json` |
| `secret*`, `*.key`, `*.pem` | `secrets.json`, `id_rsa`, `cert.pem` |
| `.ssh/`, `.aws/`, `.gnupg/` | SSH keys, AWS creds, GPG keys |

When a read is blocked, the extension checks whether the **secret-store** companion extension is installed:

| secret-store installed? | Block message says |
|------------------------|-------------------|
| ✅ Yes | *"Use `import_secret` to import credentials, then `get_secret` / `with_secret` to access them."* |
| ❌ No | *"Use `ask_secret` to store individual values. Install secret-store for full credential management."* |

## Installation

```bash
pi install /path/to/credential-guard
```

Or copy to auto-discovery:
```bash
cp -r credential-guard ~/.pi/agent/extensions/credential-guard
```

Then `/reload`.

## Companion Extension

For the best experience, install the **secret-store** extension alongside credential-guard:

- `ask_secret` — prompt user for a credential, store securely
- `get_secret` — retrieve metadata without leaking values
- `with_secret` — run commands with secret injected as env var
- `import_secret` — bulk import from `.env`, JSON, INI, or custom template

## System Prompt Injection

When secret-store is NOT detected, the extension injects a `Credential Management` section into the system prompt via `before_agent_start`, guiding the model toward `ask_secret` and suggesting installation of the secret-store extension.

## Design

```
read(path="~/.aws/credentials")
  → credential-guard intercepts
    → is it a blocked path? YES
      → has secret-store? → guide toward import_secret/get_secret/with_secret
      → no secret-store?  → guide toward ask_secret and suggest install
```

## License

MIT
