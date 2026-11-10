/**
 * Ollama memory recycle (2026-11-09): unload an idle model whose llama-server has grown well
 * past the model's size; never while a call is running; at most every 30 min.
 */
process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
jest.mock('http', () => ({ request: jest.fn() }));
const { EventEmitter } = require('events');
let http;

function okResponse() {
    http.request.mockImplementation((opts, cb) => {
        const req = new EventEmitter();
        req.write = jest.fn(); req.destroy = jest.fn();
        req.end = () => { const res = new EventEmitter(); cb(res); res.emit('data', Buffer.from('{"done":true}')); res.emit('end'); };
        return req;
    });
}

const SEVEN_B = [{ name: 'qwen2.5:7b-instruct-q4_K_M', gb: 5.1 }];
let ollama;
beforeEach(() => {
    jest.resetModules();
    http = require('http');    // fresh mock instance — the one ollamaService will load
    okResponse();
    ollama = require('../src/services/ollamaService');
});

test('normal size (model + < 4 GB) → leave it loaded', async () => {
    expect(await ollama.recycleIfBloated(7000, SEVEN_B)).toBe(false);
    expect(http.request).not.toHaveBeenCalled();
});

test("11-09's 11.8 GB server for a 5.1 GB model → unload it (keep_alive 0)", async () => {
    expect(await ollama.recycleIfBloated(11783, SEVEN_B)).toBe(true);
    expect(http.request).toHaveBeenCalledTimes(1);
    const req = http.request.mock.results[0].value;
    const body = JSON.parse(req.write.mock.calls[0][0]);
    expect(body).toMatchObject({ model: 'qwen2.5:7b-instruct-q4_K_M', keep_alive: 0 });
});

test('at most once per 30 min', async () => {
    const t = Date.now();
    expect(await ollama.recycleIfBloated(11783, SEVEN_B, t)).toBe(true);
    expect(await ollama.recycleIfBloated(11783, SEVEN_B, t + 10 * 60000)).toBe(false);
    expect(await ollama.recycleIfBloated(11783, SEVEN_B, t + 31 * 60000)).toBe(true);
});

test('nothing loaded → nothing to do', async () => {
    expect(await ollama.recycleIfBloated(11783, [])).toBe(false);
});
