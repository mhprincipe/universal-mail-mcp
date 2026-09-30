const BRANDS = [
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
    { name: 'Geek Squad', aliases: ['geek squad', 'best buy'], domains: ['bestbuy.com', 'geeksquad.com'] },
    // Added 2.4.2 (SCM-07, found live: "Liberty Mutual Team" from an unrelated domain).
    // Kept out: companies whose domain is one letter from an everyday one
    // (Discover and discovery.com, Square and squire.com, Truist and trust).
    { name: 'Liberty Mutual', aliases: ['liberty mutual'], domains: ['libertymutual.com'] },
    { name: 'Progressive', aliases: ['progressive'], domains: ['progressive.com'] },
    { name: 'GEICO', aliases: ['geico'], domains: ['geico.com'] },
    { name: 'State Farm', aliases: ['state farm'], domains: ['statefarm.com'] },
    { name: 'Allstate', aliases: ['allstate'], domains: ['allstate.com'] },
    { name: 'USAA', aliases: ['usaa'], domains: ['usaa.com'] },
    { name: 'Nationwide', aliases: ['nationwide'], domains: ['nationwide.com'] },
    { name: 'Farmers Insurance', aliases: ['farmers'], domains: ['farmers.com'] },
    { name: 'U.S. Bank', aliases: ['us bank', 'u s bank', 'usbank'], domains: ['usbank.com'] },
    { name: 'PNC', aliases: ['pnc', 'pnc bank'], domains: ['pnc.com'] },
    { name: 'Charles Schwab', aliases: ['schwab', 'charles schwab'], domains: ['schwab.com'] },
    { name: 'Fidelity', aliases: ['fidelity', 'fidelity investments'], domains: ['fidelity.com'] },
    { name: 'Vanguard', aliases: ['vanguard'], domains: ['vanguard.com'] },
    { name: 'Navy Federal', aliases: ['navy federal', 'navy federal credit union'], domains: ['navyfederal.org'] },
    { name: 'Synchrony', aliases: ['synchrony', 'synchrony bank'], domains: ['synchrony.com', 'mysynchrony.com', 'synchronybank.com'] },
    { name: 'Experian', aliases: ['experian'], domains: ['experian.com'] },
    { name: 'Equifax', aliases: ['equifax'], domains: ['equifax.com'] },
    { name: 'TransUnion', aliases: ['transunion'], domains: ['transunion.com'] },
    { name: 'Rocket Mortgage', aliases: ['rocket mortgage'], domains: ['rocketmortgage.com'] },
    { name: 'AT&T', aliases: ['at t', 'att'], domains: ['att.com', 'att.net', 'att-mail.com'] },
    { name: 'Verizon', aliases: ['verizon', 'verizon wireless'], domains: ['verizon.com', 'verizonwireless.com', 'verizon.net'] },
    { name: 'T-Mobile', aliases: ['t mobile', 'tmobile'], domains: ['t-mobile.com'] },
    { name: 'Xfinity', aliases: ['xfinity', 'comcast', 'comcast xfinity'], domains: ['xfinity.com', 'comcast.com', 'comcast.net'] },
    { name: 'Social Security', aliases: ['social security', 'social security administration', 'ssa'], domains: ['ssa.gov'] },
    { name: 'Medicare', aliases: ['medicare'], domains: ['medicare.gov', 'cms.gov'] },
    { name: 'Walmart', aliases: ['walmart'], domains: ['walmart.com'] },
    { name: 'eBay', aliases: ['ebay'], domains: ['ebay.com'] },
    { name: 'Costco', aliases: ['costco'], domains: ['costco.com'] },
    { name: 'The Home Depot', aliases: ['home depot'], domains: ['homedepot.com'] },
    { name: 'Cash App', aliases: ['cash app', 'cashapp'], domains: ['cash.app', 'squareup.com'] },
    { name: 'TurboTax', aliases: ['turbotax', 'intuit', 'intuit turbotax', 'quickbooks'], domains: ['turbotax.com', 'intuit.com'] },
    { name: 'Spotify', aliases: ['spotify'], domains: ['spotify.com'] }
];
// Words that don't change whose name it is: "PayPal Support" is PayPal.
const GENERIC = new Set(['support', 'team', 'service', 'services', 'security', 'alert', 'alerts', 'billing', 'account', 'accounts', 'customer',
    'care', 'notification', 'notifications', 'no', 'reply', 'noreply', 'inc', 'com', 'online', 'help', 'desk', 'center', 'centre', 'department',
    'dept', 'official', 'verification', 'verify', 'update', 'updates', 'info', 'mail', 'the', 'your', 'order', 'orders', 'payments', 'payment', 'fraud', 'prevention',
    'insurance']);
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
// The domain a company registers: mail.bank.example → bank.example, and
// alerts.amazon.co.uk → amazon.co.uk.
export function registrable(domain) {
    const labels = domain.toLowerCase().replace(/\.$/, '').split('.');
    if (labels.length > 2 && labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2)))
        return labels.slice(-3).join('.');
    return labels.slice(-2).join('.');
}
const domainOf = (address) => address.split('@').pop().toLowerCase();
const officialFor = (brand, domain) => brand.domains.includes(registrable(domain));
function claimedBrand(name) {
    if (!name)
        return undefined;
    const all = name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
    // As written, or without its generic words: a company whose own name has
    // one of them ("Social Security") is still named whole (SCM-07).
    const whole = all.join(' ');
    const words = all.filter(w => !GENERIC.has(w)).join(' ');
    return BRANDS.find(b => b.aliases.includes(whole) || (words !== '' && b.aliases.includes(words)));
}
// Letters that pass for others at a glance: rn/m, 0/o, 1/l, vv/w.
const unglyph = (label) => label.replace(/rn/g, 'm').replace(/0/g, 'o').replace(/1/g, 'l').replace(/vv/g, 'w');
function oneEditApart(a, b) {
    if (a === b || Math.abs(a.length - b.length) > 1)
        return false;
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            i++;
            j++;
            continue;
        }
        if (++edits > 1)
            return false;
        if (a.length > b.length)
            i++;
        else if (b.length > a.length)
            j++;
        else {
            i++;
            j++;
        }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
}
// A domain made to look like a company's, and the one it imitates.
function imitated(domain) {
    const own = registrable(domain);
    const label = own.split('.')[0];
    for (const brand of BRANDS) {
        for (const official of brand.domains) {
            if (own === official)
                return undefined;
            const target = official.split('.')[0];
            // One letter off only for longer names: a five-letter name has too many
            // honest neighbours (ample, apply, chaise).
            if ((unglyph(label) === target && label !== target) || (target.length >= 6 && oneEditApart(label, target)))
                return official;
        }
    }
    return undefined;
}
// An address written into a display name ("service@paypal.com" <x@evil>).
// Word by word, each checked by an anchored pattern with one @: linear in the
// name's length, whatever a sender puts there (SCM-06: an unanchored pattern
// took 60 s on 5,000 @s, on the main thread).
const ADDRESS = /^[^@]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}$/i;
function addressIn(name) {
    if (!name)
        return undefined;
    for (const word of name.split(/[\s<>"'()[\],;]+/)) {
        if (word.length <= 320 && ADDRESS.test(word))
            return word;
    }
    return undefined;
}
export function cautionsFor(message) {
    const sender = message.from?.[0];
    if (!sender?.address)
        return [];
    const cautions = [];
    const domain = domainOf(sender.address);
    const shown = addressIn(sender.name);
    if (shown && shown.toLowerCase() !== sender.address.toLowerCase()) {
        cautions.push(`The sender's name shows ${shown}, but the mail comes from ${sender.address}.`);
    }
    else {
        const brand = claimedBrand(sender.name);
        if (brand && !officialFor(brand, domain))
            cautions.push(`The sender's name says ${brand.name}, but the address is at ${domain}, which isn't ${brand.name}'s.`);
    }
    if (domain.split('.').some(label => label.startsWith('xn--'))) {
        cautions.push(`The sender's domain ${domain} uses unusual characters that can disguise a look-alike address.`);
    }
    else {
        const official = imitated(domain);
        if (official)
            cautions.push(`The sender's domain ${registrable(domain)} looks like ${official} but isn't it.`);
    }
    const replyTo = message.replyTo?.find(r => r.address && registrable(domainOf(r.address)) !== registrable(domain) && !throughMailingService(domain, r.address));
    if (replyTo)
        cautions.push(`Replies would go to ${replyTo.address}, not to the sender's own domain (${registrable(domain)}).`);
    return cautions;
}
// Newsletters go out through mailing services, with replies to the business's
// own domain: ordinary mail (SCM-08, found live: 5 of 8 cautions were this).
// Replies to a personal mailbox are still worth a word.
const MAILING_SERVICES = new Set([
    'ccsend.com', 'constantcontact.com', 'mcsv.net', 'mcdlv.net', 'rsgsv.net', 'list-manage.com', 'mailchimpapp.net', 'mandrillapp.com',
    'sendgrid.net', 'amazonses.com', 'mailgun.org', 'mailgun.net', 'sparkpostmail.com', 'shopifyemail.com', 'klaviyomail.com',
    'hubspotemail.net', 'circle.so', 'substack.com', 'beehiiv.com', 'mlsend.com', 'sendinblue.com', 'brevosend.com',
    'convertkit-mail.com', 'convertkit-mail2.com', 'createsend.com', 'cmail19.com', 'cmail20.com', 'aweber.com', 'e2ma.net', 'emailoctopus.com'
]);
const PERSONAL_MAIL = new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'aol.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
    'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com'
]);
function throughMailingService(senderDomain, replyAddress) {
    return MAILING_SERVICES.has(registrable(senderDomain)) && !PERSONAL_MAIL.has(registrable(domainOf(replyAddress)));
}
//# sourceMappingURL=cautions.js.map