# Serving Vault over HTTPS

## Why this matters

Vault logs you in with cookies.
By default, Nginx listens on port 80 as plain HTTP. Cookies travel through the air unencrypted.
Anyone on your wifi can see that, copy your session cookie, and log in as you without needing a password.

On `localhost` traffic never leaves the machine, safe. Connecting over WIFI
opens a security risk.

Vault supports three ways of running over HTTPS, and everything needed for all
three is already in the repo — the nginx configs, the compose overlay, the
cookie handling.

The decision is yours to make. A certificate has to name the exact address
_you_ reach Vault on, so the setup and the certificate both depend on how you
run it. That's what the rest of this doc is for.

## Which setup do I need?

| Your situation                                                                      | Setup   | Effort                                                      |
| ----------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------- |
| Something already puts Vault behind HTTPS — Tailscale, Caddy, a cloud load balancer | **(c)** | One env var. Start here if it applies.                      |
| Vault has a real domain name pointing at it (`vault.example.com`)                   | **(b)** | Get a free cert, mount it, done.                            |
| You reach Vault by IP or a made-up name like `vault.lan`                            | **(a)** | Works, but you must install a file on every device you use. |

If two apply, prefer the one higher in the table.

## First: understand the certificate warning

A certificate is a file that makes a claim — "I am `vault.lan`" — plus a
signature backing it up. Every browser ships with a list of signers it trusts,
the Certificate Authorities, and accepts a certificate when one of them signed
it.

- **Let's Encrypt is on that list.** Setup (b) works everywhere, on every
  device, forever, with nothing to install.
- **You are your own signer in setup (a).** Your signature is on nobody's list,
  so every browser shows a full-page "Your connection is not private" warning.

You have two ways past that warning, and this is the whole reason setup (a)
is more work than the others:

1. **Click through it each time.** It works. But you're training yourself to
   dismiss the exact warning that would appear if someone really did intercept
   your traffic, so you'd never notice the difference.
2. **Install the certificate on the device** (step 5 below). This adds your
   certificate to _that device's_ trust list, and the warning stops for good.
   Every device keeps its own list, so this is once per phone, once per laptop,
   once per tablet. Firefox keeps a separate list from the rest of the system,
   so it's a second time on any machine running Firefox.

If installing a file on every device sounds like more trouble than it's worth,
that's a good reason to use setup (b) or (c) instead.

## Required in all three setups: `COOKIE_SECURE`

Vault only marks its cookies `Secure` when you tell it to, in `.env.prod`:

```
COOKIE_SECURE=true
```

Set this whenever the browser reaches Vault over HTTPS — including setup (c),
where nginx itself never sees a certificate. The cookie needs protecting on
the browser-to-proxy leg, which is the exposed one, no matter what happens
after that. This is the single most common thing people get wrong.

It isn't inferred from `NODE_ENV` because Docker sets `NODE_ENV=production`
even for plain-HTTP deployments. Guessing from that would mark cookies
`Secure` on a connection that can't carry them, and the browser would silently
drop them — you'd be logged out with no error explaining why.

**If switching to HTTPS changes the address you type** (`http://vault.local` →
`https://vault.example.com`), also update `CORS_ORIGIN` and `ALLOWED_ORIGINS`
in `.env.prod` to match. The API checks incoming requests against that list and
refuses to start if it's empty.

---

## Setup (a): self-signed certificate on a local network

For when you reach Vault by IP or an internal hostname, with no public DNS
record. Read "understand the certificate warning" above first — that's the
tradeoff you're accepting here.

### 1. Generate the certificate

```bash
mkdir -p certs
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout certs/privkey.pem -out certs/fullchain.pem \
  -days 825 \
  -subj "/CN=vault.lan" \
  -addext "subjectAltName=DNS:vault.lan,IP:192.168.1.50"
```

Replace `vault.lan` and `192.168.1.50` with however you actually reach the
box. List **every** hostname and IP you might type into a browser inside that
one `subjectAltName` value, comma-separated — a cert missing an address you
use will fail for that address specifically.

`subjectAltName` is mandatory. Every modern browser rejects a certificate
lacking one outright, with no click-through offered.

Both files land in `certs/` at the repo root, which is where the compose
overlay expects them. `.gitignore` already covers `*.pem` and `*.key`.

### 2. Start with the TLS overlay

```bash
docker compose -f infra/docker/docker-compose.prod.yml -f infra/docker/docker-compose.tls.yml up -d
```

The overlay opens port 443, swaps in `nginx.tls.conf` (which redirects port 80
to HTTPS, except `/health/*` so container probes still work), and mounts
`certs/` read-only. It lives in a separate file because nginx requires the
certificate files to exist before it will start, and a default that breaks a
fresh install is worse than shipping no default at all.

### 3. Set `COOKIE_SECURE=true`

In `.env.prod`, then restart the `api` service.

### 4. Leave HSTS off

