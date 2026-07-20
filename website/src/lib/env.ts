const LOCALHOST_SITE_URL = "http://localhost:3000";

function normalizeSiteUrl(value: string) {
  return value.replace(/\/+$/, "");
}

export function getSiteUrl() {
  const configuredValue = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configuredValue) {
    return normalizeSiteUrl(configuredValue);
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("Missing NEXT_PUBLIC_SITE_URL environment variable.");
  }

  return LOCALHOST_SITE_URL;
}

export function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }

  return value;
}
