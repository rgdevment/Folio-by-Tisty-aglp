# Tisty Share security policy

[Español](SEGURIDAD.md)

This covers the Tisty Share service: [tisty.cl](https://tisty.cl), its API under
`/api/v1/`, the page that reads a link, and the envelope format both the app and
the server speak. The Tisty app has a [security policy of its own](../SECURITY.md).

## Reporting a vulnerability

**Do not open a public issue.** Use either private channel:

- **Email** <rgdevment@tisty.app>, subject `[SECURITY][Share] short description`.
- **GitHub Security Advisory**: the *Security* tab, *Report a vulnerability*.

Useful in a report: what an attacker could do and to whom, and the steps to
reproduce it. Test only against links you created yourself, never against
someone else's document, and never with load meant to bring the service down.

You will get an acknowledgement within 48 hours. Good-faith research will never
be met with legal threats.

## What the design protects

- **What is shared stays unreadable to the service.** Each part of a document
  is sealed in the sharer's Tisty with XChaCha20-Poly1305, under a key that
  travels after the `#` of the link and never reaches the server. A commitment
  in the envelope binds it to that one key.
- **The server reads only the manifest:** how many parts, their kinds and sizes,
  and the version. It holds every limit without the key.
- **Who wrote it can be told.** Each machine has its own key, certified by the
  person's root key. The writer's signature covers the page, its settings, the
  list of what it cites and a hash of the words and of every picture; the
  sender's signature covers what was uploaded, and the server refuses an upload
  without it. Keys taken back are told to every reader.
- **The page is never trusted.** The reading page cleans the drawn page with a
  closed list of tags and styles, runs no script from it, and lives behind a
  Content Security Policy that allows nothing from elsewhere.
- **Pictures are cleaned before they leave.** They are written again, or, for a
  photo that needs no change, stripped down to the picture and its colour
  profile: no location, no comments, nothing hidden after them.
- **Abuse costs.** Reserving, uploading and reporting each ask for a proof of
  work. Passwords are kept as a slow digest; wrong ones are counted against the
  network that says them, which alone is made to wait, and past 50 in a day
  every guess asks for a proof of work too.

## What it does not protect

- **The page that decrypts is served by the same server.** That protects against
  a leak or an order over what is stored, but not against an operator who chose
  to change that code to steal keys. The code is public so anyone can check it;
  between two Tisty apps this does not apply.
- **Whoever holds a link reads it,** and can pass it on. A link cannot be taken
  back except by stopping the share.
- **What the service sees anyway:** sizes, times, the link's id, and for a few
  days the country and Cloudflare data center of each read. Cloudflare sees the
  reader's IP, as any web host does.
- **A report that includes the full link** makes that document readable, in the
  cases the [terms](TERMS.md) list.

## Supported versions

Only what runs at tisty.cl today, the latest `share-v*` tag. Envelopes are read
in their current format only.
