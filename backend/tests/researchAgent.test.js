/** Research agent: the model's ideas are validated and de-duplicated before the lab sees them (2026-11-07). */
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const agent = require('../src/services/researchAgentService');

const memory = [{ name: 'burst4_5d', spec: { when: [['ret1', '>=', 4], ['volRatio', '>=', 1]], hold: 5 } }];
const idea = (name, spec, extra = {}) => ({ name, family: 'event', idea: 'why', spec, ...extra });

test('accepts valid new ideas', () => {
    const reply = JSON.stringify([idea('upgrade_uptrend_5d', { when: [['sma200Dist', '>', 0]], event: 'analyst_upgrade', hold: 5 })]);
    const { accepted, rejected } = agent.acceptIdeas(reply, memory);
    expect(accepted.map(a => a.name)).toEqual(['upgrade_uptrend_5d']);
    expect(accepted[0].spec.event).toEqual(['analyst_upgrade']);
    expect(rejected).toEqual([]);
});

test('rejects repeats, bad specs and bad names', () => {
    const reply = JSON.stringify([
        idea('burst4_5d', { when: [['ret1', '>', 1]] }),                              // name already tested
        idea('burst_again_5d', { when: [['ret1', '>=', 4], ['volRatio', '>=', 1]] }), // same spec (defaults filled)
        idea('magic_5d', { when: [['magic', '>', 1]] }),                               // unknown feature
        idea('Bad Name', { when: [['ret1', '>', 1]] }),
        idea('dup_5d', { when: [['ret5', '<', -3]] }), idea('dup_5d', { when: [['ret5', '<', -4]] }), // same name twice
    ]);
    const { accepted, rejected } = agent.acceptIdeas(reply, memory);
    expect(accepted.map(a => a.name)).toEqual(['dup_5d']);
    expect(rejected.map(r => r.why)).toEqual(['name already tested', 'same spec already tested', 'unknown feature magic', 'bad name', 'name already tested']);
});

test('caps the number of ideas and survives a non-JSON reply', () => {
    const many = Array.from({ length: 10 }, (_, i) => idea(`idea_${i}_5d`, { when: [['ret5', '<', -i - 1]] }));
    expect(agent.acceptIdeas(JSON.stringify(many), []).accepted).toHaveLength(agent.MAX_IDEAS);
    expect(agent.acceptIdeas('sorry, no', []).accepted).toEqual([]);
});

test('the prompt carries the memory and the fixed pass rule', () => {
    const p = agent.buildPrompt(memory, { closedTrades: [] });
    expect(p).toContain('burst4_5d');
    expect(p).toContain('t ≥ 2.5');
    expect(p).toContain('analyst_upgrade');
});
