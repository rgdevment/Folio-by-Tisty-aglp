// Says whether Tisty Share's Worker errs or nears the Free plan's daily limits; exits 1 when it does.
// Needs CLOUDFLARE_ANALYTICS_TOKEN (Account Analytics: Read) and CLOUDFLARE_ACCOUNT_ID.
import { readFileSync } from "node:fs";

// The Workers Free plan, whose daily counts start again at 00:00 UTC.
const FREE = {
  requests: 100_000,
  rowsRead: 5_000_000,
  rowsWritten: 100_000,
  databaseBytes: 500_000_000,
  bucketBytes: 10_000_000_000,
};
const NEAR = 0.8;
// Errors in the last hour worth a word: a few at least, and at least one request in a hundred.
const ERRORS_AT_LEAST = 5;
const ERRORS_SHARE = 0.01;

const QUERY = `query Watch($account: string!, $script: string!, $database: string!, $bucket: string!, $day: Time!, $hour: Time!, $date: Date!, $since: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      today: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $day }) { sum { requests errors } }
      lastHour: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $hour }) { sum { requests errors } }
      rows: d1AnalyticsAdaptiveGroups(limit: 1, filter: { databaseId: $database, date_geq: $date }) { sum { rowsRead rowsWritten } }
      database: d1StorageAdaptiveGroups(limit: 1, filter: { databaseId: $database, date_geq: $since }, orderBy: [date_DESC]) { max { databaseSizeBytes } dimensions { date } }
      bucket: r2StorageAdaptiveGroups(limit: 1, filter: { bucketName: $bucket, date_geq: $since }, orderBy: [date_DESC]) { max { payloadSize metadataSize } dimensions { date } }
    }
  }
}`;

function kept(toml) {
  const first = (pattern, what) => {
    const found = toml.match(pattern);
    if (!found) throw new Error(`wrangler.toml names no ${what}`);
    return found[1];
  };
  return {
    script: first(/^name\s*=\s*"([^"]+)"/m, "Worker"),
    database: first(/^database_id\s*=\s*"([^"]+)"/m, "D1 database"),
    bucket: first(/^bucket_name\s*=\s*"([^"]+)"/m, "R2 bucket"),
  };
}

// What the day and the last hour used, or null when the token has no query budget left.
async function usage(names, account, token, now) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(day.getTime() - 86_400_000);
  const answer = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        ...names,
        account,
        day: day.toISOString(),
        hour: new Date(now.getTime() - 3_600_000).toISOString(),
        date: day.toISOString().slice(0, 10),
        since: yesterday.toISOString().slice(0, 10),
      },
    }),
  });
  const read = await answer.json();
  if (read.errors?.some((error) => error.extensions?.code === "budget")) return null;
  if (!answer.ok || read.errors?.length) {
    throw new Error(`Cloudflare's analytics refused: ${JSON.stringify(read.errors ?? answer.status)}`);
  }
  const found = read.data.viewer.accounts[0];
  if (!found) throw new Error("the token cannot see that account");
  const sum = (rows) => rows[0]?.sum ?? {};
  const max = (rows) => rows[0]?.max ?? {};
  return {
    requests: sum(found.today).requests ?? 0,
    lastHour: { requests: sum(found.lastHour).requests ?? 0, errors: sum(found.lastHour).errors ?? 0 },
    rowsRead: sum(found.rows).rowsRead ?? 0,
    rowsWritten: sum(found.rows).rowsWritten ?? 0,
    databaseBytes: max(found.database).databaseSizeBytes ?? 0,
    bucketBytes: (max(found.bucket).payloadSize ?? 0) + (max(found.bucket).metadataSize ?? 0),
  };
}

function troubles(seen) {
  const found = [];
  for (const [what, limit] of Object.entries(FREE)) {
    if (seen[what] >= limit * NEAR) found.push(`${what} at ${seen[what]} of the plan's ${limit}`);
  }
  const { requests, errors } = seen.lastHour;
  if (errors >= ERRORS_AT_LEAST && errors >= requests * ERRORS_SHARE) {
    found.push(`${errors} errors in the last hour, over ${requests} requests`);
  }
  return found;
}

const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.log("::error::CLOUDFLARE_ANALYTICS_TOKEN and CLOUDFLARE_ACCOUNT_ID are both needed");
  process.exit(1);
}
let seen;
try {
  const names = kept(readFileSync(new URL("wrangler.toml", import.meta.url), "utf8"));
  seen = await usage(names, account, token, new Date());
} catch (error_) {
  console.log(`::error::${error_.message}`);
  process.exit(1);
}
// Out of query budget says nothing of the Worker, so the next hour looks again rather than raising an alarm.
if (!seen) {
  console.log("::warning::Cloudflare's analytics ran out of query budget for this token; nothing was looked at");
  process.exit(0);
}
console.log(JSON.stringify(seen));
const found = troubles(seen);
for (const trouble of found) console.log(`::error::${trouble}`);
process.exit(found.length ? 1 : 0);
