# Multiple GitHub Accounts on One Mac

How to run two (or more) GitHub accounts simultaneously on macOS using SSH key aliases, and how to fix the Mac keychain issue that causes both aliases to authenticate as the same account.

---

## Setup

### 1. Generate a separate SSH key for each account

```bash
# Work account (if not already done)
ssh-keygen -t ed25519 -C "you@work.com" -f ~/.ssh/id_ed25519

# Personal account
ssh-keygen -t ed25519 -C "you@personal.com" -f ~/.ssh/id_ed25519_personal
```

### 2. Add each public key to its respective GitHub account

```bash
# Copy work key → paste into work GitHub account
pbcopy < ~/.ssh/id_ed25519.pub

# Copy personal key → paste into personal GitHub account
pbcopy < ~/.ssh/id_ed25519_personal.pub
```

GitHub → Settings → SSH and GPG keys → New SSH key

### 3. Configure SSH host aliases

Edit `~/.ssh/config` (create it if it doesn't exist):

```
Host github.com-work
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes

Host github.com-personal
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_personal
  IdentitiesOnly yes
```

> **Important:** Use spaces, not tabs, for indentation. Tabs silently break SSH config parsing.

> **`IdentitiesOnly yes`** is the critical line — it forces SSH to use only the key in `IdentityFile` and ignore anything the keychain/agent offers. Without it, the Mac SSH agent overrides your config and always authenticates as whichever account it cached first.

### 4. Register keys with the SSH agent (persists across reboots on macOS)

```bash
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
ssh-add --apple-use-keychain ~/.ssh/id_ed25519_personal
```

### 5. Verify both aliases

```bash
ssh -T git@github.com-work
# → Hi nobu-shopify! You've successfully authenticated...

ssh -T git@github.com-personal
# → Hi NobuHayashi916! You've successfully authenticated...
```

---

## Using the aliases in Git remotes

Use the host alias in place of `github.com` when setting remotes:

```bash
# Personal project
git remote add origin git@github.com-personal:NobuHayashi916/repo-name.git

# Work project
git remote add origin git@github.com-work:nobu-shopify/repo-name.git

# Fix an existing remote
git remote set-url origin git@github.com-personal:NobuHayashi916/repo-name.git
```

---

## Fixing the Mac keychain issue

**Symptom:** Both `ssh -T git@github.com-work` and `ssh -T git@github.com-personal` return the same account.

**Cause:** The macOS SSH agent caches credentials in the system keychain and offers all of them regardless of your SSH config, unless `IdentitiesOnly yes` is set.

**Fix:**

```bash
# 1. Clear all keys from the agent
ssh-add -D

# 2. Re-add both keys to the keychain
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
ssh-add --apple-use-keychain ~/.ssh/id_ed25519_personal

# 3. Ensure IdentitiesOnly yes is set in ~/.ssh/config (see above)

# 4. Test
ssh -T git@github.com-work
ssh -T git@github.com-personal
```

---

## Quick reference

| Task | Command |
|------|---------|
| List keys in agent | `ssh-add -l` |
| Clear all agent keys | `ssh-add -D` |
| Add key to macOS keychain | `ssh-add --apple-use-keychain ~/.ssh/key` |
| Test an alias | `ssh -T git@github.com-personal` |
| Show current remote | `git remote -v` |
| Change remote URL | `git remote set-url origin git@github.com-personal:user/repo.git` |
