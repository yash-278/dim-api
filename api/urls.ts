function baseUrl(environmentVariable: string, fallback: string) {
  return (process.env[environmentVariable] ?? fallback).replace(/\/$/, '');
}

export function getAppBaseUrl() {
  return baseUrl('APP_BASE_URL', 'http://localhost:8080');
}

export function getShortlinkBaseUrl() {
  return baseUrl('SHORTLINK_BASE_URL', 'http://localhost:3000');
}
