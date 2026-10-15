---
name: transient-ui-validation
description: How to black-box validate transient UI states in <Product Name> — isFetching/refetch spinners, isPending double-submit guards, and login context headers/stores. Use for tickets about "missing loading indicator", "spinner on refetch", "double submit", context headers (tenant/store), or any state that only exists for a split second during a background refetch or a pending mutation.
---

# Transient UI State Validation — <Product Name> QA

Some tickets are about states that **only exist for a moment**: a spinner shown *while a
background refetch is in flight*, a button disabled *while a mutation is pending*, a tenant/store
context set *at the instant of login*. A normal "navigate + snapshot" pass CANNOT see them —
by the time you snapshot, the moment is gone. This skill is the playbook for forcing and
capturing those states deterministically.

Applies to React apps using React Query (TanStack Query). Read this before any "loading
indicator / refetch / double-submit / context-header" ticket.

---

## 1. The key distinction: `isFetching` vs `isLoading`

React Query exposes two flags. Most of these bugs are "the code only checks `isLoading`,
never `isFetching`":

| Flag | When true | UI (correct fix) | Proves the fix? |
|------|-----------|------------------|-----------------|
| `isLoading` | **first** load, **no cached data** | skeleton / blank (data hidden) | ❌ shows even pre-fix |
| `isFetching` | **background refetch**, cached data present | spinner **+ old data stays visible** | ✅ this is the fix |

**The whole game is producing `isFetching = true` while `isLoading = false`** (cached data
on screen + a background refetch running). If the data disappears to a skeleton, you
triggered `isLoading` (e.g. a query-key change) — that does NOT prove an `isFetching` fix.

---

## 2. Why the easy triggers often DON'T work

Queries configured with `refetchOnWindowFocus`/`refetchOnReconnect` **off** and a **high
`staleTime`** will show no refetch (`delta = 0`) for any of these:

- SPA-navigate away and back — query stays mounted / fresh.
- `window.focus` / `visibilitychange` events.
- CDP focus emulation toggle (frozen ↔ active).
- Browser offline → online (`context.setOffline`) + dispatched `online` event.

And a **tenant/store switch** may refetch, but it usually changes the scoping id → **new query
key** → `isLoading` (data blanks to skeleton), NOT `isFetching`. Useless for proving the fix.

**Conclusion:** the only reliable, safe, black-box way to get a background refetch with the
cache intact is to invalidate the exact query yourself (§3). The only *natural* triggers are
a mutation-invalidation (e.g. a real payment/submit — often unsafe, hits an external gateway) or
React Query Devtools.

---

## 3. THE TECHNIQUE — invalidate the exact query + delay its response

1. **Delay the endpoint** so the transient spinner persists long enough to poll + screenshot:
   ```ts
   await page.route('**/api/<path-of-the-query>**', async route => {
     await new Promise(r => setTimeout(r, 6000)); // hold the response ~6s
     await route.continue();
   });
   ```
2. **Reach the app's React Query client via the React fiber** and `invalidateQueries` on the
   exact key. `invalidateQueries` on a **mounted** query with cached data → background
   refetch → `isFetching = true`, data stays visible.
