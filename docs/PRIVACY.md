# Tisty Share privacy policy

**Draft of October 29, 2026.** Tisty Share is not open yet.

## The short version

Tisty Share keeps the least it needs to work, and nearly all of it is encrypted
with a key it never receives. No accounts, no cookies, no analytics, no ads,
and nothing from third parties on the page. What it keeps expires on its own.
This policy says exactly what it keeps, why, and for how long.

Who answers for this data: Mario, a natural person in Chile, who runs Tisty
Share as a non-profit. Contact: <rgdevment@tisty.app>.

## What it cannot see

- **What you share.** The text, the pictures and the inner signature are
  encrypted in your Tisty before they leave. The key travels in the link, after
  the `#`, and browsers do not send it to the server.
- **Who you are.** There are no accounts, no email addresses and no names.
- **Your password**, if you set one. The server keeps only a slow digest of it
  (a hash), which checks it and cannot bring it back.

## What it does keep, and for how long

| What | Why | For how long |
|---|---|---|
| The encrypted document, with its versions | To serve it to whoever has the link | Until 30 days without activity, or until you stop sharing it |
| The manifest in the clear: how many parts, what each weighs, their kind and the version | To hold the limits without reading the content | As long as the document |
| The edit and manage links, kept as a digest (hash) | To check who may change or delete it | As long as the document |
| If you sign, your public key and its certificate | So readers know it is yours | As long as the document |
| How many times it was read, counted once a day per visitor | To show you the reads in Tisty | As long as the document |
| A digest of your IP (an HMAC with a key that changes) | Per-IP limits and blocks against abuse | As long as the quota or the block lasts |
| For a document with a password: a digest of your network and of the IPv6 blocks it sits in, the wrong passwords counted against them, and that it gave the right one today | So wrong passwords make only the network that says them wait, and a reader who already got in is not slowed | Until the 15-minute stretch or the day ends |
| Keys you took back, as your root signed them: the key's public part and your root's | So readers learn that a stolen or retired key no longer speaks for you | For good, since a reader must always be able to tell |
| Reports: category, detail, the link if given, and a digest of the reporter's network (an HMAC with a key that changes every 90 days), so each network reports only once | To moderate and pass them where they belong | 90 days, or 180 if the prosecutor orders it |

**About signing:** if you sign what you share, your public key lets anyone tell
that two signed documents come from the same person, though not who you are.
That is why signing is optional for unlisted documents.

**About reads:** they are counted without keeping who read. Not to count the
same person twice on one day, a short-lived digest is used and thrown away when
the day ends.

## Cloudflare

Tisty Share runs on Cloudflare (Workers, D1 and R2). Cloudflare receives your
IP and your requests when you connect, as any web server does, and handles them
under its own [privacy policy](https://www.cloudflare.com/privacypolicy/). It
never receives the key after the `#`, so it cannot read what you share either.

## The promise of encryption, said honestly

- **Between two Tisty**, nobody else can read what is shared: not the operator,
  not Cloudflare, not whoever steals the database.
- **In a browser**, the code that decrypts is served by the same server. That
  protects against a leak or an order over what is stored, but not against an
  operator who chose to change that code to steal keys. The code is public so
  anyone can check it.
- **A report with the full link** makes that document readable. It is done only
  in the cases the [terms](TERMS.md) list, and every opening is logged.

## Your rights

Under Chilean Law 21.719 you may ask what data about you there is, have it
corrected or deleted, or object to its use. Since there are no accounts, the
most direct ways are:

- **Delete what you shared:** with your management link, or by no longer
  sharing it from Tisty. It is deleted from the server at once.
- **Anything else:** write to <rgdevment@tisty.app>. The digest of your IP does
  not reveal who you are, so in general there is no data that can be tied to
  you.

## Children

Tisty Share is not meant for children under 14.

## Changes

Every change to this policy is committed to the public repository, with its
date.

[Español](PRIVACIDAD.md)