The default (`nginx-snippets/hsts-off.conf`) omits the HSTS header, which is
correct here. HSTS tells a browser "never use plain HTTP for this host again" —
and it means it, for two years, with no easy undo. Combine that with a
certificate the browser doesn't trust and you get a host the browser refuses to
load either way.

### 5. Install the certificate on each device

Distribute `certs/fullchain.pem` (rename it to `.crt` where the instructions
say so). That file is the public half — safe to email, copy to a USB stick,
put in a shared folder. **Never distribute `privkey.pem`.** Anyone with the
private key can impersonate your server.

- **Windows** — double-click the `.crt` → _Install Certificate_ → _Local
  Machine_ → _Place all certificates in the following store_ → _Trusted Root
  Certification Authorities_ → Finish. Restart the browser.
- **macOS** — open the `.crt` in Keychain Access (or drag it into the _System_
  keychain). Double-click the imported certificate, expand _Trust_, set _When
  using this certificate_ to _Always Trust_.
- **Linux** —
  ```bash
  sudo cp certs/fullchain.pem /usr/local/share/ca-certificates/vault.crt
  sudo update-ca-certificates
  ```
  Firefox ignores the system store. Import separately via _Settings → Privacy &
  Security → Certificates → View Certificates → Authorities → Import_.
- **Android** — copy the `.crt` to the device, then _Settings → Security →
  Encryption & credentials → Install a certificate → CA certificate_. Chrome
  will honor it. Some apps that embed a browser will not, by Android's design —
  that's not something this setup can fix.

---

## Setup (b): Let's Encrypt certificate for a real domain

For when Vault has a real DNS record — `vault.example.com` — pointing at it.
Works on every device as-is, with nothing to install and no warnings.

### Use the DNS-01 challenge, not HTTP-01

Let's Encrypt has to verify you control the domain. The default method
(HTTP-01) does that by making a request to your box on port 80 _from the public
internet_ — which most self-hosted setups deliberately block. DNS-01 verifies
by creating a temporary TXT record through your DNS provider's API instead.
Nothing inbound required.

```bash
certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials ~/.secrets/cloudflare.ini \
  -d vault.example.com
```

Swap the `--dns-cloudflare*` flags for your provider's plugin — most DNS hosts
have one.

### Point the overlay at the issued certificate

Two options:

- Copy `/etc/letsencrypt/live/vault.example.com/{fullchain,privkey}.pem` into
  `certs/` after every renewal, or
- Bind-mount `/etc/letsencrypt/live/vault.example.com` directly at
  `/etc/nginx/certs` in `docker-compose.tls.yml`, so renewals need no copying.

Either way, **nginx keeps serving the old certificate until you reload it.**
Do that after every renewal, or you'll be serving an expired cert:

```bash
docker compose -f infra/docker/docker-compose.prod.yml -f infra/docker/docker-compose.tls.yml exec nginx nginx -s reload
```

### Then turn on HSTS

Now it's safe — every browser can complete the HTTPS connection HSTS demands.
Point the `hsts.conf` mount in `docker-compose.tls.yml` at
`nginx-snippets/hsts-on.conf` and recreate the `nginx` container.

### And set `COOKIE_SECURE=true`

Same as everywhere else.

---

## Setup (c): something else already handles TLS

If Tailscale Serve, a Caddy reverse proxy, or a cloud load balancer already
sits in front of Vault, **leave nginx on plain port 80** and point the outer
layer at `nginx:80`. Skip `docker-compose.tls.yml` entirely.

Stacking a second TLS layer behind the first gains nothing and gives you two
certificates to renew. The plain-HTTP hop between the outer layer and nginx
stays on the host or tailnet, which is the same trust boundary the rest of the
stack already relies on (`web` → `api` is plain HTTP too).

**You still need `COOKIE_SECURE=true`.** This is the setup people get wrong,
because nginx only ever sees plain HTTP and the whole thing feels like an HTTP
deployment. The browser's connection to the outer layer _is_ HTTPS, though, and
that's the leg where the cookie is exposed — the one hop that actually crosses
the network. Setting it protects that hop.

HSTS here belongs to the outer layer. Caddy sets it by default for sites with a
real certificate.

---

## Common mistakes

| Symptom                                                      | Cause                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Logged out immediately, no error                             | `COOKIE_SECURE=true` on a plain-HTTP connection — browser drops the cookie |
| Session cookie visible in plain text despite HTTPS front-end | `COOKIE_SECURE` unset in setup (c)                                         |
| nginx won't start after adding the overlay                   | Certificate files missing from `certs/`                                    |
| Browser refuses the site entirely, no click-through          | HSTS turned on with a self-signed certificate                              |
| Cert warning on one address but not another                  | That hostname or IP isn't in `subjectAltName`                              |
| Worked for 90 days, then broke                               | Certificate renewed but nginx never reloaded                               |
| API refuses to boot after changing domains                   | `CORS_ORIGIN` / `ALLOWED_ORIGINS` not updated                              |
