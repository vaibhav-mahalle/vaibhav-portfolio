---
title: "Single Sign-On with JWTs: How a ‘Log In Once’ Link Really Works"
subtitle: "Signed tokens, asymmetric keys, the checks that matter, and the special cases of iframes and email links"
slug: sso-with-jwts
date: 2026-11-24
publishAt: 2026-11-24T00:00:00+05:30
status: published
tags: [security, sso, jwt, authentication, web]
---

Here is a login link that passes every cryptographic check. The signature is valid, the token has not expired, the issuer is right. It still opens the wrong customer's dashboard, because the two companies never agreed in writing what the customer ID in the token means.

That is the part of Single Sign-On (SSO) that tutorials skip. The setup is common: a customer already has an account with a bank, a telecom or a utility, and your product sits behind a link on that site, for example "View your dashboard". When they click it, they must arrive in your app already logged in, **as themselves, and only as themselves**.

This post walks through one common way to do that, **token-based SSO with a signed JWT**, and the agreements and checks that make it safe.

---

## 1. Four parties, and the browser is the one you cannot trust

| Role | Who | Job |
|---|---|---|
| **Identity Provider (IdP)** | The partner's website and its backend | Logs the customer in. Says "this person is customer X." |
| **Service Provider (SP)** | Your SSO endpoint | Checks that statement. Decides whether to trust it. |
| **Your app** | The web app the customer wants to use | Shows the customer's data after the SP lets them in |
| **The browser** | The customer's browser | Carries messages between the other three |

Remember one rule: **the browser is a courier, not a trusted party.** Anything that passes through it can be read, copied or changed. So the message must protect itself.

---

## 2. A JWT is signed, not secret

A JSON Web Token is three Base64URL strings joined by dots:

```
header.payload.signature
```

**Header**: which algorithm signed the token.

```json
{ "alg": "RS256", "typ": "JWT" }
```

**Payload**: the "claims", which are statements about the user.

```json
{
  "sub": "CUST-0001",
  "iss": "https://login.example-utility.com",
  "aud": "https://sso.example-vendor.com",
  "iat": 1767225600,
  "exp": 1767225900,
  "jti": "6f1c2b9e-1d2a-4b5c-9e7f-0a1b2c3d4e5f"
}
```

**Signature**: a cryptographic seal over the header and the payload.

Two facts surprise people:

1. **A JWT is not encrypted by default.** Anyone can Base64-decode the payload and read it. Do not put secrets or sensitive personal data in it.
2. **The signature is what matters.** It proves *who made* the token and that *nobody changed* it.

---

## 3. Asymmetric keys: you should only be able to check, never to sign

There are two families of signing algorithms:

| Family | Example | Who holds what | Risk |
|---|---|---|---|
| Symmetric (HMAC) | HS256 | Both sides hold the **same secret** | If your side leaks the secret, an attacker can mint tokens for anyone |
| Asymmetric (RSA/ECDSA) | RS256, RS512, ES256 | The partner keeps the **private key**. You hold only the **public key** | Your public key can only check signatures. It cannot make them. |

For cross-company SSO, choose asymmetric. The partner signs with a private key that never leaves their systems. You store only the public key. A leak on your side does not let anyone forge a login.

---

## 4. End to end: one click, eight hops

```
 Customer      Partner site/backend        Browser          Your SSO endpoint        Your app
    │  log in         │                       │                     │                    │
    │───────────────▶ │                       │                     │                    │
    │  click link     │                       │                     │                    │
    │───────────────▶ │ sign JWT (private key)│                     │                    │
    │                 │──────────────────────▶│  GET /sso?token=…   │                    │
    │                 │                       │───────────────────▶ │ verify + map user  │
    │                 │                       │ 302 to app + session│                    │
    │                 │                       │ ◀────────────────── │                    │
    │                 │                       │───────────────────────────────────────▶  │
    │ ◀──────────────────────────────────────────────────────────────── dashboard ─────  │
```

