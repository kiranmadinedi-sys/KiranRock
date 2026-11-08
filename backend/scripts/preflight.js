#!/usr/bin/env node
/**
 * Pre-restart check (2026-11-08) — start.ps1 runs this BEFORE stopping the running app.
 * If any source file has a syntax error or a relative require() that points at a missing
 * file, it exits 1 and start.ps1 aborts, leaving the old (working) processes running.
 *
 * Why: on 2026-11-07 a broken line in worker.js passed all 603 tests (jest never loads the
 * entry points) and the worker crash-looped on restart until PM2 gave up.
 *
 * Compiles only — never executes app code, connects to the DB or starts timers. ~1-2 s.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..', 'src');
const SKIP = /\.backup\.js$|\.bak\.js$|[\\/]node_modules[\\/]/;

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
        else if (e.name.endsWith('.js') && !SKIP.test(p)) out.push(p);
    }
    return out;
}

/** Problems in one file's source: [] when it compiles and every relative require resolves. */
function checkSource(file, src) {
    const problems = [];
    const body = src.replace(/^#!.*/, '');
    try {
        new vm.Script(Module.wrap(body), { filename: file });
    } catch (err) {
        const where = (err.stack || '').split('\n')[0];
        return [`syntax: ${where.includes(file) ? where : file} — ${err.message}`];
    }
    // Usage examples in comments ("node -e require('./src/...')") are not real requires.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
    const re = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
    for (let m; (m = re.exec(code));) {
        try { require.resolve(path.resolve(path.dirname(file), m[1])); }
        catch { problems.push(`missing: ${file} requires '${m[1]}'`); }
    }
    return problems;
}

function run(root = ROOT) {
    const files = walk(root);
    const problems = files.flatMap(f => checkSource(f, fs.readFileSync(f, 'utf8')));
    return { files: files.length, problems };
}

if (require.main === module) {
    const t = Date.now();
    const { files, problems } = run();
    if (problems.length) {
        console.error(`PREFLIGHT FAILED — ${problems.length} problem(s) in ${files} files:`);
        for (const p of problems) console.error('  ' + p);
        process.exit(1);
    }
    console.log(`Preflight OK — ${files} files compile, all relative requires resolve (${Date.now() - t} ms)`);
}

module.exports = { checkSource, run };
