/**
 * Snapshot Helper — Loads game logic for Node.js tests.
 *
 * After Step 0.2, the client HTML loads shared/game-logic.js via a <script>
 * tag and defines thin wrappers that bridge the ctx-based API to gameState.
 * This helper reproduces that setup:
 *   1. Loads the shared module (require)
 *   2. Extracts gameState definition + wrappers from public/eurorails.html
 *   3. Evaluates them in a Node.js vm context with shared module exports as globals
 *   4. Returns the populated context for tests to use
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadGameLogic() {
    // Load the shared module
    const gl = require('../shared/game-logic');

    // Read the HTML to extract gameState definition + wrapper code
    const htmlPath = path.join(__dirname, '..', 'public', 'eurorails.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const lines = html.split('\n');

    // Find the gameState + wrappers section by looking for markers
    let startLine = -1;
    let endLine = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('// GAME STATE') && lines[i].startsWith('//')) {
            // Start from 2 lines before (the === header line)
            startLine = Math.max(0, i - 1);
        }
        if (startLine >= 0 && lines[i].includes('// GAME LOGIC') && lines[i].startsWith('//')) {
            // End just before the GAME LOGIC header
            endLine = i - 2; // skip the === line before GAME LOGIC
            break;
        }
    }

    if (startLine < 0 || endLine < 0) {
        throw new Error('Could not find gameState + wrappers section in HTML');
    }

    let code = lines.slice(startLine, endLine).join('\n');

    // In vm contexts, const/let/class declarations don't become properties of
    // the sandbox object. Convert top-level const/let to var and class to
    // var ... = class so they're accessible after execution.
    code = code.replace(/^const /gm, 'var ');
    code = code.replace(/^let /gm, 'var ');
    code = code.replace(/^class (\w+)/gm, 'var $1 = class $1');

    // Create the vm context with shared module exports + JS globals
    const contextGlobals = {
        Math,
        Set,
        Array,
        Object,
        Map,
        Infinity,
        parseInt,
        parseFloat,
        Number,
        String,
        Boolean,
        RegExp,
        Error,
        TypeError,
        RangeError,
        isNaN,
        isFinite,
        undefined,
        console,
    };

    // Inject all shared module exports as globals (simulates the <script> tag)
    for (const [key, value] of Object.entries(gl)) {
        contextGlobals[key] = value;
    }

    const context = vm.createContext(contextGlobals);

    // Execute the gameState + wrapper code in the sandboxed context
    vm.runInContext(code, context, { filename: 'eurorails-wrappers.js' });

    return context;
}

module.exports = { loadGameLogic };
