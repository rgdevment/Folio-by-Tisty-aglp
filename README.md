# Tisty Share

[Español](README.es.md)

Tisty Share turns a Tisty document into a link anyone can read: anonymous,
end-to-end encrypted, and gone on its own after a while. It is a **service**,
separate from the Tisty app, with its own server, rules and promises. It runs at
[tisty.cl](https://tisty.cl).

> **It does not promise what the app promises.** The Tisty app has no server
> and collects nothing. Tisty Share does run a server: it keeps encrypted copies
> until they expire, counts reads and keeps a few anonymous records. What it
> keeps, why and for how long is in its [privacy policy](docs/PRIVACY.md).

## How it works

- **You share from Tisty,** with its *Share* button, which is not switched on
  yet. Nothing is shared any other way, and there are no accounts: the link is
  the permission.
- **Each document gets three links:** one to read, one to edit and one to
  manage.
- **What you share is encrypted in your Tisty before it leaves.** The key
  travels in the link, after the `#`, which browsers never send. The server
  keeps bytes it cannot read.
- **Every version is signed** with your machine's key, so a reader can tell it
  came from you.
- **It expires on its own** after the time without activity you choose, from one
  day to 15 at most. Your document stays in your Tisty.
- **A link opens in any browser,** at tisty.cl, or in another Tisty with *Open
  in Tisty*.

## Its documents

| | |
|---|---|
| [Terms of use](docs/TERMS.md) | What is allowed, reports and removal, warranty and liability |
| [Privacy policy](docs/PRIVACY.md) | What the service keeps, why, for how long, and your rights |
| [Security policy](docs/SECURITY.md) | How to report a vulnerability, and what the design protects and does not |

## Who runs it

Mario, a natural person in Chile, as an open-source, non-profit project. There
is no company behind it and nobody makes money from it. Contact:
<rgdevment@tisty.app>.

## Its code

It lives in this repository. What it still shares with the
[Tisty app](https://github.com/rgdevment/Tisty), the identity keys and the
editor that draws a document, comes from the app's repository, pinned as the
`tisty` submodule:

| Where | What |
|---|---|
| `crates/envelope` (`folio-envelope`) | The envelope, its signatures and limits, which the app seals and the server checks |
| `crates/server` (`folio-server`) | The service itself, on any store: versions, links, expiry, defences |
| `crates/worker` (`folio-worker`) | The service on Cloudflare Workers, D1 and R2 |
| `crates/wasm` (`folio-wasm`) | What the reading page runs to open an envelope |
| `web` (`folio-web`) | The page that reads a link |
| `tisty` | The Tisty app's repository: its identity keys (`tisty-share-proto`) and the editor that draws the page (`tisty-editor`) |

It is released with tags `share-v*`, which `.github/workflows/share.yml` deploys
and checks live.

## Licence

The same as Tisty: the
[GNU Affero General Public License, version 3](LICENSE).
[Commercial terms](docs/COMMERCIAL.md) exist for organisations that cannot
comply with the AGPL.