3. **Poll** for the spinner (~110ms interval) and, when you see it, screenshot immediately —
   AND record that the cached values are **still on screen** (that's the `isFetching` proof).

### Getting the QueryClient off the fiber (copy-paste, esbuild-safe)

```ts
async function invalidate(page, keyPattern: string) {
  return await page.evaluate((pat) => {
    const rx = new RegExp(pat, 'i');
    const hosts = document.querySelectorAll('#root, #__next, body > div');
    let client: any = null;
    for (let h = 0; h < hosts.length && !client; h++) {
      const host: any = hosts[h]; let start: any = null;
      for (const k in host) {
        if (k.indexOf('__reactContainer$') === 0) { start = host[k]?.current ?? host[k]; break; }
        if (k.indexOf('__reactFiber$') === 0) { start = host[k]; break; }
      }
      if (!start) continue;
      const stack = [start]; let seen = 0;
      while (stack.length && seen < 40000 && !client) {
        const f = stack.pop(); seen++; if (!f) continue;
        const mp = f.memoizedProps;
        if (mp && mp.client && typeof mp.client.getQueryCache === 'function') { client = mp.client; break; }
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    }
    if (!client) return { found: false };
    const all = client.getQueryCache().getAll();
    const keys: string[] = []; let matched = 0;
    for (let i = 0; i < all.length; i++) {
      const s = JSON.stringify(all[i].queryKey); keys.push(s.slice(0, 90));
      if (rx.test(s)) { matched++; try { client.invalidateQueries({ queryKey: all[i].queryKey }); } catch (e) {} try { all[i].fetch(); } catch (e) {} }
    }
    return { found: true, total: all.length, matched, keys }; // dump keys first to learn them
  }, keyPattern);
}
```

**Always dump `keys` first** (pass a pattern that matches nothing) to learn the real
query-key shape, THEN invalidate with a matching pattern. The keys are arrays, e.g.
`["orders","summary","<id>"]` — match against the JSON-serialized key (`orders","summary`
matches; the endpoint name `order-summary` does NOT).

### Detecting the spinner + proving data stayed

```ts
// spinner selectors (adapt to your app's component library):
'.animate-spin, svg.lucide-loader-2, [class*="animate-spin"]'
```
Poll `document.querySelectorAll(spinSel).length > 0` AND that the card/table values are
still present. Expect the spinner to last about as long as your route delay while all cached
values stay on screen; some screens show an explicit text such as "Refreshing …" while the
section stays mounted.

---

## 4. Two gotchas that will waste an hour

- **tsx / esbuild `__name` bug:** inside `page.evaluate`, do NOT declare named functions or
  `const fn = () => …`. esbuild injects an undefined `__name` helper → `ReferenceError`.
  Use plain `for` loops and inline everything. Arrows passed directly to `.map`/`.filter`
  are fine.
- **Background-tab throttling:** a background Edge tab renders virtualized dropdown options
  at 0 height and throttles timers. Apply focus emulation per script:
  ```ts
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  ```

---

## 5. App-map — query keys, endpoints & DOM discovered (fill in per product)

Record each screen you probe so the next run skips the discovery. Template:

| Screen / route | Query key (RQ) | Endpoint | Spinner / DOM signal | Notes (staleTime, safe trigger, test data) |
|----------------|----------------|----------|----------------------|--------------------------------------------|
| `<route>` | `["<domain>","<resource>","<id>"]` | `GET /api/<path>` | `.animate-spin` / "Refreshing…" | _e.g. no refresh button; guard needs existing data_ |

Also record reusable widget mechanics here (or in the feature guide), e.g.:
- **Context switcher (tenant/store):** button label, whether the search input needs real keystrokes,
  whether results render as plain `<button>` elements (then click the button by text — keyboard
  navigation may do nothing), and how to restore the original context afterwards.
- **Server-side pagination / lookup endpoints:** paginated `{data:{items}}` vs flat `{data:[...]}`
  and which screens use each.

---

## 6. Login context (tenant/store) — what's testable and what ISN'T

Typical fix surface: a client store that seeds a default context on login (`resetSession()`,
`autoSelectDefault()`-style), a selector component, a "context required" guard, an API-client guardrail
that adds a context header, and a query-client whose cache is scoped by the active context.

- **State lives in `localStorage`** under a product-specific key (record the key name in the feature
  guide) — typically `{"state":{"contextId","contextName",...,"_sessionSeeded":true},"version":0}`.
- **Simulate a fresh login (single identity):** `localStorage.removeItem('<context-key>')` then reload;
  the app should re-seed the default context with no picker shown. **Restore** by writing the saved
  value back + reload.
- **Guardrail:** context-scoped calls carry a context header (`req.headers()['x-<context>-id']`).
  Identity/claims/health endpoints are usually **context-agnostic** (fire first, no header — that's how
  the default context is learned). A working guardrail = no context-scoped call with a blank/absent
  header and **no `400 "<header> is required"`**.

> ⚠️ **Hard limit — multi-persona.** Real context bugs are often *cross-identity* (admin inheriting
> another user's context; multi-context user with no landing picker; single-context user not
> auto-selecting). Reproducing them needs **fresh logins as different user identities**, which the
> **shared single-identity CDP session cannot do** without disrupting the user's SSO and needing
> multiple accounts + TOTP. A single-persona PASS here does **not** overturn a multi-persona FAIL.
> Flag it and ask; don't silently pass.

---

## 7. Verdict guidance for these tickets

- Confirmed the transient indicator with cached data visible → **PASS** (attach the
  spinner-with-data screenshot; describe the invalidate+delay method so it's reproducible).
- Could only exercise part of the scope (e.g. needs a live external-signature packet / real
  save mutation; delete-guard needs pre-existing data) → put the untested parts in
  **`notValidated`** and keep the confirmed parts honest.
- Couldn't reach the state at all (e.g. multi-persona) → **INCONCLUSIVE**; make no Jira changes
  (no evidence upload, comment, transition, or bug-pipeline sync). Report the blocker locally.
  When it's not your bug and a recent detailed FAIL exists, prefer asking the user before publishing.

All temp probe scripts go in `scripts/_tmp-*.ts` and are deleted at the end of the batch
(`Remove-Item scripts\_tmp-*.ts -Force`). Never launch/close the browser; restore any
session state (context key) you changed.
