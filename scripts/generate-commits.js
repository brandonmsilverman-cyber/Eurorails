const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const outFile = path.join(__dirname, '..', 'data', 'commits.json');

try {
    const stdout = execFileSync('git', ['log', '--format=%s||%ai', '-10'], { cwd: path.join(__dirname, '..') }).toString();
    const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [message, rawDate] = line.split('||');
        const d = new Date(rawDate);
        const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return { message, date };
    });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(commits, null, 2));
    console.log(`Generated ${outFile} with ${commits.length} commits`);
} catch (e) {
    console.error('Failed to generate commits.json:', e.message);
}
