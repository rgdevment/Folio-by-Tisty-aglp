# Folio by Tisty

[Español](README.es.md)

Folio by Tisty turns a Tisty document into a link anyone can read: anonymous,
end-to-end encrypted, and gone on its own after a while. It is a **service**,
separate from the Tisty app, with its own server, rules and promises. Its links
live at tisty.cl, and its site is [www.tisty.app](https://www.tisty.app).

> **It does not promise what the app promises.** The Tisty app has no server
> and collects nothing. Folio does run a server: it keeps encrypted copies
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

It is being written again from scratch in TypeScript, on Cloudflare Workers, D1
and R2, and the service is not running while that happens. It speaks to the
[Tisty app](https://github.com/rgdevment/Tisty) through a contract that the
app's repository keeps: the formats of what travels and the style rules of a
page. The earlier code, in Rust, stays in the `chore/rust-service-backup`
branch.

## Licence

The same as Tisty: the
[GNU Affero General Public License, version 3](LICENSE).
[Commercial terms](docs/COMMERCIAL.md) exist for organisations that cannot
comply with the AGPL.
