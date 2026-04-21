/**
 * Strip all ANSI escape sequences: colors, cursor movement, screen clear,
 * OSC sequences, charset selection. Also drops bare carriage returns so
 * progress-bar-style output doesn't render as empty.
 */
function stripAnsi(string) {
    return String(string)
        .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/\u001b\][^\u0007]*\u0007/g, '')   // OSC sequences
        .replace(/\u001b[()][A-Z0-9]/g, '')          // charset selection
        .replace(/\r/g, '');                          // carriage returns
}

module.exports = { stripAnsi };