1. **The customer logs in on the partner's site.** The partner does the real authentication: password, MFA, whatever they use. You never see the password.
2. **The customer clicks your link.** The partner's backend (never the browser's JavaScript) builds a JWT with the customer's identifier and a short expiry, and signs it with its private key.
3. **The browser carries the token to you.** Prefer an auto-submitted HTML form POST. A redirect to `https://sso.example-vendor.com/sso?token=<jwt>` also works, but a token in the URL ends up in server and proxy logs, browser history and `Referer` headers. If you use the query string, keep the lifetime very short, require `jti`, and strip the parameter from your logs. If your app runs in an iframe inside the partner's page, the token can also arrive by `postMessage` (section 7).
4. **You verify the signature** with the partner's public key, chosen by the header's `kid` from a fixed set of keys you trust, and you **pin the allowed algorithm** in your code. Never let the `alg` value in the token header choose it: that is how the classic algorithm-confusion attack works, where a token signed with HMAC using your *public* key as the secret passes as valid.
5. **You check the claims:**
   - `exp` and `nbf`: is the token valid now?
   - `iss`: did the partner you expect issue it?
   - `aud`: was it made for you, and not for some other vendor?
   - `jti` (optional): did you already use this token? A store of seen IDs blocks replay, as long as it keeps each ID for the token's full lifetime and every instance of your endpoint shares it.
6. **You map the identity.** Take the customer identifier from the claim and look it up in your user store. Then check that the account exists, that it is active, and that it is enrolled in this program. If any check fails, stop. A valid signature on an unknown customer is still a failed login.
7. **You create your own session.** Issue your own short-lived access token or session cookie for **that one user**, with only the rights they need. The partner's JWT has done its job; do not keep using it.
8. **You redirect to the app.** The browser lands on the dashboard, already logged in.

The core idea: **the partner proves who the person is; you decide what that person can see.**

---

## 5. Most JWT SSO bugs are a skipped check

Most JWT SSO bugs come from a skipped check. Use this list in code review:

- [ ] Algorithm is pinned on the server (`algorithms: ["RS256"]`). `none` and HMAC are refused. The key is picked by `kid` from an allow-listed set.
- [ ] Signature is verified with the right public key for the right environment (test key in test, production key in production).
- [ ] `exp` and `nbf` are checked, and the lifetime is short (a few minutes). Allow a small clock skew, such as 30 to 60 seconds.
- [ ] `iss` and `aud` are checked against fixed values.
- [ ] Replay is blocked by `jti`, or the risk is accepted in writing because of the short expiry.
- [ ] The identity claim name and value format are agreed in writing (case-sensitive name, exact ID format, leading zeros).
- [ ] Unknown, disabled and not-enrolled users get a clear, friendly error page, not a stack trace.
- [ ] Error responses say *what kind* of failure happened (expired, bad signature, unknown user), but not the details an attacker could use.
- [ ] Logs never contain the raw token, private keys or personal identifiers. Log a hash or the last few characters if you must correlate.

---

## 6. Write the contract before the code

Write this down before anyone writes code:

| Item | Example decision |
|---|---|
| Algorithm | RS256 |
| Identity claim | `sub` = the customer ID both sides already share, in an exact, agreed format |
| Multi-account users | One token = one account. A separate selector claim picks which one. |
| Lifetime | `exp` = issued time + 5 minutes |
| Issuer / audience | Fixed strings per environment |
| Transport | HTML form POST, or a top-level redirect with `?token=` plus the log precautions above |
| Deep link | Optional `destination` claim, from an allow-list only |
| Keys | One public key per environment, delivered over a trusted channel |
| Rotation | An agreed notice period, or better: a JWKS URL that you fetch and cache |
| Errors | Where the customer lands when SSO fails |
| Logout | Does logging out of the partner site end your session too? |

In my experience, **key rotation is a common cause of production outages** in JWT SSO. If the public key is a file baked into your deployment, every rotation needs a release. A JWKS endpoint (a URL where the partner publishes current public keys, each with a `kid`) removes that coupling.

