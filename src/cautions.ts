import type { Address } from './types.js';

// Scam warnings (SCM-01..05, principle 3): plain-language cautions about who a
// message is really from, for the AI to pass on before acting on it. Built to
// stay quiet on ordinary mail: a company's own mail subdomains and country
// domains are theirs, and a name only "claims" a company when it is that
// company's name, give or take words like Support or Alerts.

type Brand = { name: string; aliases: string[]; domains: string[] };
const BRANDS: Brand[] = [
  { name: 'PayPal', aliases: ['paypal'], domains: ['paypal.com', 'paypal.co.uk', 'paypal.de'] },
  { name: 'Chase', aliases: ['chase', 'chase bank', 'jpmorgan chase', 'jp morgan chase'], domains: ['chase.com', 'jpmorgan.com'] },
  { name: 'Bank of America', aliases: ['bank of america', 'bofa'], domains: ['bankofamerica.com', 'bofa.com'] },
  { name: 'Wells Fargo', aliases: ['wells fargo'], domains: ['wellsfargo.com'] },
  { name: 'Citi', aliases: ['citi', 'citibank'], domains: ['citi.com', 'citibank.com'] },
  { name: 'American Express', aliases: ['american express', 'amex'], domains: ['americanexpress.com', 'aexp.com'] },
  { name: 'Capital One', aliases: ['capital one'], domains: ['capitalone.com'] },
  { name: 'the IRS', aliases: ['irs', 'internal revenue service'], domains: ['irs.gov'] },
  { name: 'USPS', aliases: ['usps', 'us postal service', 'united states postal service'], domains: ['usps.com', 'usps.gov'] },
  { name: 'UPS', aliases: ['ups'], domains: ['ups.com'] },
  { name: 'FedEx', aliases: ['fedex'], domains: ['fedex.com'] },
  { name: 'DHL', aliases: ['dhl', 'dhl express'], domains: ['dhl.com'] },
  { name: 'Amazon', aliases: ['amazon', 'amazon prime'], domains: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.ca', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.co.jp', 'amazon.com.au'] },
  { name: 'Apple', aliases: ['apple', 'icloud', 'apple id'], domains: ['apple.com', 'icloud.com'] },
  { name: 'Microsoft', aliases: ['microsoft', 'microsoft account', 'outlook', 'office 365', 'microsoft 365'], domains: ['microsoft.com', 'outlook.com', 'live.com', 'office.com', 'microsoftonline.com'] },
  { name: 'Google', aliases: ['google', 'gmail'], domains: ['google.com', 'youtube.com'] },
  { name: 'Netflix', aliases: ['netflix'], domains: ['netflix.com'] },
  { name: 'Facebook', aliases: ['facebook', 'meta', 'instagram'], domains: ['facebook.com', 'facebookmail.com', 'meta.com', 'instagram.com'] },
  { name: 'Coinbase', aliases: ['coinbase'], domains: ['coinbase.com'] },
  { name: 'DocuSign', aliases: ['docusign'], domains: ['docusign.net', 'docusign.com'] },
  { name: 'Yahoo', aliases: ['yahoo', 'yahoo mail'], domains: ['yahoo.com'] },
  { name: 'LinkedIn', aliases: ['linkedin'], domains: ['linkedin.com'] },
  { name: 'Venmo', aliases: ['venmo'], domains: ['venmo.com'] },
  { name: 'Zelle', aliases: ['zelle'], domains: ['zellepay.com'] },
  { name: 'Norton', aliases: ['norton', 'norton lifelock', 'norton antivirus'], domains: ['norton.com', 'nortonlifelock.com'] },
  { name: 'McAfee', aliases: ['mcafee'], domains: ['mcafee.com'] },
  { name: 'Geek Squad', aliases: ['geek squad', 'best buy'], domains: ['bestbuy.com', 'geeksquad.com'] }
];

// Words that don't change whose name it is: "PayPal Support" is PayPal.
const GENERIC = new Set(['support', 'team', 'service', 'services', 'security', 'alert', 'alerts', 'billing', 'account', 'accounts', 'customer',
  'care', 'notification', 'notifications', 'no', 'reply', 'noreply', 'inc', 'com', 'online', 'help', 'desk', 'center', 'centre', 'department',
  'dept', 'official', 'verification', 'verify', 'update', 'updates', 'info', 'mail', 'the', 'your', 'order', 'orders', 'payments', 'payment', 'fraud', 'prevention']);

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
// The domain a company registers: mail.bank.example → bank.example, and
// alerts.amazon.co.uk → amazon.co.uk.
export function registrable(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length > 2 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!)) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}
const domainOf = (address: string) => address.split('@').pop()!.toLowerCase();
const officialFor = (brand: Brand, domain: string) => brand.domains.includes(registrable(domain));

function claimedBrand(name: string | undefined): Brand | undefined {
  if (!name) return undefined;
  const words = name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !GENERIC.has(w)).join(' ');
  return words ? BRANDS.find(b => b.aliases.includes(words)) : undefined;
}

// Letters that pass for others at a glance: rn/m, 0/o, 1/l, vv/w.
const unglyph = (label: string) => label.replace(/rn/g, 'm').replace(/0/g, 'o').replace(/1/g, 'l').replace(/vv/g, 'w');
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
// A domain made to look like a company's, and the one it imitates.
function imitated(domain: string): string | undefined {
  const own = registrable(domain);
  const label = own.split('.')[0]!;
  for (const brand of BRANDS) {
    for (const official of brand.domains) {
      if (own === official) return undefined;
      const target = official.split('.')[0]!;
      // One letter off only for longer names: a five-letter name has too many
      // honest neighbours (ample, apply, chaise).
      if ((unglyph(label) === target && label !== target) || (target.length >= 6 && oneEditApart(label, target))) return official;
    }
  }
  return undefined;
}

export function cautionsFor(message: { from?: Address[]; replyTo?: Address[] }): string[] {
  const sender = message.from?.[0];
  if (!sender?.address) return [];
  const cautions: string[] = [];
  const domain = domainOf(sender.address);
  const shown = sender.name?.match(/[^\s<>"']+@[^\s<>"']+\.[a-z]{2,}/i)?.[0];
  if (shown && shown.toLowerCase() !== sender.address.toLowerCase()) {
    cautions.push(`The sender's name shows ${shown}, but the mail comes from ${sender.address}.`);
  } else {
    const brand = claimedBrand(sender.name);
    if (brand && !officialFor(brand, domain)) cautions.push(`The sender's name says ${brand.name}, but the address is at ${domain}, which isn't ${brand.name}'s.`);
  }
  if (domain.split('.').some(label => label.startsWith('xn--'))) {
    cautions.push(`The sender's domain ${domain} uses unusual characters that can disguise a look-alike address.`);
  } else {
    const official = imitated(domain);
    if (official) cautions.push(`The sender's domain ${registrable(domain)} looks like ${official} but isn't it.`);
  }
  const replyTo = message.replyTo?.find(r => r.address && registrable(domainOf(r.address)) !== registrable(domain));
  if (replyTo) cautions.push(`Replies would go to ${replyTo.address}, not to the sender's own domain (${registrable(domain)}).`);
  return cautions;
}
