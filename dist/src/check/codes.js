// The check codes (design §7.3): each with a plain-English cause and fix, the
// same words wherever the code appears. {provider} is the only value a cause
// holds, and only a known provider's name fills it.
export const CHECK_CODES = {
    'CHECK-UNEXPECTED': {
        cause: 'Something unexpected went wrong during this check.',
        fix: 'Run Check again. If it fails again, share this report.'
    },
    'SERVER-VERSION-MISMATCH': {
        cause: 'The running server isn\'t the version setup installed.',
        fix: 'In Cloud Shell, type  node setup.js  and choose Update.'
    },
    'SIGNIN-TEST-FAILED': {
        cause: 'The server couldn\'t issue and verify a test sign-in.',
        fix: 'In Cloud Shell, type  node setup.js  and choose Check and fix.'
    },
    'MAIL-APP-PASSWORD-REJECTED': {
        cause: '{provider} no longer accepts the app password.',
        fix: 'Make a new app password, then use Fix it on your Universal Mail page.'
    },
    'MAIL-UNREACHABLE': {
        cause: '{provider}\'s mail servers couldn\'t be reached.',
        fix: 'This is usually brief. Run Check again in a few minutes.'
    },
    'MAIL-INSECURE': {
        cause: '{provider}\'s mail servers didn\'t offer a secure connection, so no password was sent.',
        fix: 'Run Check again. If it keeps happening, share this report.'
    },
    'MAIL-TOOL-FAILED': {
        cause: 'A mail tool didn\'t work as expected with {provider}.',
        fix: 'Run Check again. If it fails again, share this report.'
    },
    'MAIL-WRITE-FAILED': {
        cause: '{provider} didn\'t let Universal Mail change a test message.',
        fix: 'Run Check again. If it fails again, share this report.'
    },
    'SENT-MODE-UNKNOWN': {
        cause: 'It isn\'t known yet where {provider} keeps the mail you send.',
        fix: 'In Cloud Shell, type  node setup.js  and choose Check and fix.'
    }
};
//# sourceMappingURL=codes.js.map