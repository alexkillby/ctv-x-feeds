# ctv-x-feeds

Dynamic `@alexkillby` X following feed for **CTV News Android TV** (`SPECIAL_EVENTS` / `E1, E2, ...` channels).

## How It Works

1. **Browser Userscript (`ctv-x-following-sync.user.js`)**:
   - Runs in Tampermonkey or Violentmonkey whenever you browse `x.com` — **at most once every 24 hours**.
   - Silently reads `@alexkillby`'s public Following list via X's own web client (excluding private/protected or zero-post accounts) and commits `x-following.json` to this repository.
2. **Standalone Live Detection on Nvidia Shield**:
   - **You do NOT need `x.com` or your computer open while watching TV.**
   - `ChannelRepository` fetches `x-following.json` from this repository (caching a local copy on-device) and independently probes the synced X handles in the background with bounded concurrency to populate active live broadcasts into the **Live Events & Specials (`E1`, `E2`, ...)** channel group.

---

## One-Time Browser Setup (2 minutes)

1. Install **[Tampermonkey](https://www.tampermonkey.net/)** or **[Violentmonkey](https://violentmonkey.github.io/)** in your desktop browser.
2. Click the raw userscript link to install in 1 click:
   👉 **[Install `ctv-x-following-sync.user.js`](https://github.com/alexkillby/ctv-x-feeds/raw/main/ctv-x-following-sync.user.js)**
3. Create a **Fine-Grained GitHub Personal Access Token** scoped **only** to this repository:
   - Open **[GitHub → Fine-grained tokens → Generate new token](https://github.com/settings/personal-access-tokens/new)**
   - **Token name**: `ctv-x-feeds-userscript`
   - **Repository access**: *Only select repositories* → select **`alexkillby/ctv-x-feeds`**
   - **Repository permissions**: **Contents** → **Read and write**
   - Generate and copy the `github_pat_...` token.
4. Visit **[x.com](https://x.com)** while signed in as `@alexkillby`, click the Tampermonkey extension icon → **`🔑 Set GitHub Token (ctv-x-feeds)`**, and paste your token.
   - It will immediately run your first sync and automatically refresh at most once every 24 hours whenever you happen to open `x.com`.
   - You can also trigger **`🔄 Sync @alexkillby Following Now`** or **`⚙️ Set Minimum Follower Filter`** anytime from the Tampermonkey menu.
