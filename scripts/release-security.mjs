// Usage (in the release workflow): node scripts/release-security.mjs <tag>
// Prints security=true when the tag's own first line says "security", else
// security=false (REL-09). Only an annotated tag has a message of its own: a
// plain pointer to the commit would give the commit's subject, so it stops the
// release instead of guessing.
import { execFileSync } from 'node:child_process';

const tag = process.argv[2];
if (!tag) throw new Error('Usage: node scripts/release-security.mjs <tag>');
const ref = `refs/tags/${tag}`;
const read = format => execFileSync('git', ['for-each-ref', `--format=${format}`, ref], { encoding: 'utf8' }).trim();
if (read('%(objecttype)') !== 'tag') {
  console.error(`${tag} is not an annotated tag here: fetch it first (git fetch --force origin "${ref}:${ref}").`);
  process.exit(1);
}
console.log(`security=${/security/i.test(read('%(contents:subject)'))}`);
