// Types for release-files.mjs (a plain script, so the release pipeline needs no build to run it).
export function writeReleaseFiles(options: { dir: string; version: string; digest: string; security: boolean; feedUrl?: string }): { version: string; image: string; feed?: string };