---

## 7. Inside an iframe, check origins in both directions

Some partners embed your app in their page. Then the token often travels by `window.postMessage`:

1. Your iframe page loads and posts "ready" to the parent window.
2. The parent page posts the JWT into the iframe.
3. Your page sends the token to your SSO endpoint and navigates on.

Two rules make this safe:

- **The receiver must check `event.origin`** against an allow-list of the partner's domains. Without this, any page that embeds you can feed you a token.
- **The sender must name a target origin**, never `"*"`. Otherwise a token can leak to the wrong window.

Also set `Content-Security-Policy: frame-ancestors` so that only the partner's domains can frame your app.

Sessions are the harder part. Inside an iframe your cookies are third-party cookies, and `SameSite=None; Secure` is no longer enough: Safari blocks them, and Chrome restricts them. Options, in rough order of robustness: keep the session token in memory and send it as a header instead of a cookie; use partitioned cookies (CHIPS, the `Partitioned` attribute); or ask for access with the Storage Access API. Test in every browser your customers use.

---

## 8. Email links: decide how much a forwarded email may unlock

Your product may also send emails, such as a monthly summary with a "See your report" button. The customer is not logged in to anything when they click it. You have two options:

**Option A: Magic links.** You put a signed or encrypted token in the link that names the user and a timestamp. When the customer clicks it, your server checks the token and its age and opens a session.

- Good: one click, no partner work.
- Risk: emails are forwarded, and links sit in inboxes for weeks. Reduce the risk:
  - Give the link a limited lifetime.
  - Give the link session reduced rights. For example, hide personal details and block profile changes.
  - Keep a way to cancel links (for example, a per-user key version) **before** you need it.

**Option B: Log in at the partner, then SSO with a deep link.** The email button goes to the partner's login page with a "return to" target. After login, the normal JWT flow runs and lands on the right page.

- Good: full authentication, full rights.
- Cost: one more step for the customer, and the partner must support the deep link.

A common split is Option A for read-only summaries and Option B for anything sensitive.

---

## 9. When it breaks: a field guide

| Symptom | Most likely cause |
|---|---|
| Every login fails at once | The partner rotated the signing key, or your new deployment has the wrong environment's key |
| "Token expired" for everyone | Clock skew between servers, or the token is made too early (for example, when the page loads instead of when the link is clicked) |
| One customer fails, others work | The identity claim does not match your records exactly (format, leading zeros, case), or the account is disabled or not enrolled |
| Works in test, fails in production | Production key or other environment configuration missing |
| Works in a new tab, fails in the iframe | Third-party cookie rules, a missing `frame-ancestors` entry, or a postMessage origin mismatch |
| Fails only after a release | The wrong build artifact was deployed. Compare it with the expected one. |

Debugging tip: decode the token header and payload locally (a few lines of code). **Never paste production tokens into public online decoders.**

---

## 10. Custom JWT is the lightest start, not the cheapest finish

| | SAML 2.0 | OpenID Connect | Custom JWT |
|---|---|---|---|
| Format | Signed XML assertion | Signed JWT (the ID token) | Signed JWT |
| Standard flow | Yes | Yes | **No**, so you design and document it |
| Discovery and key rotation | Metadata XML | `.well-known` + JWKS | Whatever you agree |
| Best when | The partner has an enterprise IdP (Okta, Entra ID, Ping…) | The partner has a modern IdP and you want a standard | The partner has no IdP, but their backend can sign a token |

A custom JWT is the lightest option to start with, but every item in the contract table above is your job. If the partner already runs an enterprise IdP, a standard protocol is usually the cheaper choice in the long run.

---

## The one idea to keep

The signature only proves who made the token. Everything that decides *which* customer gets in, the identity claim, its format, the account it maps to, is an agreement between two companies. Write that agreement down before anyone writes code.

*Views are my own. Examples are simplified or made up and do not describe any specific employer or customer system.*
